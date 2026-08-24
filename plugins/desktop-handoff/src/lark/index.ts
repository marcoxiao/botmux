import { dirname, join } from 'node:path';
import {
  buildCompletionCard,
  buildMessageResultCard,
  buildOpenAppResultCard,
  buildTakeoverResultCard,
} from '../card.js';
import { readDesktopContext } from '../desktop-context.js';
import { probeDesktopThread, sendDesktopTurn } from '../desktop-ipc.js';
import { completionFromDesktopTurn, completionFromHook, isInternalPrompt } from '../event.js';
import { openTraexApp } from '../open-app.js';
import { resolveBotConfig } from '../provider.js';
import { DesktopHandoffStore } from '../store.js';
import type {
  BotConfig,
  CompletionEvent,
  DesktopIdentity,
  LarkCardAction,
  LarkPluginHost,
  LarkPluginMessageContext,
} from '../types.js';

interface LocalContext { larkAppId: string; managedSession: boolean }

const hookSerial = new Map<string, Promise<void>>();
const activeDesktopTurns = new Set<string>();

function identityKey(identity: DesktopIdentity): string {
  return JSON.stringify([identity.larkAppId, identity.provider, identity.threadId]);
}

function serializeHook<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = hookSerial.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  hookSerial.set(key, tail);
  void tail.finally(() => {
    if (hookSerial.get(key) === tail) hookSerial.delete(key);
  });
  return result;
}

function value(raw: unknown, key: string): unknown {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)[key]
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function botFor(host: LarkPluginHost, larkAppId: string): BotConfig | undefined {
  return resolveBotConfig({ bots: host.config.get('bots') }, larkAppId);
}

function storeFor(host: LarkPluginHost): DesktopHandoffStore {
  const configured = nonEmpty(host.config.get('ledgerPath'));
  return new DesktopHandoffStore(configured ?? join(dirname(host.config.path), 'desktop-handoff-ledger.json'));
}

function messageUuid(kind: 'root' | 'reply' | 'result', id: string): string {
  const prefix = kind === 'root' ? 'dhr-' : kind === 'reply' ? 'dhp-' : 'dhm-';
  return `${prefix}${id.slice(0, 46)}`;
}

function isRootUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === 'lark_root_message_unavailable';
}

async function deliverCompletionEvent(
  event: CompletionEvent,
  bot: BotConfig,
  store: DesktopHandoffStore,
  host: LarkPluginHost,
): Promise<'delivered' | 'duplicate'> {
  if (event.larkAppId !== bot.larkAppId || event.provider !== bot.provider.id) {
    throw new Error('desktop_handoff_provider_mismatch');
  }
  const recorded = await store.recordEvent(event);
  if (recorded.duplicate) return 'duplicate';

  let route = await store.thread(event);
  if (route?.rootMessageId) {
    try {
      await host.replyCard({
        rootMessageId: route.rootMessageId,
        card: buildCompletionCard(event, false),
        uuid: messageUuid('reply', event.eventId),
      });
    } catch (error) {
      if (!isRootUnavailable(error)) throw error;
      await store.clearRoot(event, route.rootMessageId);
      route = await store.thread(event);
    }
  }
  if (!route?.rootMessageId) {
    const rootEvent = await store.reserveRoot(event, event.eventId);
    const sent = await host.sendCard({
      chatId: bot.workbenchChatId,
      card: buildCompletionCard(rootEvent, true),
      uuid: messageUuid('root', rootEvent.eventId),
      replyClaim: 'exclusive',
    });
    await store.markRoot(event, rootEvent.eventId, sent.messageId);
    await store.markDelivered(rootEvent.eventId, 'delivered');
    if (rootEvent.eventId !== event.eventId) {
      await host.replyCard({
        rootMessageId: sent.messageId,
        card: buildCompletionCard(event, false),
        uuid: messageUuid('reply', event.eventId),
      });
    }
  }
  await store.markDelivered(event.eventId, 'delivered');
  return 'delivered';
}

async function handleLocalEvent(raw: unknown, context: LocalContext, host: LarkPluginHost) {
  const threadId = nonEmpty(value(raw, 'session_id'));
  const serialKey = `${context.larkAppId}\u0000${threadId ?? '__invalid__'}`;
  return serializeHook(serialKey, async () => {
    if (context.managedSession) return { status: 'ignored', reason: 'managed_session' };
    const bot = botFor(host, context.larkAppId);
    if (!bot) return { status: 'ignored', reason: 'wrong_bot' };
    const hookName = value(raw, 'hook_event_name');
    if (hookName !== 'UserPromptSubmit' && hookName !== 'Stop') {
      return { status: 'ignored', reason: 'unsupported_hook' };
    }
    const turnId = nonEmpty(value(raw, 'turn_id'));
    if (!threadId || !turnId) return { status: 'ignored', reason: 'invalid_identity' };
    const agentId = nonEmpty(value(raw, 'agent_id'));
    if (agentId && agentId !== threadId) return { status: 'ignored', reason: 'subagent' };
    const desktop = await readDesktopContext(value(raw, 'transcript_path'), threadId, bot.provider);
    if (!desktop.desktop) return { status: 'ignored', reason: 'not_desktop' };
    const identity: DesktopIdentity = {
      larkAppId: bot.larkAppId,
      provider: bot.provider.id,
      threadId,
    };
    const store = storeFor(host);

    if (hookName === 'UserPromptSubmit') {
      const prompt = desktop.normalizePrompt(value(raw, 'prompt'));
      if (!prompt || isInternalPrompt(prompt)) return { status: 'ignored', reason: 'internal_prompt' };
      await store.confirmTurn(identity, turnId, prompt);
      return { status: 'accepted' };
    }

    const confirmedPrompt = await store.confirmedTurn(identity, turnId);
    if (!confirmedPrompt) return { status: 'ignored', reason: 'unconfirmed_turn' };
    const event = completionFromHook(identity, raw, confirmedPrompt, desktop.cwd);
    if (!event) return { status: 'ignored', reason: 'invalid_stop' };
    const delivery = await deliverCompletionEvent(event, bot, store, host);
    await store.consumeConfirmedTurn(identity, turnId);
    return { status: delivery === 'duplicate' ? 'duplicate' : 'accepted' };
  });
}

async function handleCardAction(data: LarkCardAction, context: { larkAppId: string }, host: LarkPluginHost) {
  const bot = botFor(host, context.larkAppId);
  if (!bot) return buildTakeoverResultCard('codex', 'forbidden');
  const owner = host.getOwnerOpenId();
  if (!owner || data.operator?.open_id !== owner) {
    return buildTakeoverResultCard(bot.provider.id, 'forbidden');
  }
  const eventId = nonEmpty(data.action?.value?.event_id);
  const resolution = eventId
    ? await storeFor(host).resolveTakeover(context.larkAppId, eventId)
    : undefined;
  if (!resolution || resolution.route.provider !== bot.provider.id) {
    return buildTakeoverResultCard(bot.provider.id, 'missing');
  }
  const { event, route } = resolution;
  const cardMessageId = nonEmpty(data.context?.open_message_id) ?? nonEmpty(data.open_message_id);
  if (!cardMessageId || cardMessageId !== route.rootMessageId) {
    return buildTakeoverResultCard(bot.provider.id, 'missing');
  }
  const action = data.action?.value?.action;
  if (action === 'desktop-handoff.open-app') {
    const result = bot.provider.id === 'codex'
      ? await host.openCodexApp(event.threadId).catch(() => ({ ok: false }))
      : await openTraexApp();
    return buildOpenAppResultCard(event, result.ok);
  }
  if (action !== 'desktop-handoff.takeover') return buildTakeoverResultCard(bot.provider.id, 'missing');
  try {
    if (!await probeDesktopThread(event.threadId, { socketPath: bot.provider.socketPath() })) {
      return buildTakeoverResultCard(bot.provider.id, 'offline', event.eventId);
    }
    await storeFor(host).markAdopted(route, cardMessageId);
    return buildTakeoverResultCard(bot.provider.id, 'success');
  } catch {
    return buildTakeoverResultCard(bot.provider.id, 'offline', event.eventId);
  }
}

async function replyMessageState(
  context: LarkPluginMessageContext,
  host: LarkPluginHost,
  provider: BotConfig['provider']['id'],
  state: Parameters<typeof buildMessageResultCard>[1],
  suffix = '',
): Promise<void> {
  await host.replyCard({
    rootMessageId: context.rootMessageId,
    card: buildMessageResultCard(provider, state),
    uuid: messageUuid('result', `${context.messageId}${suffix}`),
  });
}

async function handleMessage(context: LarkPluginMessageContext, host: LarkPluginHost) {
  const bot = botFor(host, context.larkAppId);
  if (!bot) return { handled: false };
  const store = storeFor(host);
  const route = await store.routeByRoot(context.larkAppId, context.rootMessageId);
  if (!route) return { handled: false };
  if (route.provider !== bot.provider.id) return { handled: true };

  const owner = host.getOwnerOpenId();
  if (!owner || context.senderOpenId !== owner) return { handled: true };
  const text = context.text.trim();
  if (!route.adoptedAt) {
    await replyMessageState(context, host, bot.provider.id, 'not-adopted');
    return { handled: true };
  }
  if (!text) {
    await replyMessageState(context, host, bot.provider.id, 'unsupported');
    return { handled: true };
  }

  const turnKey = identityKey(route);
  if (activeDesktopTurns.has(turnKey)) {
    await replyMessageState(context, host, bot.provider.id, 'busy');
    return { handled: true };
  }
  activeDesktopTurns.add(turnKey);
  try {
    const handle = await sendDesktopTurn({
      threadId: route.threadId,
      text,
      clientUserMessageId: context.messageId,
    }, { socketPath: bot.provider.socketPath() });
    void handle.completion.then(completion => serializeHook(turnKey, async () => {
      const event = completionFromDesktopTurn(route, text, completion);
      await deliverCompletionEvent(event, bot, store, host);
    })).catch(async () => {
      await replyMessageState(context, host, bot.provider.id, 'result-unavailable', '-result')
        .catch(() => undefined);
    }).finally(() => {
      activeDesktopTurns.delete(turnKey);
    });
  } catch (error) {
    activeDesktopTurns.delete(turnKey);
    const state = error instanceof Error && error.message === 'desktop_turn_delivery_unknown'
      ? 'delivery-unknown'
      : error instanceof Error && error.message === 'desktop_thread_busy'
        ? 'busy'
        : 'offline';
    await replyMessageState(context, host, bot.provider.id, state);
  }
  return { handled: true };
}

export default {
  schemaVersion: 1 as const,
  actions: ['desktop-handoff.takeover', 'desktop-handoff.open-app'],
  handleLocalEvent,
  handleCardAction,
  handleMessage,
};

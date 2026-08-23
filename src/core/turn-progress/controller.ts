import type { DaemonSession } from '../types.js';
import type { WorkerToDaemon } from '../../types.js';
import * as sessionStore from '../../services/session-store.js';
import { localeForBot } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import { readSessionPluginManifest } from '../plugins/session-manifest.js';
import {
  loadTurnProgressPlugin,
  resolveTurnProgressPluginId,
  type LoadedTurnProgressPlugin,
} from '../plugins/runtime.js';
import { TurnProgressHost, type FinalCardDelivery } from './host.js';
import {
  canDeliverFinalInProgressCard,
  canStartTurnProgress,
  type TurnProgressEligibilityInput,
} from './eligibility.js';
import { normalizeTurnProgressFact, type TurnProgressPluginV1 } from './protocol.js';

export interface TurnProgressControllerDeps {
  reply(cardRefJson: string, turnId: string, uuid: string): Promise<string>;
  reactDone(primaryTurnId: string): Promise<void>;
  /** Optional non-worker lifecycle authority (for example a Desktop IPC
   * follower). Ordinary worker-backed turns keep the strict generation check. */
  isGenerationActive?(workerGeneration: number): boolean;
}

type EnsureHostResult =
  | { kind: 'ready'; host: TurnProgressHost }
  | { kind: 'fallback' }
  | { kind: 'ignored' };

const pluginLoads = new WeakMap<DaemonSession, {
  generation: number;
  pluginId: string;
  promise: Promise<LoadedTurnProgressPlugin>;
}>();
const pluginSelections = new WeakMap<DaemonSession, {
  generation: number;
  pluginId?: string;
  error?: unknown;
}>();
const hostStarts = new WeakMap<DaemonSession, {
  generation: number;
  turnId: string;
  dispatchAttempt?: number;
  promise: Promise<TurnProgressHost | null>;
}>();
const diagnostics = new WeakMap<DaemonSession, Set<string>>();
const finalAckRetries = new WeakMap<DaemonSession, {
  turnId: string;
  timer: ReturnType<typeof setTimeout>;
}>();

const finalOnlyPlugin: TurnProgressPluginV1 = {
  schemaVersion: 1,
  initialState() { throw new Error('turn_progress_projection_unavailable'); },
  reduce(state) { return state; },
  render() { return { schema: '2.0' }; },
};

function diagnoseOnce(ds: DaemonSession, key: string, error: unknown): void {
  let seen = diagnostics.get(ds);
  if (!seen) {
    seen = new Set();
    diagnostics.set(ds, seen);
  }
  if (seen.has(key)) return;
  seen.add(key);
  logger.error(`[turn-progress] ${key} session=${ds.session.sessionId}: ${String(error)}`);
}

function selectedPluginId(ds: DaemonSession): string | undefined {
  const generation = ds.workerGeneration ?? ds.session.workerGeneration ?? 0;
  const cached = pluginSelections.get(ds);
  if (cached?.generation === generation) {
    if (cached.error) throw cached.error;
    return cached.pluginId;
  }
  const manifest = readSessionPluginManifest(ds.session.sessionId);
  if (!manifest) return undefined;
  try {
    const pluginId = resolveTurnProgressPluginId(manifest.pluginIds);
    pluginSelections.set(ds, { generation, pluginId });
    return pluginId;
  } catch (error) {
    pluginSelections.set(ds, { generation, error });
    throw error;
  }
}

function effectiveEligibility(
  ds: DaemonSession,
  input: TurnProgressEligibilityInput,
): TurnProgressEligibilityInput {
  try {
    return { ...input, pluginId: selectedPluginId(ds) };
  } catch (error) {
    diagnoseOnce(ds, 'plugin_resolution_failed', error);
    return { ...input, pluginId: undefined };
  }
}

function fallbackTurns(ds: DaemonSession): Set<string> {
  return ds.turnProgressLegacyFallbackTurns ??= new Set<string>();
}

function markFallback(ds: DaemonSession, turnId: string): void {
  const turns = fallbackTurns(ds);
  if (turns.size >= 64) turns.delete(turns.values().next().value!);
  turns.add(turnId);
}

function bindingOwns(ds: DaemonSession, turnId: string | undefined): boolean {
  const binding = ds.session.turnProgressBinding;
  return !!binding && (turnId === undefined || binding.memberTurnIds.includes(turnId));
}

export function semanticProgressSuppressesLegacyCard(
  ds: DaemonSession,
  turnId: string | undefined,
  eligibility: TurnProgressEligibilityInput,
): boolean {
  if (turnId && ds.turnProgressLegacyFallbackTurns?.has(turnId)) return false;
  const binding = ds.session.turnProgressBinding;
  if (binding) {
    return canStartTurnProgress({ ...eligibility, pluginId: binding.pluginId })
      && bindingOwns(ds, turnId);
  }
  const effective = effectiveEligibility(ds, eligibility);
  if (!canStartTurnProgress(effective)) return false;
  if (ds.turnProgressHost) return turnId === undefined || ds.turnProgressHost.owns(turnId);
  const starting = hostStarts.get(ds);
  return !starting || turnId === undefined || starting.turnId === turnId;
}

async function loadOnce(
  ds: DaemonSession,
  generation: number,
  pluginId: string,
): Promise<LoadedTurnProgressPlugin> {
  const cached = pluginLoads.get(ds);
  if (cached?.generation === generation && cached.pluginId === pluginId) return cached.promise;
  const manifest = readSessionPluginManifest(ds.session.sessionId);
  const promise = loadTurnProgressPlugin(manifest?.pluginIds ?? []).then(loaded => {
    if (!loaded || loaded.pluginId !== pluginId) throw new Error(`turn_progress_plugin_not_loaded:${pluginId}`);
    return loaded;
  });
  pluginLoads.set(ds, { generation, pluginId, promise });
  return promise;
}

function persistBinding(ds: DaemonSession, binding: typeof ds.session.turnProgressBinding): void {
  const previous = ds.session.turnProgressBinding;
  if (binding) ds.session.turnProgressBinding = structuredClone(binding);
  else delete ds.session.turnProgressBinding;
  try {
    sessionStore.updateSession(ds.session);
  } catch (error) {
    if (previous) ds.session.turnProgressBinding = previous;
    else delete ds.session.turnProgressBinding;
    throw error;
  }
}

function ownsGeneration(
  ds: DaemonSession,
  workerGeneration: number,
  deps?: TurnProgressControllerDeps,
): boolean {
  if (deps?.isGenerationActive) {
    return ds.session.status === 'active' && deps.isGenerationActive(workerGeneration);
  }
  return ds.session.status === 'active'
    && ds.workerGeneration === workerGeneration
    && ds.session.workerGeneration === workerGeneration;
}

function hostDeps(
  ds: DaemonSession,
  workerGeneration: number,
  deps: TurnProgressControllerDeps,
) {
  return {
    active: () => ownsGeneration(ds, workerGeneration, deps),
    create: async (cardJson: string) => {
      const { createCardEntity } = await import('../../im/lark/client.js');
      return createCardEntity(ds.larkAppId, cardJson);
    },
    reply: deps.reply,
    update: async (cardId: string, cardJson: string, sequence: number, uuid: string) => {
      const { updateCardEntity } = await import('../../im/lark/client.js');
      return updateCardEntity(ds.larkAppId, cardId, cardJson, sequence, uuid);
    },
    reactDone: deps.reactDone,
    persist: (binding: typeof ds.session.turnProgressBinding) => persistBinding(ds, binding),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  };
}

function contextFor(
  ds: DaemonSession,
  turnId: string,
  dispatchAttempt: number | undefined,
  workerGeneration: number,
  restored: boolean,
) {
  return {
    schemaVersion: 1 as const,
    sessionId: ds.session.sessionId,
    primaryTurnId: turnId,
    turnId,
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
    workerGeneration,
    cliId: ds.session.cliId ?? ds.initConfig?.cliId ?? 'unknown',
    locale: localeForBot(ds.larkAppId),
    restored,
  };
}

async function ensureHost(
  ds: DaemonSession,
  turnId: string,
  dispatchAttempt: number | undefined,
  workerGeneration: number,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<EnsureHostResult> {
  if (!ownsGeneration(ds, workerGeneration, deps)) return { kind: 'ignored' };
  if (ds.turnProgressLegacyFallbackTurns?.has(turnId)) return { kind: 'fallback' };

  let binding = ds.session.turnProgressBinding;
  const effective = binding
    ? { ...eligibility, pluginId: binding.pluginId }
    : effectiveEligibility(ds, eligibility);
  if (!canStartTurnProgress(effective) || !effective.pluginId) return { kind: 'ignored' };

  if (ds.turnProgressHost) {
    return ds.turnProgressHost.owns(turnId, dispatchAttempt)
      ? { kind: 'ready', host: ds.turnProgressHost }
      : { kind: 'ignored' };
  }

  if (binding) {
    if (binding.pluginId !== effective.pluginId
      || !binding.memberTurnIds.includes(turnId)
      || binding.primaryDispatchAttempt !== undefined
        && dispatchAttempt !== undefined
        && binding.primaryDispatchAttempt !== dispatchAttempt) return { kind: 'ignored' };
    if (binding.workerGeneration !== workerGeneration) {
      const migrated = { ...binding, workerGeneration };
      try {
        persistBinding(ds, migrated);
        binding = migrated;
      } catch (error) {
        diagnoseOnce(ds, 'restored_binding_migration_failed', error);
        return { kind: 'ignored' };
      }
    }
    let plugin = finalOnlyPlugin;
    try {
      plugin = (await loadOnce(ds, workerGeneration, binding.pluginId)).plugin;
    } catch (error) {
      if (ownsGeneration(ds, workerGeneration, deps)) diagnoseOnce(ds, 'restored_plugin_load_failed', error);
    }
    if (!ownsGeneration(ds, workerGeneration, deps)) return { kind: 'ignored' };
    const host = TurnProgressHost.restore(
      plugin,
      contextFor(
        ds,
        binding.primaryTurnId,
        binding.primaryDispatchAttempt,
        binding.workerGeneration,
        true,
      ),
      binding,
      hostDeps(ds, binding.workerGeneration, deps),
    );
    ds.turnProgressHost = host;
    return { kind: 'ready', host };
  }

  let loaded: LoadedTurnProgressPlugin;
  try {
    loaded = await loadOnce(ds, workerGeneration, effective.pluginId);
  } catch (error) {
    if (!ownsGeneration(ds, workerGeneration, deps)) return { kind: 'ignored' };
    diagnoseOnce(ds, 'plugin_load_failed', error);
    markFallback(ds, turnId);
    return { kind: 'fallback' };
  }
  if (!ownsGeneration(ds, workerGeneration, deps)) return { kind: 'ignored' };
  const currentStart = hostStarts.get(ds);
  if (currentStart
    && (currentStart.generation !== workerGeneration
      || currentStart.turnId !== turnId
      || currentStart.dispatchAttempt !== undefined
        && dispatchAttempt !== undefined
        && currentStart.dispatchAttempt !== dispatchAttempt)) return { kind: 'ignored' };
  const start = currentStart ?? {
    generation: workerGeneration,
    turnId,
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
    promise: TurnProgressHost.start(
      loaded.pluginId,
      loaded.plugin,
      contextFor(ds, turnId, dispatchAttempt, workerGeneration, false),
      hostDeps(ds, workerGeneration, deps),
    ),
  };
  if (!currentStart) {
    hostStarts.set(ds, start);
    void start.promise.then(
      () => { if (hostStarts.get(ds) === start) hostStarts.delete(ds); },
      () => { if (hostStarts.get(ds) === start) hostStarts.delete(ds); },
    );
  }
  let host: TurnProgressHost | null;
  try {
    host = await start.promise;
  } catch (error) {
    diagnoseOnce(ds, 'host_start_failed', error);
    if (!ownsGeneration(ds, workerGeneration, deps) || ds.session.turnProgressBinding) return { kind: 'ignored' };
    markFallback(ds, turnId);
    return { kind: 'fallback' };
  }
  if (!ownsGeneration(ds, workerGeneration, deps)) {
    host?.dispose();
    return { kind: 'ignored' };
  }
  if (!host) {
    markFallback(ds, turnId);
    return { kind: 'fallback' };
  }
  ds.turnProgressHost = host;
  return { kind: 'ready', host };
}

export async function handleTurnProgressFact(
  ds: DaemonSession,
  message: Extract<WorkerToDaemon, { type: 'turn_progress' }>,
  workerGeneration: number,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<'handled' | 'fallback' | 'ignored'> {
  if (message.sessionId !== ds.session.sessionId) return 'ignored';
  const ensured = await ensureHost(
    ds,
    message.turnId,
    message.dispatchAttempt,
    workerGeneration,
    eligibility,
    deps,
  );
  if (ensured.kind !== 'ready') return ensured.kind;
  ensured.host.dispatchFact(message.fact);
  return 'handled';
}

export function handleTurnProgressSteer(ds: DaemonSession, turnId: string): void {
  try {
    if (ds.turnProgressHost) {
      ds.turnProgressHost.bindSteer(turnId);
      return;
    }
    const binding = ds.session.turnProgressBinding;
    if (!binding || binding.memberTurnIds.includes(turnId)) return;
    const aliases = binding.memberTurnIds.filter(id => id !== binding.primaryTurnId);
    persistBinding(ds, {
      ...binding,
      memberTurnIds: [binding.primaryTurnId, ...[...aliases, turnId].slice(-31)],
    });
  } catch (error) {
    diagnoseOnce(ds, 'steer_binding_failed', error);
  }
}

async function lifecycleHost(
  ds: DaemonSession,
  turnId: string | undefined,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<TurnProgressHost | undefined> {
  if (!turnId || ds.workerGeneration === undefined) return undefined;
  const ensured = await ensureHost(
    ds,
    turnId,
    undefined,
    ds.workerGeneration,
    eligibility,
    deps,
  );
  return ensured.kind === 'ready' ? ensured.host : undefined;
}

function cleanNarrative(ds: DaemonSession, text: string): string {
  return normalizeTurnProgressFact({
    schemaVersion: 1,
    seq: 0,
    atMs: 0,
    kind: 'narrative',
    text,
  }, ds.workingDir ?? process.cwd())?.text ?? '';
}

export async function handleTurnProgressWaiting(
  ds: DaemonSession,
  turnId: string | undefined,
  description: string,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<void> {
  const host = await lifecycleHost(ds, turnId, eligibility, deps);
  if (!host) return;
  host.dispatch({ kind: 'waiting', text: cleanNarrative(ds, description) }, true);
}

export async function handleTurnProgressResumed(
  ds: DaemonSession,
  turnId: string | undefined,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<void> {
  (await lifecycleHost(ds, turnId, eligibility, deps))?.dispatch({ kind: 'resumed' }, true);
}

export async function handleTurnProgressExternalReply(
  ds: DaemonSession,
  turnId: string,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<void> {
  (await lifecycleHost(ds, turnId, eligibility, deps))?.dispatch({ kind: 'external_reply' }, true);
}

export async function handleTurnProgressTerminal(
  ds: DaemonSession,
  terminal: Extract<WorkerToDaemon, { type: 'turn_terminal' }>,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<void> {
  const workerGeneration = ds.workerGeneration;
  // final_output is queued before terminal, but its existing delivery path
  // starts on a zero-delay timer. Join the next timers phase so that older
  // final timer can claim the host first; setImmediate would run before it
  // when both IPC messages land in the same poll phase.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (terminal.sessionId !== ds.session.sessionId || workerGeneration === undefined) return;
  // A terminal is a close edge, never a create edge. Codex App emits it only
  // after durable final ACK, at which point the binding is already gone.
  if (!ds.turnProgressHost && !bindingOwns(ds, terminal.turnId)) return;
  const ensured = await ensureHost(
    ds,
    terminal.turnId,
    terminal.dispatchAttempt,
    workerGeneration,
    eligibility,
    deps,
  );
  if (ensured.kind !== 'ready') return;
  if (terminal.status === 'completed' && terminal.outputDisposition !== 'nothing_to_send') {
    ensured.host.dispatch({ kind: 'finalizing' }, true);
    return;
  }
  const errorCode = terminal.errorCode && /^[A-Za-z0-9_.:-]{1,80}$/.test(terminal.errorCode)
    ? terminal.errorCode
    : undefined;
  try {
    const delivery = await ensured.host.settleTerminal({
      kind: 'terminal',
      status: terminal.status,
      ...(errorCode ? { errorCode } : {}),
    });
    if (delivery.kind === 'delivered') acknowledgeProgressFinal(ds, terminal.turnId);
  } catch (error) {
    diagnoseOnce(ds, 'terminal_settlement_failed', error);
  }
}

export async function deliverFinalThroughProgressCard(
  ds: DaemonSession,
  message: Extract<WorkerToDaemon, { type: 'final_output' }>,
  cardJson: string,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<FinalCardDelivery> {
  if (message.sessionId && message.sessionId !== ds.session.sessionId) {
    return { kind: 'not_applicable' };
  }
  const binding = ds.session.turnProgressBinding;
  if (!binding || !binding.memberTurnIds.includes(message.turnId)) {
    return { kind: 'not_applicable' };
  }
  if (binding.primaryDispatchAttempt !== undefined
    && message.dispatchAttempt !== undefined
    && binding.primaryDispatchAttempt !== message.dispatchAttempt) {
    return { kind: 'not_applicable' };
  }
  const effective = {
    ...eligibility,
    pluginId: binding.pluginId,
    suppressDelivery: message.suppressDelivery === true,
    steerSuperseded: message.disposition === 'steer_superseded',
  };
  const workerGeneration = deps.isGenerationActive
    ? binding.workerGeneration
    : ds.workerGeneration;
  if (!canDeliverFinalInProgressCard(effective) || workerGeneration === undefined) {
    return { kind: 'not_applicable' };
  }
  const ensured = await ensureHost(
    ds,
    message.turnId,
    message.dispatchAttempt,
    workerGeneration,
    effective,
    deps,
  );
  return ensured.kind === 'ready'
    ? ensured.host.deliverFinal(cardJson)
    : { kind: ensured.kind === 'fallback' ? 'fallback' : 'not_applicable' };
}

function attemptProgressFinalAck(ds: DaemonSession, turnId: string, attempt: number): void {
  const binding = ds.session.turnProgressBinding;
  if (binding?.deliveryState !== 'finalizing' || !binding.memberTurnIds.includes(turnId)) return;
  try {
    if (ds.turnProgressHost) ds.turnProgressHost.ackFinal(turnId);
    else persistBinding(ds, undefined);
    ds.turnProgressHost = undefined;
    const pending = finalAckRetries.get(ds);
    if (pending) clearTimeout(pending.timer);
    finalAckRetries.delete(ds);
  } catch (error) {
    diagnoseOnce(ds, 'final_ack_failed', error);
    if (ds.session.status !== 'active' || finalAckRetries.has(ds)) return;
    const nextAttempt = attempt + 1;
    const timer = setTimeout(() => {
      finalAckRetries.delete(ds);
      attemptProgressFinalAck(ds, turnId, nextAttempt);
    }, Math.min(250 * 2 ** attempt, 4_000));
    timer.unref?.();
    finalAckRetries.set(ds, { turnId, timer });
  }
}

export function acknowledgeProgressFinal(ds: DaemonSession, turnId: string): void {
  const pending = finalAckRetries.get(ds);
  if (pending?.turnId === turnId) return;
  attemptProgressFinalAck(ds, turnId, 0);
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chatId: 'oc_workbench',
  chatMode: 'topic' as 'topic' | 'group' | 'p2p' | 'unknown',
  routes: new Map<string, { threadId: string; chatId: string; rootMessageId: string; updatedAt: string }>(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  adoptionAnchors: [] as string[],
  probeCodexDesktopThread: vi.fn(async () => 'codex-desktop-owner'),
  existingEndpoint: undefined as string | undefined,
  sendMessage: vi.fn(async () => 'om_sent'),
  replyMessage: vi.fn(async () => 'om_reply'),
  updateMessage: vi.fn(async () => undefined),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient, WSClient: class { start() {} } };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    getMessageChatId: vi.fn(async () => mocks.chatId),
    getChatModeStrict: vi.fn(async () => mocks.chatMode),
    sendMessage: mocks.sendMessage,
    replyMessage: mocks.replyMessage,
    updateMessage: mocks.updateMessage,
  };
});

vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<any>('../src/bot-registry.js');
  return {
    ...actual,
    getOwnerOpenId: vi.fn(() => 'ou_owner'),
    getBot: vi.fn(() => ({
      config: {
        larkAppId: 'cli_app',
        cliId: 'codex-app',
        p2pMode: 'thread',
        cliPathOverride: undefined,
        ...(mocks.existingEndpoint
          ? { existingAppServer: { endpoint: mocks.existingEndpoint } }
          : {}),
      },
      botName: 'TestBot',
      botOpenId: 'ou_bot',
    })),
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  mocks.createSession.mockImplementation((chatId, rootMessageId, title, chatType, scope) => ({
    sessionId: `sid-${rootMessageId}`,
    chatId,
    rootMessageId,
    title,
    chatType,
    scope,
    status: 'active',
    createdAt: '2026-08-23T08:00:00.000Z',
  }));
  return {
    ...actual,
    createSession: mocks.createSession,
    updateSession: mocks.updateSession,
    closeSession: vi.fn(),
  };
});

vi.mock('../src/features/codex-notifier/desktop-ipc-client.js', () => ({
  probeCodexDesktopThread: mocks.probeCodexDesktopThread,
  sendCodexDesktopThreadTurn: vi.fn(),
  CodexDesktopUnavailableError: class CodexDesktopUnavailableError extends Error {},
}));

vi.mock('../src/features/codex-notifier/index.js', async () => {
  const actual = await vi.importActual<any>('../src/features/codex-notifier/index.js');
  class FakeTopicRouteStore {
    get(threadId: string, chatId: string) {
      return mocks.routes.get(`${chatId}\0${threadId}`);
    }
    bind(route: { threadId: string; chatId: string; rootMessageId: string }) {
      const stored = { ...route, updatedAt: new Date().toISOString() };
      mocks.routes.set(`${route.chatId}\0${route.threadId}`, stored);
      return stored;
    }
    invalidate(threadId: string, chatId: string) {
      return mocks.routes.delete(`${chatId}\0${threadId}`);
    }
  }
  return {
    ...actual,
    CodexNotifierTopicRouteStore: FakeTopicRouteStore,
    startCodexNotifierAdoptionSession: vi.fn(async (
      _start: unknown,
      target: { threadId: string },
      ds: any,
      _deps: unknown,
      _larkAppId: string,
      anchor: string,
    ) => {
      mocks.adoptionAnchors.push(anchor);
      ds.session.cliSessionId = target.threadId;
      if (mocks.existingEndpoint) {
        ds.session.cliId = 'codex';
        ds.session.existingAppServerEndpoint = mocks.existingEndpoint;
        delete ds.session.codexAppTransport;
        ds.worker = { send: vi.fn() };
      } else {
        ds.session.codexAppTransport = 'desktop-ipc';
      }
    }),
  };
});

import {
  __testOnly_adoptCodexNotifierEvent as adoptEvent,
  __testOnly_sharedAdoptCodexAppEvent as sharedAdoptEvent,
  __testOnly_createLarkPluginHost as createLarkPluginHost,
  __testOnly_activeSessions as activeSessions,
} from '../src/daemon.js';
import { sessionKey } from '../src/core/types.js';

const THREAD_ID = '01936f7a-0e7f-7e42-9e3e-b0ef5eb87f35';
const EVENT = {
  schemaVersion: 1,
  eventId: 'e'.repeat(64),
  type: 'task.completed',
  source: 'codex-desktop',
  clientSurface: 'codex-app',
  threadId: THREAD_ID,
  nativeTurnId: 'turn-1',
  status: 'completed',
  cwd: '/repos/live',
  title: 'Live task',
  completedAt: '2026-08-23T08:00:00.000Z',
  finalPreview: 'done',
} as const;

function route(chatId = 'oc_workbench') {
  mocks.routes.set(`${chatId}\0${THREAD_ID}`, {
    threadId: THREAD_ID,
    chatId,
    rootMessageId: 'om_root',
    updatedAt: '2026-08-23T08:00:00.000Z',
  });
}

function pluginAdoptInput() {
  return {
    eventId: EVENT.eventId,
    threadId: EVENT.threadId,
    nativeTurnId: EVENT.nativeTurnId,
    cwd: EVENT.cwd,
    title: EVENT.title,
    finalPreview: EVENT.finalPreview,
    status: EVENT.status,
    completedAt: EVENT.completedAt,
    cardMessageId: 'om_plugin_root',
    ownerOpenId: 'ou_owner',
  } as const;
}

describe('Codex notifier group topic adoption', () => {
  beforeEach(() => {
    activeSessions.clear();
    mocks.routes.clear();
    mocks.createSession.mockClear();
    mocks.updateSession.mockClear();
    mocks.adoptionAnchors.length = 0;
    mocks.probeCodexDesktopThread.mockClear();
    mocks.existingEndpoint = undefined;
    mocks.sendMessage.mockClear();
    mocks.replyMessage.mockClear();
    mocks.updateMessage.mockClear();
    mocks.chatId = 'oc_workbench';
    mocks.chatMode = 'topic';
  });

  it('binds a later completion card to the authoritative topic root', async () => {
    route();
    const ctrl = new AbortController();

    const card = await adoptEvent(
      'cli_app',
      EVENT,
      'om_later_card',
      'ou_owner',
      ctrl.signal,
      Date.now() + 2200,
    );

    expect(mocks.createSession).toHaveBeenCalledWith(
      'oc_workbench',
      'om_root',
      'Live task',
      'group',
      'thread',
    );
    expect(mocks.adoptionAnchors).toEqual(['om_root']);
    expect(activeSessions.get(sessionKey('om_root', 'cli_app'))).toMatchObject({
      chatId: 'oc_workbench',
      chatType: 'group',
      scope: 'thread',
    });
    expect(JSON.stringify(card)).toContain('已绑定 Codex App 任务');
  });

  it('fails closed when a group card has no matching route', async () => {
    const ctrl = new AbortController();
    await expect(adoptEvent(
      'cli_app',
      EVENT,
      'om_card',
      'ou_owner',
      ctrl.signal,
      Date.now() + 2200,
    )).rejects.toThrow('话题路由已过期');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('does not use a route from another chat', async () => {
    route('oc_other');
    const ctrl = new AbortController();
    await expect(adoptEvent(
      'cli_app',
      EVENT,
      'om_card',
      'ou_owner',
      ctrl.signal,
      Date.now() + 2200,
    )).rejects.toThrow('话题路由已过期');
  });

  it('fails closed when the card chat type cannot be confirmed', async () => {
    route();
    mocks.chatMode = 'unknown';
    const ctrl = new AbortController();
    await expect(adoptEvent(
      'cli_app',
      EVENT,
      'om_card',
      'ou_owner',
      ctrl.signal,
      Date.now() + 2200,
    )).rejects.toThrow('无法确认完成通知所在会话');
    expect(mocks.probeCodexDesktopThread).not.toHaveBeenCalled();
  });

  it('uses the notification card as the topic root for native shared adopt', async () => {
    mocks.existingEndpoint = 'unix:///tmp/codex-app-server.sock';
    const host = createLarkPluginHost('desktop-handoff', 'cli_app', {
      kind: 'card-action',
      operatorOpenId: 'ou_owner',
      cardMessageId: 'om_plugin_root',
    });
    const ref = await host.sharedAdopt(pluginAdoptInput());

    expect(mocks.routes).toHaveLength(0);
    expect(mocks.probeCodexDesktopThread).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledWith(
      'oc_workbench',
      'om_plugin_root',
      'Live task',
      'group',
      'thread',
    );
    expect(activeSessions.get(sessionKey('om_plugin_root', 'cli_app'))).toMatchObject({
      worker: expect.any(Object),
      session: {
        cliSessionId: THREAD_ID,
        existingAppServerEndpoint: mocks.existingEndpoint,
      },
    });
    expect(ref).toEqual({
      sessionId: 'sid-om_plugin_root',
      threadId: THREAD_ID,
      chatId: 'oc_workbench',
      rootMessageId: 'om_plugin_root',
    });
  });

  it('refuses plugin shared adopt when no existing App Server is configured', async () => {
    const ctrl = new AbortController();
    await expect(sharedAdoptEvent(
      'cli_app',
      EVENT,
      'om_plugin_root',
      'ou_owner',
      ctrl.signal,
      Date.now() + 2200,
      { anchorMessageId: 'om_plugin_root', requireExistingAppServer: true },
    )).rejects.toThrow('existing_app_server_not_configured');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('serializes cards only through the receiving bot transport', async () => {
    const host = createLarkPluginHost('desktop-handoff', 'cli_app', { kind: 'local-event' });
    const card = { schema: '2.0', body: { elements: [] } };

    await expect(host.sendCard({ chatId: 'oc_workbench', card, uuid: 'evt-1' }))
      .resolves.toEqual({ messageId: 'om_sent' });
    await expect(host.replyCard({ rootMessageId: 'om_root', card, uuid: 'evt-2' }))
      .resolves.toEqual({ messageId: 'om_reply' });
    await host.updateCard('om_root', card);

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'cli_app', 'oc_workbench', JSON.stringify(card), 'interactive', 'evt-1',
    );
    expect(mocks.replyMessage).toHaveBeenCalledWith(
      'cli_app', 'om_root', JSON.stringify(card), 'interactive', true, 'evt-2',
    );
    expect(mocks.updateMessage).toHaveBeenCalledWith(
      'cli_app', 'om_root', JSON.stringify(card),
    );
  });

  it('does not expose shared adopt to a local Hook event', async () => {
    mocks.existingEndpoint = 'unix:///tmp/codex-app-server.sock';
    const host = createLarkPluginHost('desktop-handoff', 'cli_app', { kind: 'local-event' });

    await expect(host.sharedAdopt(pluginAdoptInput()))
      .rejects.toThrow('shared_adopt_requires_card_action');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a non-owner card operator',
      { kind: 'card-action' as const, operatorOpenId: 'ou_other', cardMessageId: 'om_plugin_root' },
      'shared_adopt_owner_required',
    ],
    [
      'a different card callback',
      { kind: 'card-action' as const, operatorOpenId: 'ou_owner', cardMessageId: 'om_other' },
      'shared_adopt_card_mismatch',
    ],
  ])('rejects shared adopt from %s', async (_label, dispatchContext, error) => {
    mocks.existingEndpoint = 'unix:///tmp/codex-app-server.sock';
    const host = createLarkPluginHost('desktop-handoff', 'cli_app', dispatchContext);

    await expect(host.sharedAdopt(pluginAdoptInput())).rejects.toThrow(error);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

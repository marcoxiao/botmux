import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
  chatId: 'oc_workbench',
  chatMode: 'topic' as 'topic' | 'group' | 'p2p' | 'unknown',
  routes: new Map<string, { threadId: string; chatId: string; rootMessageId: string; updatedAt: string }>(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  adoptionAnchors: [] as string[],
  existingEndpoint: undefined as string | undefined,
  sendMessage: vi.fn(async () => 'om_sent'),
  replyMessage: vi.fn(async () => 'om_reply'),
  updateMessage: vi.fn(async () => undefined),
  claim: vi.fn(),
  adoptionReady: 'immediate' as 'immediate' | 'delayed',
  readyPublished: false,
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
    getMessageThreadId: vi.fn(async () => 'omt_plugin_thread'),
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

vi.mock('../src/core/plugins/lark-message-claims.js', () => ({
  LarkPluginMessageClaimStore: class {
    claim(input: unknown) { mocks.claim(input); }
    resolve() { return undefined; }
  },
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
      ds.session.cliId = 'codex';
      ds.session.existingAppServerEndpoint = mocks.existingEndpoint;
      const worker = Object.assign(new EventEmitter(), { send: vi.fn(), killed: false });
      ds.worker = worker;
      ds.workerReady = mocks.adoptionReady === 'immediate';
      mocks.readyPublished = ds.workerReady;
      if (mocks.adoptionReady === 'delayed') {
        setTimeout(() => {
          ds.workerReady = true;
          mocks.readyPublished = true;
          worker.emit('message', { type: 'ready' });
        }, 20);
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

describe('Codex notifier group topic adoption', () => {
  beforeEach(() => {
    activeSessions.clear();
    mocks.routes.clear();
    mocks.createSession.mockClear();
    mocks.updateSession.mockClear();
    mocks.adoptionAnchors.length = 0;
    mocks.existingEndpoint = 'unix:///tmp/codex-app-server.sock';
    mocks.sendMessage.mockClear();
    mocks.replyMessage.mockClear();
    mocks.updateMessage.mockClear();
    mocks.adoptionReady = 'immediate';
    mocks.readyPublished = false;
    mocks.chatId = 'oc_workbench';
    mocks.chatMode = 'topic';
    mocks.claim.mockClear();
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
  });

  it('refuses plugin shared adopt when no existing App Server is configured', async () => {
    mocks.existingEndpoint = undefined;
    const ctrl = new AbortController();
    await expect(sharedAdoptEvent(
      'cli_app',
      EVENT,
      'om_plugin_root',
      'ou_owner',
      ctrl.signal,
      Date.now() + 2200,
      { anchorMessageId: 'om_plugin_root' },
    )).rejects.toThrow('existing_app_server_not_configured');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('serializes cards only through the receiving bot transport', async () => {
    const host = createLarkPluginHost('desktop-handoff', 'cli_app', { kind: 'local-event' });
    const card = { schema: '2.0', body: { elements: [] } };

    expect(host).not.toHaveProperty('findSharedAdopt');
    expect(host).not.toHaveProperty('sharedAdopt');

    await expect(host.sendCard({ chatId: 'oc_workbench', card, uuid: 'evt-1' }))
      .resolves.toEqual({ messageId: 'om_sent' });
    await expect(host.sendCard({
      chatId: 'oc_workbench', card, uuid: 'evt-claimed', replyClaim: 'exclusive',
    })).resolves.toEqual({ messageId: 'om_sent' });
    await expect(host.replyCard({ rootMessageId: 'om_root', card, uuid: 'evt-2' }))
      .resolves.toEqual({ messageId: 'om_reply' });
    await host.updateCard('om_root', card);

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'cli_app', 'oc_workbench', JSON.stringify(card), 'interactive', 'evt-1',
    );
    expect(mocks.claim).toHaveBeenCalledWith({
      pluginId: 'desktop-handoff',
      larkAppId: 'cli_app',
      chatId: 'oc_workbench',
      rootMessageId: 'om_sent',
      aliases: ['omt_plugin_thread'],
    });
    expect(mocks.replyMessage).toHaveBeenCalledWith(
      'cli_app', 'om_root', JSON.stringify(card), 'interactive', true, 'evt-2',
    );
    expect(mocks.updateMessage).toHaveBeenCalledWith(
      'cli_app', 'om_root', JSON.stringify(card),
    );
  });

  it('maps a withdrawn topic root to a stable plugin-facing error', async () => {
    const { MessageWithdrawnError } = await import('../src/im/lark/client.js');
    mocks.replyMessage.mockRejectedValueOnce(new MessageWithdrawnError('om_root'));
    const host = createLarkPluginHost('desktop-handoff', 'cli_app', { kind: 'local-event' });

    await expect(host.replyCard({ rootMessageId: 'om_root', card: {}, uuid: 'evt-2' }))
      .rejects.toThrow('lark_root_message_unavailable');
  });

});

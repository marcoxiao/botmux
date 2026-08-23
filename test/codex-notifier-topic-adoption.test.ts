import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chatId: 'oc_workbench',
  chatMode: 'topic' as 'topic' | 'group' | 'p2p' | 'unknown',
  routes: new Map<string, { threadId: string; chatId: string; rootMessageId: string; updatedAt: string }>(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  adoptionAnchors: [] as string[],
  probeCodexDesktopThread: vi.fn(async () => 'codex-desktop-owner'),
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
  };
});

vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<any>('../src/bot-registry.js');
  return {
    ...actual,
    getBot: vi.fn(() => ({
      config: {
        larkAppId: 'cli_app',
        cliId: 'codex-app',
        p2pMode: 'thread',
        cliPathOverride: undefined,
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
      ds.session.codexAppTransport = 'desktop-ipc';
    }),
  };
});

import {
  __testOnly_adoptCodexNotifierEvent as adoptEvent,
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
    mocks.probeCodexDesktopThread.mockClear();
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
});

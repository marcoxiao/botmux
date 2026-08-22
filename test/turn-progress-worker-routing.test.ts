import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnProgressPluginV1 } from '../src/core/turn-progress/protocol.js';
import type { DaemonSession } from '../src/core/types.js';
import type { TurnProgressEligibilityInput } from '../src/core/turn-progress/eligibility.js';

const mocks = vi.hoisted(() => ({
  pluginIds: ['semantic-progress'] as string[],
  conflict: false,
  loadError: undefined as Error | undefined,
  createError: undefined as Error | undefined,
  create: vi.fn(),
  update: vi.fn(),
  updateSession: vi.fn(),
  load: vi.fn(),
}));

vi.mock('../src/core/plugins/session-manifest.js', () => ({
  readSessionPluginManifest: (sessionId: string) => ({
    schemaVersion: 1,
    sessionId,
    source: 'bot',
    pluginIds: [...mocks.pluginIds],
    generatedAt: '2026-08-22T00:00:00.000Z',
  }),
}));

vi.mock('../src/core/plugins/runtime.js', () => ({
  resolveTurnProgressPluginId: (ids: readonly string[]) => {
    if (mocks.conflict) throw new Error('multiple_turn_progress_plugins:first,second');
    return ids.includes('semantic-progress') ? 'semantic-progress' : undefined;
  },
  loadTurnProgressPlugin: (...args: unknown[]) => mocks.load(...args),
}));

vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBot: () => ({
    config: { larkAppId: 'app-1', larkAppSecret: 'secret', cliId: 'codex-app', apiOnly: false },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
  }),
}));

vi.mock('../src/im/lark/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/im/lark/client.js')>(),
  createCardEntity: (...args: unknown[]) => mocks.create(...args),
  updateCardEntity: (...args: unknown[]) => mocks.update(...args),
}));

vi.mock('../src/services/session-store.js', () => ({
  updateSession: (...args: unknown[]) => mocks.updateSession(...args),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  handleTurnProgressExternalReply,
  handleTurnProgressFact,
  handleTurnProgressResumed,
  handleTurnProgressSteer,
  handleTurnProgressTerminal,
  handleTurnProgressWaiting,
  semanticProgressSuppressesLegacyCard,
} from '../src/core/turn-progress/controller.js';
import { postTurnStartingCard } from '../src/core/worker-pool.js';

function testPlugin(): TurnProgressPluginV1 {
  return {
    schemaVersion: 1,
    initialState: context => ({ restored: context.restored, events: [] }),
    reduce: (state, event) => ({
      ...(state as object),
      events: [...((state as { events: unknown[] }).events), event],
    }),
    render: state => ({ schema: '2.0', body: { elements: [] }, state }),
  };
}

function daemonSession(): DaemonSession {
  return {
    session: {
      sessionId: 'session-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'Session',
      status: 'active',
      createdAt: '2026-08-22T00:00:00.000Z',
      workerGeneration: 3,
      cliId: 'codex-app',
    },
    worker: null,
    workerGeneration: 3,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app-1',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
  } as DaemonSession;
}

const eligible: TurnProgressEligibilityInput = {
  larkTransport: true,
  http: false,
  docComment: false,
  vcReceiver: false,
  vcListener: false,
  substitute: false,
  managedOrSilent: false,
};

const deps = {
  reply: vi.fn(async () => 'message-1'),
  reactDone: vi.fn(async () => {}),
};

describe('turn progress worker routing controller', () => {
  beforeEach(() => {
    mocks.pluginIds = ['semantic-progress'];
    mocks.conflict = false;
    mocks.loadError = undefined;
    mocks.createError = undefined;
    mocks.create.mockReset().mockImplementation(async () => {
      if (mocks.createError) throw mocks.createError;
      return 'card-1';
    });
    mocks.update.mockReset().mockResolvedValue(undefined);
    mocks.updateSession.mockReset();
    mocks.load.mockReset().mockImplementation(async () => {
      if (mocks.loadError) throw mocks.loadError;
      return { pluginId: 'semantic-progress', plugin: testPlugin() };
    });
    deps.reply.mockClear();
    deps.reactDone.mockClear();
  });

  it('suppresses the legacy card synchronously and creates one CardKit entity on the first fact', async () => {
    const ds = daemonSession();
    expect(semanticProgressSuppressesLegacyCard(ds, 'turn-1', eligible)).toBe(true);

    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'turn-1';
    ds.workerReady = true;
    const legacyReply = vi.fn(async () => 'legacy-card');
    await expect(postTurnStartingCard(ds, legacyReply, 'turn-1')).resolves.toBe(false);
    expect(legacyReply).not.toHaveBeenCalled();

    await expect(handleTurnProgressFact(ds, {
      type: 'turn_progress',
      sessionId: 'session-1',
      turnId: 'turn-1',
      dispatchAttempt: 1,
      fact: { schemaVersion: 1, seq: 1, atMs: 1, kind: 'turn_started' },
    }, 3, eligible, deps)).resolves.toBe('handled');

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(deps.reply).toHaveBeenCalledOnce();
    expect(ds.session.turnProgressBinding).toMatchObject({
      primaryTurnId: 'turn-1',
      cardId: 'card-1',
      messageId: 'message-1',
      deliveryState: 'active',
    });

    await handleTurnProgressFact(ds, {
      type: 'turn_progress',
      sessionId: 'session-1',
      turnId: 'turn-1',
      dispatchAttempt: 1,
      fact: { schemaVersion: 1, seq: 2, atMs: 2, kind: 'narrative', text: '继续执行' },
    }, 3, eligible, deps);
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('marks a turn for legacy fallback when create or async plugin validation fails', async () => {
    const ds = daemonSession();
    mocks.createError = Object.assign(new Error('timeout'), { disposition: 'ambiguous' });
    const message = {
      type: 'turn_progress' as const,
      sessionId: 'session-1',
      turnId: 'turn-1',
      dispatchAttempt: 1,
      fact: { schemaVersion: 1 as const, seq: 1, atMs: 1, kind: 'turn_started' as const },
    };

    await expect(handleTurnProgressFact(ds, message, 3, eligible, deps)).resolves.toBe('fallback');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(semanticProgressSuppressesLegacyCard(ds, 'turn-1', eligible)).toBe(false);
    await expect(handleTurnProgressFact(ds, message, 3, eligible, deps)).resolves.toBe('fallback');
    expect(mocks.create).toHaveBeenCalledOnce();

    const invalid = daemonSession();
    mocks.createError = undefined;
    mocks.loadError = new Error('invalid_turn_progress_plugin_render:semantic-progress');
    await expect(handleTurnProgressFact(invalid, message, 3, eligible, deps)).resolves.toBe('fallback');
    expect(semanticProgressSuppressesLegacyCard(invalid, 'turn-1', eligible)).toBe(false);
  });

  it('single-flights concurrent first facts so one execution unit creates one entity', async () => {
    const ds = daemonSession();
    let release!: () => void;
    mocks.create.mockImplementationOnce(() => new Promise<string>(resolve => {
      release = () => resolve('card-1');
    }));
    const first = handleTurnProgressFact(ds, {
      type: 'turn_progress', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      fact: { schemaVersion: 1, seq: 1, atMs: 1, kind: 'turn_started' },
    }, 3, eligible, deps);
    const second = handleTurnProgressFact(ds, {
      type: 'turn_progress', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      fact: { schemaVersion: 1, seq: 2, atMs: 2, kind: 'narrative', text: 'parallel' },
    }, 3, eligible, deps);
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(['handled', 'handled']);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(deps.reply).toHaveBeenCalledOnce();
  });

  it('does not install a host after its worker generation loses authority mid-start', async () => {
    const ds = daemonSession();
    let release!: () => void;
    mocks.create.mockImplementationOnce(() => new Promise<string>(resolve => {
      release = () => resolve('card-1');
    }));
    const delivery = handleTurnProgressFact(ds, {
      type: 'turn_progress', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      fact: { schemaVersion: 1, seq: 1, atMs: 1, kind: 'turn_started' },
    }, 3, eligible, deps);
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    ds.workerGeneration = 4;
    ds.session.workerGeneration = 4;
    release();

    await expect(delivery).resolves.toBe('ignored');
    expect(deps.reply).not.toHaveBeenCalled();
    expect(ds.turnProgressHost).toBeUndefined();
  });

  it('keeps conflicts and disabled plugins on the legacy path without loading runtime code', async () => {
    const conflict = daemonSession();
    mocks.conflict = true;
    expect(semanticProgressSuppressesLegacyCard(conflict, 'turn-1', eligible)).toBe(false);
    await expect(handleTurnProgressFact(conflict, {
      type: 'turn_progress', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      fact: { schemaVersion: 1, seq: 1, atMs: 1, kind: 'turn_started' },
    }, 3, eligible, deps)).resolves.toBe('ignored');
    expect(mocks.load).not.toHaveBeenCalled();

    mocks.conflict = false;
    mocks.pluginIds = [];
    const disabled = daemonSession();
    expect(semanticProgressSuppressesLegacyCard(disabled, 'turn-1', eligible)).toBe(false);
  });

  it('rejects stale session, worker generation, turn, and attempt identities', async () => {
    const ds = daemonSession();
    const base = {
      type: 'turn_progress' as const,
      sessionId: 'session-1',
      turnId: 'turn-1',
      dispatchAttempt: 1,
      fact: { schemaVersion: 1 as const, seq: 1, atMs: 1, kind: 'turn_started' as const },
    };
    await expect(handleTurnProgressFact(ds, { ...base, sessionId: 'wrong' }, 3, eligible, deps))
      .resolves.toBe('ignored');
    await expect(handleTurnProgressFact(ds, base, 2, eligible, deps)).resolves.toBe('ignored');
    expect(mocks.create).not.toHaveBeenCalled();

    await handleTurnProgressFact(ds, base, 3, eligible, deps);
    await expect(handleTurnProgressFact(ds, { ...base, turnId: 'other' }, 3, eligible, deps))
      .resolves.toBe('ignored');
    await expect(handleTurnProgressFact(ds, { ...base, dispatchAttempt: 2 }, 3, eligible, deps))
      .resolves.toBe('ignored');
  });

  it('binds ordered steer aliases and routes waiting, resumed, external reply, and terminal to one host', async () => {
    const ds = daemonSession();
    await handleTurnProgressFact(ds, {
      type: 'turn_progress', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      fact: { schemaVersion: 1, seq: 1, atMs: 1, kind: 'turn_started' },
    }, 3, eligible, deps);
    handleTurnProgressSteer(ds, 'turn-2');
    expect(ds.session.turnProgressBinding?.memberTurnIds).toEqual(['turn-1', 'turn-2']);

    await handleTurnProgressWaiting(ds, 'turn-2', '  请选择\u0000 <at id="x">用户</at>  ', eligible, deps);
    await handleTurnProgressResumed(ds, 'turn-2', eligible, deps);
    await handleTurnProgressExternalReply(ds, 'turn-2', eligible, deps);
    await handleTurnProgressTerminal(ds, {
      type: 'turn_terminal', sessionId: 'session-1', turnId: 'turn-2', dispatchAttempt: 1,
      status: 'completed', outputDisposition: 'nothing_to_send',
    }, eligible, deps);

    expect(mocks.create).toHaveBeenCalledOnce();
    const cards = mocks.update.mock.calls.map(call => JSON.parse(call[2] as string));
    expect(JSON.stringify(cards)).toContain('请选择 用户');
    expect(JSON.stringify(cards)).not.toContain('<at');
    expect(ds.session.turnProgressBinding).toBeUndefined();
    expect(deps.reactDone).toHaveBeenCalledWith('turn-1');

    await handleTurnProgressFact(ds, {
      type: 'turn_progress', sessionId: 'session-1', turnId: 'turn-3', dispatchAttempt: 2,
      fact: { schemaVersion: 1, seq: 2, atMs: 2, kind: 'turn_started' },
    }, 3, eligible, deps);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('settles a terminal-only failure so the next execution unit can start', async () => {
    const ds = daemonSession();
    await handleTurnProgressFact(ds, {
      type: 'turn_progress', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      fact: { schemaVersion: 1, seq: 1, atMs: 1, kind: 'turn_started' },
    }, 3, eligible, deps);

    await handleTurnProgressTerminal(ds, {
      type: 'turn_terminal', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      status: 'failed', errorCode: 'provider_failed',
    }, eligible, deps);

    expect(ds.session.turnProgressBinding).toBeUndefined();
    expect(deps.reactDone).not.toHaveBeenCalled();

    await handleTurnProgressFact(ds, {
      type: 'turn_progress', sessionId: 'session-1', turnId: 'turn-2', dispatchAttempt: 2,
      fact: { schemaVersion: 1, seq: 2, atMs: 2, kind: 'turn_started' },
    }, 3, eligible, deps);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('restores an active durable binding without creating another entity', async () => {
    const ds = daemonSession();
    ds.workerGeneration = 4;
    ds.session.workerGeneration = 4;
    ds.session.turnProgressBinding = {
      schemaVersion: 1,
      pluginId: 'semantic-progress',
      primaryTurnId: 'turn-1',
      primaryDispatchAttempt: 1,
      memberTurnIds: ['turn-1'],
      workerGeneration: 3,
      cardId: 'card-existing',
      messageId: 'message-existing',
      replyUuid: 'tp_r_existing',
      cardSequence: 4,
      deliveryState: 'active',
    };
    handleTurnProgressSteer(ds, 'turn-2');

    await handleTurnProgressResumed(ds, 'turn-1', eligible, deps);

    expect(mocks.create).not.toHaveBeenCalled();
    expect(ds.session.turnProgressBinding?.workerGeneration).toBe(4);
    expect(ds.session.turnProgressBinding?.memberTurnIds).toEqual(['turn-1', 'turn-2']);
    await vi.waitFor(() => {
      expect(mocks.update).toHaveBeenCalledWith(
        'app-1',
        'card-existing',
        expect.any(String),
        5,
        expect.stringMatching(/^tp_u_/),
      );
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { TurnProgressEligibilityInput } from '../src/core/turn-progress/eligibility.js';
import type { TurnProgressPluginV1 } from '../src/core/turn-progress/protocol.js';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/core/plugins/session-manifest.js', () => ({
  readSessionPluginManifest: (sessionId: string) => ({
    schemaVersion: 1,
    sessionId,
    source: 'bot',
    pluginIds: ['semantic-progress'],
    generatedAt: '2026-08-22T00:00:00.000Z',
  }),
}));

const plugin: TurnProgressPluginV1 = {
  schemaVersion: 1,
  initialState: () => ({ events: [] }),
  reduce: (state, event) => ({
    events: [...(state as { events: unknown[] }).events, event],
  }),
  render: state => ({ schema: '2.0', body: { elements: [] }, state }),
};

vi.mock('../src/core/plugins/runtime.js', () => ({
  resolveTurnProgressPluginId: (ids: readonly string[]) =>
    ids.includes('semantic-progress') ? 'semantic-progress' : undefined,
  loadTurnProgressPlugin: async () => ({ pluginId: 'semantic-progress', plugin }),
}));

vi.mock('../src/im/lark/client.js', () => ({
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
  acknowledgeProgressFinal,
  deliverFinalThroughProgressCard,
  handleTurnProgressFact,
  handleTurnProgressSteer,
  handleTurnProgressTerminal,
} from '../src/core/turn-progress/controller.js';

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

const start = async (ds: DaemonSession): Promise<void> => {
  await handleTurnProgressFact(ds, {
    type: 'turn_progress',
    sessionId: ds.session.sessionId,
    turnId: 'turn-1',
    dispatchAttempt: 1,
    fact: { schemaVersion: 1, seq: 1, atMs: 1, kind: 'turn_started' },
  }, 3, eligible, deps);
  await vi.waitFor(() => expect(mocks.update).toHaveBeenCalled());
  mocks.update.mockClear();
};

describe('turn progress canonical final delivery', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.create.mockReset().mockResolvedValue('card-1');
    mocks.update.mockReset().mockResolvedValue(undefined);
    mocks.updateSession.mockReset();
    deps.reply.mockClear();
    deps.reactDone.mockClear();
  });

  it('updates the same entity with the canonical card and clears only after ACK', async () => {
    const ds = daemonSession();
    await start(ds);
    handleTurnProgressSteer(ds, 'turn-2');
    const finalCard = JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '答案' }] } });

    await expect(deliverFinalThroughProgressCard(ds, {
      type: 'final_output', sessionId: 'session-1', turnId: 'turn-2', dispatchAttempt: 1,
      content: '答案', lastUuid: 'final-1',
    }, finalCard, eligible, deps)).resolves.toEqual({ kind: 'delivered', messageId: 'message-1' });

    expect(deps.reply).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith(
      'app-1', 'card-1', finalCard, expect.any(Number), expect.stringMatching(/^tp_u_/),
    );
    expect(deps.reactDone).toHaveBeenCalledWith('turn-1');
    expect(ds.session.turnProgressBinding?.deliveryState).toBe('finalizing');

    acknowledgeProgressFinal(ds, 'turn-2');
    expect(ds.session.turnProgressBinding).toBeUndefined();
    expect(ds.turnProgressHost).toBeUndefined();
  });

  it('does not recreate a progress card for a terminal that arrives after final ACK', async () => {
    const ds = daemonSession();
    await start(ds);
    await deliverFinalThroughProgressCard(ds, {
      type: 'final_output', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      content: '答案', lastUuid: 'final-1',
    }, JSON.stringify({ schema: '2.0' }), eligible, deps);
    acknowledgeProgressFinal(ds, 'turn-1');

    await handleTurnProgressTerminal(ds, {
      type: 'turn_terminal', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      status: 'completed',
    }, eligible, deps);

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(ds.session.turnProgressBinding).toBeUndefined();
  });

  it('falls back only for a permanent update failure', async () => {
    const ds = daemonSession();
    await start(ds);
    mocks.update.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { disposition: 'permanent' }));

    await expect(deliverFinalThroughProgressCard(ds, {
      type: 'final_output', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      content: '答案', lastUuid: 'final-1',
    }, JSON.stringify({ schema: '2.0' }), eligible, deps)).resolves.toEqual({ kind: 'fallback' });

    expect(ds.session.turnProgressBinding).toBeUndefined();
    expect(deps.reactDone).not.toHaveBeenCalled();
  });

  it('retries a failed durable ACK without reopening final delivery', async () => {
    vi.useFakeTimers();
    const ds = daemonSession();
    await start(ds);
    await deliverFinalThroughProgressCard(ds, {
      type: 'final_output', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      content: '答案', lastUuid: 'final-1',
    }, JSON.stringify({ schema: '2.0' }), eligible, deps);
    mocks.updateSession.mockImplementationOnce(() => { throw new Error('disk unavailable'); });

    acknowledgeProgressFinal(ds, 'turn-1');
    expect(ds.session.turnProgressBinding?.deliveryState).toBe('finalizing');
    await vi.advanceTimersByTimeAsync(250);

    expect(ds.session.turnProgressBinding).toBeUndefined();
    expect(ds.turnProgressHost).toBeUndefined();
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('retries an ambiguous update with the same sequence and uuid', async () => {
    vi.useFakeTimers();
    const ds = daemonSession();
    await start(ds);
    mocks.update
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { disposition: 'ambiguous' }))
      .mockResolvedValueOnce(undefined);

    const delivery = deliverFinalThroughProgressCard(ds, {
      type: 'final_output', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      content: '答案', lastUuid: 'final-1',
    }, JSON.stringify({ schema: '2.0' }), eligible, deps);
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    const intent = mocks.update.mock.calls[0].slice(3, 5);
    expect(ds.session.turnProgressBinding?.deliveryState).toBe('finalizing');
    await vi.advanceTimersByTimeAsync(250);

    await expect(delivery).resolves.toMatchObject({ kind: 'delivered' });
    expect(mocks.update.mock.calls[1].slice(3, 5)).toEqual(intent);
    expect(deps.reply).toHaveBeenCalledOnce();
  });

  it('does not take final delivery for suppressed or superseded output', async () => {
    const ds = daemonSession();
    await start(ds);

    await expect(deliverFinalThroughProgressCard(ds, {
      type: 'final_output', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      content: '答案', lastUuid: 'final-1', suppressDelivery: true,
    }, JSON.stringify({ schema: '2.0' }), { ...eligible, suppressDelivery: true }, deps))
      .resolves.toEqual({ kind: 'not_applicable' });
    await expect(deliverFinalThroughProgressCard(ds, {
      type: 'final_output', sessionId: 'session-1', turnId: 'turn-1', dispatchAttempt: 1,
      content: '', lastUuid: 'final-2', disposition: 'steer_superseded',
    }, JSON.stringify({ schema: '2.0' }), { ...eligible, steerSuperseded: true }, deps))
      .resolves.toEqual({ kind: 'not_applicable' });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(ds.session.turnProgressBinding?.deliveryState).toBe('active');
  });
});

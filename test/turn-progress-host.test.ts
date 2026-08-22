import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { TurnProgressHost } from '../src/core/turn-progress/host.js';
import type {
  TurnProgressContextV1,
  TurnProgressEventV1,
  TurnProgressPluginV1,
} from '../src/core/turn-progress/protocol.js';
import type { TurnProgressBindingV1 } from '../src/types.js';

type EventInput = TurnProgressEventV1 extends infer Event
  ? Event extends TurnProgressEventV1 ? Omit<Event, 'schemaVersion' | 'seq'> : never
  : never;

function context(overrides: Partial<TurnProgressContextV1> = {}): TurnProgressContextV1 {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    primaryTurnId: 'turn-1',
    turnId: 'turn-1',
    dispatchAttempt: 1,
    workerGeneration: 7,
    cliId: 'codex-app',
    locale: 'zh',
    restored: false,
    ...overrides,
  };
}

function plugin(control: { failInitial?: boolean; failReduce?: boolean; failRender?: boolean } = {}) {
  const events: TurnProgressEventV1[] = [];
  const initialContexts: TurnProgressContextV1[] = [];
  const value: TurnProgressPluginV1 = {
    schemaVersion: 1,
    initialState(ctx) {
      initialContexts.push(ctx);
      if (control.failInitial) throw new Error('initial failed');
      return { restored: ctx.restored, last: 'initial' };
    },
    reduce(state, event) {
      events.push(event);
      if (control.failReduce) throw new Error('reduce failed');
      return { ...(state as object), last: event.kind, event };
    },
    render(state) {
      if (control.failRender) throw new Error('render failed');
      return { schema: '2.0', body: { elements: [] }, state };
    },
  };
  return { value, events, initialContexts };
}

function harness() {
  const calls: string[] = [];
  const persisted: Array<TurnProgressBindingV1 | undefined> = [];
  const control = { failPersist: false };
  const create = vi.fn(async () => {
    calls.push('create');
    return 'card-1';
  });
  const reply = vi.fn(async () => {
    calls.push('reply');
    return 'message-1';
  });
  const update = vi.fn(async () => {
    calls.push('update');
  });
  const reactDone = vi.fn(async () => {
    calls.push('react');
  });
  const persist = vi.fn((binding: TurnProgressBindingV1 | undefined) => {
    calls.push(`persist:${binding?.deliveryState ?? 'clear'}`);
    if (control.failPersist) throw new Error('persist failed');
    persisted.push(binding ? structuredClone(binding) : undefined);
  });
  const sleep = vi.fn(async () => {});
  return {
    calls,
    persisted,
    control,
    create,
    reply,
    update,
    reactDone,
    persist,
    sleep,
    deps: { active: () => true, create, reply, update, reactDone, persist, sleep, now: () => Date.now() },
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('TurnProgressHost', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates once, persists the reply identity before attaching, then activates the same binding', async () => {
    const io = harness();
    const projection = plugin();

    const host = await TurnProgressHost.start('semantic-progress', projection.value, context(), io.deps);

    expect(host).not.toBeNull();
    expect(io.create).toHaveBeenCalledOnce();
    expect(io.calls).toEqual(['create', 'persist:replying', 'reply', 'persist:active']);
    expect(io.reply).toHaveBeenCalledWith(
      JSON.stringify({ type: 'card', data: { card_id: 'card-1' } }),
      'turn-1',
      expect.stringMatching(/^tp_r_/),
    );
    const replyUuid = io.reply.mock.calls[0][2];
    expect(replyUuid.length).toBeLessThanOrEqual(50);
    expect(io.persisted[0]).toMatchObject({
      cardId: 'card-1',
      replyUuid,
      deliveryState: 'replying',
      cardSequence: 0,
      memberTurnIds: ['turn-1'],
    });
    expect(io.persisted[1]).toMatchObject({ messageId: 'message-1', deliveryState: 'active' });
  });

  it('retries an ambiguous reply with the same IM UUID and never creates twice', async () => {
    const io = harness();
    io.reply
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { disposition: 'ambiguous' }))
      .mockResolvedValueOnce('message-1');

    await expect(TurnProgressHost.start('semantic-progress', plugin().value, context(), io.deps))
      .resolves.not.toBeNull();

    expect(io.create).toHaveBeenCalledOnce();
    expect(io.reply).toHaveBeenCalledTimes(2);
    expect(io.reply.mock.calls[0][2]).toBe(io.reply.mock.calls[1][2]);
    expect(io.sleep).toHaveBeenCalledOnce();
  });

  it('clears an unattached binding and falls back after a permanent reply failure', async () => {
    const io = harness();
    io.reply.mockRejectedValue(Object.assign(new Error('forbidden'), { disposition: 'permanent' }));

    await expect(TurnProgressHost.start('semantic-progress', plugin().value, context(), io.deps))
      .resolves.toBeNull();

    expect(io.create).toHaveBeenCalledOnce();
    expect(io.reply).toHaveBeenCalledOnce();
    expect(io.persisted.at(-1)).toBeUndefined();
  });

  it('coalesces ordinary snapshots for two seconds and keeps only the latest while one update is in flight', async () => {
    const io = harness();
    const projection = plugin();
    const host = (await TurnProgressHost.start('semantic-progress', projection.value, context(), io.deps))!;
    io.update.mockClear();

    host.dispatch({ kind: 'narrative', text: 'first' } as EventInput, false);
    host.dispatch({ kind: 'narrative', text: 'latest' } as EventInput, false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(io.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(io.update).toHaveBeenCalledOnce();
    expect(JSON.parse(io.update.mock.calls[0][1]).state.event.text).toBe('latest');

    let release!: () => void;
    io.update.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    host.dispatch({ kind: 'waiting', text: 'waiting' } as EventInput, true);
    expect(io.update).toHaveBeenCalledTimes(2);
    host.dispatch({ kind: 'resumed' } as EventInput, true);
    host.dispatch({ kind: 'narrative', text: 'after resume' } as EventInput, true);
    expect(io.update).toHaveBeenCalledTimes(2);
    release();
    await flushAsync();
    expect(io.update).toHaveBeenCalledTimes(3);
    expect(JSON.parse(io.update.mock.calls[2][1]).state.event.text).toBe('after resume');
  });

  it('uses monotonic sequences, stable per-intent UUIDs, and persists intent before update', async () => {
    const io = harness();
    const host = (await TurnProgressHost.start('semantic-progress', plugin().value, context(), io.deps))!;
    io.calls.length = 0;

    host.dispatch({ kind: 'waiting', text: 'input' } as EventInput, true);
    await flushAsync();
    host.dispatch({ kind: 'resumed' } as EventInput, true);
    await flushAsync();

    expect(io.update.mock.calls.map(call => call.slice(2))).toEqual([
      [1, expect.stringMatching(/^tp_u_/)],
      [2, expect.stringMatching(/^tp_u_/)],
    ]);
    expect(io.calls).toEqual([
      'persist:active', 'update', 'persist:active',
      'persist:active', 'update', 'persist:active',
    ]);
  });

  it('advances to a new sequence after a failed ordinary intent without retrying it automatically', async () => {
    const io = harness();
    const host = (await TurnProgressHost.start('semantic-progress', plugin().value, context(), io.deps))!;
    io.update.mockRejectedValueOnce(Object.assign(new Error('limited'), { disposition: 'retryable' }));

    host.dispatch({ kind: 'waiting', text: 'first' } as EventInput, true);
    await flushAsync();
    expect(io.update).toHaveBeenCalledOnce();
    host.dispatch({ kind: 'resumed' } as EventInput, true);
    await flushAsync();

    expect(io.update.mock.calls.map(call => call[2])).toEqual([1, 2]);
    expect(io.update.mock.calls[0][3]).not.toBe(io.update.mock.calls[1][3]);
  });

  it('retries a final with the same durable intent, reacts on the primary turn, and waits for ACK to clear', async () => {
    const io = harness();
    const host = (await TurnProgressHost.start('semantic-progress', plugin().value, context(), io.deps))!;
    host.bindSteer('turn-2');
    io.update
      .mockRejectedValueOnce(Object.assign(new Error('limited'), { disposition: 'retryable' }))
      .mockResolvedValueOnce(undefined);

    const result = await host.deliverFinal(JSON.stringify({ schema: '2.0', body: { elements: [] } }));

    expect(result).toEqual({ kind: 'delivered', messageId: 'message-1' });
    expect(io.update).toHaveBeenCalledTimes(2);
    expect(io.update.mock.calls[0].slice(2)).toEqual(io.update.mock.calls[1].slice(2));
    expect(io.persisted.at(-1)).toMatchObject({ deliveryState: 'finalizing' });
    expect(io.reactDone).toHaveBeenCalledWith('turn-1');
    expect(host.owns('turn-2', 1)).toBe(true);

    host.ackFinal('turn-2');
    expect(io.persisted.at(-1)).toBeUndefined();
  });

  it('returns fresh-final fallback only for a permanent final update failure', async () => {
    const io = harness();
    const host = (await TurnProgressHost.start('semantic-progress', plugin().value, context(), io.deps))!;
    io.update.mockRejectedValue(Object.assign(new Error('withdrawn'), { disposition: 'permanent' }));

    await expect(host.deliverFinal(JSON.stringify({ schema: '2.0' })))
      .resolves.toEqual({ kind: 'fallback' });
    expect(io.update).toHaveBeenCalledOnce();
    expect(io.persisted.at(-1)).toBeUndefined();
  });

  it('drops duplicate facts and all progress after terminal', async () => {
    const io = harness();
    const projection = plugin();
    const host = (await TurnProgressHost.start('semantic-progress', projection.value, context(), io.deps))!;

    host.dispatchFact({ schemaVersion: 1, seq: 1, atMs: 1, kind: 'narrative', text: 'one' });
    host.dispatchFact({ schemaVersion: 1, seq: 1, atMs: 2, kind: 'narrative', text: 'duplicate' });
    host.dispatch({ kind: 'terminal', status: 'failed' } as EventInput, true);
    host.dispatchFact({ schemaVersion: 1, seq: 2, atMs: 3, kind: 'narrative', text: 'late' });
    await flushAsync();

    expect(projection.events.map(event => event.kind)).toEqual(['narrative', 'terminal']);
    expect(projection.events.map(event => event.seq)).toEqual([1, 2]);
  });

  it('freezes progress after an explicit external reply', async () => {
    const io = harness();
    const projection = plugin();
    const host = (await TurnProgressHost.start('semantic-progress', projection.value, context(), io.deps))!;

    host.dispatch({ kind: 'external_reply' } as EventInput, true);
    host.dispatchFact({ schemaVersion: 1, seq: 1, atMs: 1, kind: 'narrative', text: 'late' });
    await flushAsync();

    expect(projection.events.map(event => event.kind)).toEqual(['external_reply']);
  });

  it('bounds ordered-steer aliases and rejects unrelated turn or attempt identities', async () => {
    const io = harness();
    const host = (await TurnProgressHost.start('semantic-progress', plugin().value, context(), io.deps))!;
    for (let index = 2; index <= 40; index += 1) host.bindSteer(`turn-${index}`);

    const binding = io.persisted.at(-1)!;
    expect(binding.memberTurnIds).toHaveLength(32);
    expect(binding.memberTurnIds[0]).toBe('turn-1');
    expect(binding.memberTurnIds.at(-1)).toBe('turn-40');
    expect(host.owns('turn-40', 1)).toBe(true);
    expect(host.owns('turn-40', 2)).toBe(false);
    expect(host.owns('unrelated', 1)).toBe(false);
  });

  it('isolates plugin failures without blocking a canonical final update', async () => {
    const initialIo = harness();
    await expect(TurnProgressHost.start(
      'semantic-progress',
      plugin({ failRender: true }).value,
      context(),
      initialIo.deps,
    )).resolves.toBeNull();
    expect(initialIo.create).not.toHaveBeenCalled();

    const io = harness();
    const control = { failReduce: false };
    const projection = plugin(control);
    const host = (await TurnProgressHost.start('semantic-progress', projection.value, context(), io.deps))!;
    control.failReduce = true;
    host.dispatch({ kind: 'waiting', text: 'input' } as EventInput, true);
    await flushAsync();
    expect(io.update).not.toHaveBeenCalled();

    await expect(host.deliverFinal(JSON.stringify({ schema: '2.0' })))
      .resolves.toEqual({ kind: 'delivered', messageId: 'message-1' });
    expect(io.update).toHaveBeenCalledOnce();
  });

  it('never calls a remote operation when its prerequisite persistence fails', async () => {
    const startIo = harness();
    startIo.control.failPersist = true;
    await expect(TurnProgressHost.start('semantic-progress', plugin().value, context(), startIo.deps))
      .resolves.toBeNull();
    expect(startIo.create).toHaveBeenCalledOnce();
    expect(startIo.reply).not.toHaveBeenCalled();

    const updateIo = harness();
    const host = (await TurnProgressHost.start('semantic-progress', plugin().value, context(), updateIo.deps))!;
    updateIo.control.failPersist = true;
    host.dispatch({ kind: 'waiting', text: 'input' } as EventInput, true);
    await flushAsync();
    expect(updateIo.update).not.toHaveBeenCalled();

    await expect(host.deliverFinal(JSON.stringify({ schema: '2.0' }))).rejects.toThrow('persist failed');
    expect(updateIo.update).not.toHaveBeenCalled();
    updateIo.control.failPersist = false;
    await flushAsync();
    await expect(host.deliverFinal(JSON.stringify({ schema: '2.0' })))
      .resolves.toEqual({ kind: 'delivered', messageId: 'message-1' });
    expect(updateIo.update).toHaveBeenCalledOnce();
  });

  it('restores only delivery metadata and initializes fresh plugin state with restored=true', async () => {
    const io = harness();
    const projection = plugin();
    const binding: TurnProgressBindingV1 = {
      schemaVersion: 1,
      pluginId: 'semantic-progress',
      primaryTurnId: 'turn-1',
      primaryDispatchAttempt: 1,
      memberTurnIds: ['turn-1'],
      workerGeneration: 7,
      cardId: 'card-1',
      messageId: 'message-1',
      replyUuid: 'tp_r_existing',
      cardSequence: 9,
      deliveryState: 'active',
      updateIntent: { uuid: 'tp_u_old', sequence: 10, cardHash: 'hash-only' },
    };

    const host = TurnProgressHost.restore(
      projection.value,
      context({ restored: true }),
      binding,
      io.deps,
    );
    expect(projection.initialContexts).toEqual([expect.objectContaining({ restored: true })]);
    expect(io.update).not.toHaveBeenCalled();

    host.dispatch({ kind: 'resumed' } as EventInput, true);
    await flushAsync();
    expect(JSON.parse(io.update.mock.calls[0][1]).state.restored).toBe(true);
    expect(io.update.mock.calls[0][2]).toBe(11);
  });

  it('falls back without overwriting the card when a restored projection is unavailable', async () => {
    const io = harness();
    const binding: TurnProgressBindingV1 = {
      schemaVersion: 1,
      pluginId: 'semantic-progress',
      primaryTurnId: 'turn-1',
      primaryDispatchAttempt: 1,
      memberTurnIds: ['turn-1'],
      workerGeneration: 7,
      cardId: 'card-1',
      messageId: 'message-1',
      replyUuid: 'tp_r_existing',
      cardSequence: 9,
      deliveryState: 'active',
    };
    const host = TurnProgressHost.restore(
      plugin({ failInitial: true }).value,
      context({ restored: true }),
      binding,
      io.deps,
    );

    await expect(host.settleTerminal({ kind: 'terminal', status: 'failed' }))
      .resolves.toEqual({ kind: 'fallback' });

    expect(io.update).not.toHaveBeenCalled();
    expect(io.persisted.at(-1)).toBeUndefined();
  });

  it('lets an in-flight canonical final own settlement after restored projection failure', async () => {
    const io = harness();
    const binding: TurnProgressBindingV1 = {
      schemaVersion: 1,
      pluginId: 'semantic-progress',
      primaryTurnId: 'turn-1',
      primaryDispatchAttempt: 1,
      memberTurnIds: ['turn-1'],
      workerGeneration: 7,
      cardId: 'card-1',
      messageId: 'message-1',
      replyUuid: 'tp_r_existing',
      cardSequence: 9,
      deliveryState: 'active',
    };
    const host = TurnProgressHost.restore(
      plugin({ failInitial: true }).value,
      context({ restored: true }),
      binding,
      io.deps,
    );
    let release!: () => void;
    io.update.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));

    const final = host.deliverFinal(JSON.stringify({ schema: '2.0', body: { elements: [] } }));
    await vi.waitFor(() => expect(io.update).toHaveBeenCalledOnce());

    await expect(host.settleTerminal({ kind: 'terminal', status: 'failed' }))
      .resolves.toEqual({ kind: 'not_applicable' });
    expect(io.persisted.at(-1)).toMatchObject({ deliveryState: 'finalizing' });
    expect(io.update).toHaveBeenCalledOnce();

    release();
    await expect(final).resolves.toEqual({ kind: 'delivered', messageId: 'message-1' });
    expect(io.persisted.at(-1)).toMatchObject({ deliveryState: 'finalizing' });
    host.ackFinal('turn-1');
    expect(io.persisted.at(-1)).toBeUndefined();
  });
});

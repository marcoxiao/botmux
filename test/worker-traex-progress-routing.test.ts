import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CodexBridgeQueue, type CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import { TraexProgressRouter } from '../src/services/traex-progress-router.js';
import type { TraexOrderedRecord } from '../src/services/traex-transcript.js';
import type { TurnProgressFactV1 } from '../src/core/turn-progress/protocol.js';

function bridge(
  uuid: string,
  kind: 'user' | 'assistant_final',
  text: string,
  timestampMs: number,
): TraexOrderedRecord {
  return { kind: 'bridge', event: { uuid, kind, text, timestampMs } };
}

function progress(seq: number, kind: TurnProgressFactV1['kind'] = 'turn_started'): TraexOrderedRecord {
  const fact: TurnProgressFactV1 = kind === 'narrative'
    ? { schemaVersion: 1, seq, atMs: 1_000 + seq, kind, text: `step ${seq}` }
    : { schemaVersion: 1, seq, atMs: 1_000 + seq, kind: 'turn_started' };
  return { kind: 'progress', fact };
}

describe('TraexProgressRouter', () => {
  it('is tapped by the worker with session and exact queue-owner identity', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const start = worker.indexOf('const traexProgressRouter = new TraexProgressRouter');
    const tap = worker.slice(start, worker.indexOf('\n});', start) + 4);
    expect(tap).toContain("type: 'turn_progress'");
    expect(tap).toContain('sessionId: lastInitConfig.sessionId');
    expect(tap).toContain('turnId: owner.turnId');
    expect(tap).toContain('dispatchAttempt: owner.dispatchAttempt');
    expect(worker).toContain('traexProgressRouter.ingest((result as TraexDrainResult).orderedRecords)');
  });

  it('preserves record order and attributes pre-user facts to the exact started owner', () => {
    const queue = new CodexBridgeQueue(() => 1_000);
    queue.mark('turn-1', 'first prompt', 1_000, 3);
    queue.mark('turn-2', 'second prompt', 1_001, 4);
    const emitted: Array<{ owner: CodexPendingTurn; fact: TurnProgressFactV1 }> = [];
    const router = new TraexProgressRouter(queue, (owner, fact) => emitted.push({ owner, fact }));

    router.ingest([
      progress(1),
      bridge('u1', 'user', 'first prompt', 1_001),
      progress(2, 'narrative'),
      bridge('f1', 'assistant_final', 'first answer', 1_002),
      progress(3),
      bridge('u2', 'user', 'second prompt', 1_003),
      progress(4, 'narrative'),
      bridge('f2', 'assistant_final', 'second answer', 1_004),
    ]);

    expect(emitted.map(({ owner, fact }) => ({
      turnId: owner.turnId,
      dispatchAttempt: owner.dispatchAttempt,
      seq: fact.seq,
    }))).toEqual([
      { turnId: 'turn-1', dispatchAttempt: 3, seq: 1 },
      { turnId: 'turn-1', dispatchAttempt: 3, seq: 2 },
      { turnId: 'turn-2', dispatchAttempt: 4, seq: 3 },
      { turnId: 'turn-2', dispatchAttempt: 4, seq: 4 },
    ]);
    expect(queue.drainEmittable().map(turn => turn.turnId)).toEqual(['turn-1', 'turn-2']);
  });

  it('bounds pre-owner facts at 128 and never emits progress for an adopted local turn', () => {
    const queue = new CodexBridgeQueue(() => 2_000);
    const emit = vi.fn();
    const router = new TraexProgressRouter(queue, emit);

    router.ingest(Array.from({ length: 130 }, (_, index) => progress(index + 1, 'narrative')));
    queue.mark('turn-bounded', 'bounded prompt', 2_000, 5);
    router.ingest([bridge('bounded-user', 'user', 'bounded prompt', 2_001)]);
    expect(emit).toHaveBeenCalledTimes(128);

    queue.clearPending();
    router.ingest([progress(150)]);
    router.clear();
    queue.mark('turn-after-clear', 'after clear', 2_000, 6);
    router.ingest([bridge('after-clear-user', 'user', 'after clear', 2_001)]);
    expect(emit).toHaveBeenCalledTimes(128);

    queue.clearPending();
    queue.setLocalTurns(true, 2_000);
    emit.mockClear();
    router.ingest([
      progress(200),
      bridge('local-user', 'user', 'typed locally', 2_002),
      progress(201, 'narrative'),
    ]);
    expect(emit).not.toHaveBeenCalled();
  });
});

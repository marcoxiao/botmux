import { describe, expect, it } from 'vitest';
import { normalizeTurnProgressFact } from '../src/core/turn-progress/protocol.js';

const atMs = 1_787_333_200_000;

describe('normalizeTurnProgressFact', () => {
  it('accepts the three bounded fact kinds', () => {
    expect(normalizeTurnProgressFact({ schemaVersion: 1, seq: 1, atMs, kind: 'turn_started' }, '/workspace'))
      .toEqual({ schemaVersion: 1, seq: 1, atMs, kind: 'turn_started' });
    expect(normalizeTurnProgressFact({ schemaVersion: 1, seq: 2, atMs, kind: 'narrative', text: '正在检查实现' }, '/workspace'))
      .toEqual({ schemaVersion: 1, seq: 2, atMs, kind: 'narrative', text: '正在检查实现' });
    expect(normalizeTurnProgressFact({
      schemaVersion: 1,
      seq: 3,
      atMs,
      kind: 'operation',
      operation: { id: 'cmd-1', type: 'command', phase: 'completed', outcome: 'succeeded' },
    }, '/workspace')).toEqual({
      schemaVersion: 1,
      seq: 3,
      atMs,
      kind: 'operation',
      operation: { id: 'cmd-1', type: 'command', phase: 'completed', outcome: 'succeeded' },
    });
  });

  it('normalizes whitespace, controls and native at tags before truncating by code point', () => {
    expect(normalizeTurnProgressFact({
      schemaVersion: 1,
      seq: 7,
      atMs,
      kind: 'narrative',
      text: `  正在检查\u0000 <at id="ou_x">某人</at>  ${'好'.repeat(300)}`,
    }, '/workspace')).toEqual({
      schemaVersion: 1,
      seq: 7,
      atMs,
      kind: 'narrative',
      text: `正在检查 某人 ${'好'.repeat(232)}`,
    });
  });

  it('rejects empty narratives and raw execution payload fields', () => {
    expect(normalizeTurnProgressFact({ schemaVersion: 1, seq: 1, atMs, kind: 'narrative', text: '\u0000  ' }, '/workspace')).toBeNull();
    expect(normalizeTurnProgressFact({
      schemaVersion: 1,
      seq: 8,
      atMs,
      kind: 'operation',
      operation: { type: 'command', phase: 'started', command: 'printenv' },
    }, '/workspace')).toBeNull();
    expect(normalizeTurnProgressFact({
      schemaVersion: 1,
      seq: 9,
      atMs,
      kind: 'operation',
      operation: { type: 'mcp', phase: 'completed', result: 'secret' },
    }, '/workspace')).toBeNull();
  });

  it('keeps at most three lexical workspace-relative file paths', () => {
    expect(normalizeTurnProgressFact({
      schemaVersion: 1,
      seq: 10,
      atMs,
      kind: 'operation',
      operation: {
        type: 'file_change',
        phase: 'completed',
        subjects: ['src/a.ts', './src/b.ts', '../secret', '/workspace/src/c.ts', 'src/d.ts', 'src/e.ts'],
      },
    }, '/workspace')).toEqual({
      schemaVersion: 1,
      seq: 10,
      atMs,
      kind: 'operation',
      operation: {
        type: 'file_change',
        phase: 'completed',
        subjects: ['src/a.ts', 'src/b.ts', 'src/d.ts'],
      },
    });
  });

  it('keeps only bounded MCP labels and never command subjects', () => {
    expect(normalizeTurnProgressFact({
      schemaVersion: 1,
      seq: 11,
      atMs,
      kind: 'operation',
      operation: { type: 'mcp', phase: 'started', subjects: ['  server/tool\u0000 ', '<at id="x">unsafe</at>'] },
    }, '/workspace')).toEqual({
      schemaVersion: 1,
      seq: 11,
      atMs,
      kind: 'operation',
      operation: { type: 'mcp', phase: 'started', subjects: ['server/tool', 'unsafe'] },
    });
    expect(normalizeTurnProgressFact({
      schemaVersion: 1,
      seq: 12,
      atMs,
      kind: 'operation',
      operation: { type: 'command', phase: 'started', subjects: ['raw command'] },
    }, '/workspace')).toEqual({
      schemaVersion: 1,
      seq: 12,
      atMs,
      kind: 'operation',
      operation: { type: 'command', phase: 'started' },
    });
  });

  it.each([
    null,
    {},
    { schemaVersion: 2, seq: 1, atMs, kind: 'turn_started' },
    { schemaVersion: 1, seq: -1, atMs, kind: 'turn_started' },
    { schemaVersion: 1, seq: 1.5, atMs, kind: 'turn_started' },
    { schemaVersion: 1, seq: 1, atMs: Number.NaN, kind: 'turn_started' },
    { schemaVersion: 1, seq: 1, atMs, kind: 'unknown' },
    { schemaVersion: 1, seq: 1, atMs, kind: 'operation', operation: { type: 'shell', phase: 'started' } },
    { schemaVersion: 1, seq: 1, atMs, kind: 'operation', operation: { type: 'mcp', phase: 'running' } },
    { schemaVersion: 1, seq: 1, atMs, kind: 'operation', operation: { type: 'mcp', phase: 'started', outcome: 'succeeded' } },
  ])('rejects invalid schema values: %j', value => {
    expect(normalizeTurnProgressFact(value, '/workspace')).toBeNull();
  });
});

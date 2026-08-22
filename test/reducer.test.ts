import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../src/reducer.js';

const context = {
  schemaVersion: 1 as const,
  sessionId: 'session-1',
  primaryTurnId: 'turn-1',
  turnId: 'turn-1',
  workerGeneration: 1,
  cliId: 'codex-app',
  locale: 'zh' as const,
  restored: false,
};

describe('semantic progress reducer', () => {
  it('starts once and ignores old or duplicate sequences', () => {
    const initial = initialState(context);
    const started = reduce(initial, { schemaVersion: 1, seq: 1, kind: 'turn_started' }, context);
    expect(started).toMatchObject({ seq: 1, phase: 'running' });
    expect(started.timeline).toEqual([
      { key: 'start', label: '理解需求', status: 'current', count: 1 },
    ]);
    expect(reduce(started, { schemaVersion: 1, seq: 1, kind: 'turn_started' }, context)).toBe(started);
  });

  it('updates bounded narration without creating synthetic progress', () => {
    const started = reduce(initialState(context), {
      schemaVersion: 1, seq: 1, kind: 'turn_started',
    }, context);
    const narrated = reduce(started, {
      schemaVersion: 1, seq: 2, kind: 'narrative', text: '正在检查实现',
    }, context);
    expect(narrated.currentText).toBe('正在检查实现');
    expect(narrated.operationCount).toBe(0);
  });

  it('merges operation start/completion by id and adjacent labels', () => {
    let state = reduce(initialState(context), {
      schemaVersion: 1, seq: 1, kind: 'turn_started',
    }, context);
    state = reduce(state, {
      schemaVersion: 1, seq: 2, kind: 'operation',
      operation: { id: 'cmd-1', type: 'command', phase: 'started' },
    }, context);
    state = reduce(state, {
      schemaVersion: 1, seq: 3, kind: 'operation',
      operation: { id: 'cmd-1', type: 'command', phase: 'completed', outcome: 'succeeded' },
    }, context);
    state = reduce(state, {
      schemaVersion: 1, seq: 4, kind: 'operation',
      operation: { id: 'cmd-2', type: 'command', phase: 'completed', outcome: 'succeeded' },
    }, context);

    expect(state.operationCount).toBe(2);
    expect(state.timeline.at(-1)).toMatchObject({
      label: '执行命令', status: 'completed', count: 2,
    });
  });

  it('keeps an aggregated operation current until every concurrent id completes', () => {
    let state = initialState(context);
    state = reduce(state, {
      schemaVersion: 1, seq: 1, kind: 'operation',
      operation: { id: 'cmd-1', type: 'command', phase: 'started' },
    }, context);
    state = reduce(state, {
      schemaVersion: 1, seq: 2, kind: 'operation',
      operation: { id: 'cmd-2', type: 'command', phase: 'started' },
    }, context);
    state = reduce(state, {
      schemaVersion: 1, seq: 3, kind: 'operation',
      operation: { id: 'cmd-1', type: 'command', phase: 'completed', outcome: 'succeeded' },
    }, context);
    expect(state.timeline.at(-1)).toMatchObject({ status: 'current', count: 2 });

    state = reduce(state, {
      schemaVersion: 1, seq: 4, kind: 'operation',
      operation: { id: 'cmd-2', type: 'command', phase: 'completed', outcome: 'succeeded' },
    }, context);
    expect(state.timeline.at(-1)).toMatchObject({ status: 'completed', count: 2 });
  });

  it('accepts completion-only operations and preserves total count while trimming to four items', () => {
    const types = ['command', 'file_change', 'mcp', 'other', 'command'] as const;
    let state = initialState(context);
    types.forEach((type, index) => {
      state = reduce(state, {
        schemaVersion: 1,
        seq: index + 1,
        kind: 'operation',
        operation: { id: `op-${index}`, type, phase: 'completed', outcome: 'succeeded' },
      }, context);
    });

    expect(state.operationCount).toBe(5);
    expect(state.timeline).toHaveLength(4);
    expect(state.timeline[0]?.label).toBe('执行命令');
    expect(state.timeline.slice(1).map(item => item.label)).toEqual([
      '调用工具', '执行操作', '执行命令',
    ]);
  });

  it('enters waiting state and resumes without losing the timeline', () => {
    let state = reduce(initialState(context), {
      schemaVersion: 1, seq: 1, kind: 'waiting', text: '请选择环境',
    }, context);
    expect(state).toMatchObject({ phase: 'waiting_input', currentText: '请选择环境' });
    expect(state.timeline.at(-1)).toMatchObject({ label: '等待你的输入', status: 'current' });

    state = reduce(state, { schemaVersion: 1, seq: 2, kind: 'resumed' }, context);
    expect(state.phase).toBe('running');
    expect(state.timeline.at(-1)?.status).toBe('completed');
  });

  it('owns fallback presentation for empty waiting and final confirmation semantics', () => {
    let state = reduce(initialState(context), {
      schemaVersion: 1, seq: 1, kind: 'waiting', text: '',
    }, context);
    expect(state.phase).toBe('waiting_input');
    expect(state.currentText).toBeUndefined();

    state = reduce(state, { schemaVersion: 1, seq: 2, kind: 'resumed' }, context);
    state = reduce(state, { schemaVersion: 1, seq: 3, kind: 'finalizing' }, context);
    expect(state).toMatchObject({ phase: 'running', currentText: '正在确认结果' });

    const english = reduce(initialState({ ...context, locale: 'en' }), {
      schemaVersion: 1, seq: 1, kind: 'finalizing',
    }, { ...context, locale: 'en' });
    expect(english.currentText).toBe('Confirming the result');
  });

  it.each([
    ['completed', 'succeeded', 'completed'],
    ['failed', 'failed', 'failed'],
    ['cancelled', 'cancelled', 'failed'],
    ['ambiguous', 'ambiguous', 'failed'],
  ] as const)('freezes terminal %s as %s', (status, phase, itemStatus) => {
    const terminal = reduce(initialState(context), {
      schemaVersion: 1, seq: 1, kind: 'terminal', status, errorCode: 'terminal_code',
    }, context);
    expect(terminal).toMatchObject({ phase, terminalErrorCode: 'terminal_code' });
    expect(terminal.timeline.every(item => item.status === itemStatus)).toBe(true);
    expect(reduce(terminal, {
      schemaVersion: 1, seq: 2, kind: 'narrative', text: 'late progress',
    }, context)).toBe(terminal);
  });

  it('freezes an external reply as a successful independent delivery', () => {
    const state = reduce(initialState(context), {
      schemaVersion: 1, seq: 1, kind: 'external_reply',
    }, context);
    expect(state).toMatchObject({
      phase: 'succeeded',
      currentText: '答复已通过独立消息发送',
    });
  });
});

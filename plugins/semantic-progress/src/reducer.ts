export interface ProgressContext {
  schemaVersion: 1;
  sessionId: string;
  primaryTurnId: string;
  turnId: string;
  dispatchAttempt?: number;
  workerGeneration: number;
  cliId: string;
  locale: 'zh' | 'en';
  restored: boolean;
}

export interface ProgressOperation {
  id?: string;
  type: 'command' | 'file_change' | 'mcp' | 'other';
  phase: 'started' | 'completed';
  subjects?: string[];
  outcome?: 'succeeded' | 'failed' | 'cancelled';
}

export type ProgressEvent =
  | { schemaVersion: 1; seq: number; kind: 'turn_started' }
  | { schemaVersion: 1; seq: number; kind: 'narrative'; text: string }
  | { schemaVersion: 1; seq: number; kind: 'operation'; operation: ProgressOperation }
  | { schemaVersion: 1; seq: number; kind: 'waiting'; text: string }
  | { schemaVersion: 1; seq: number; kind: 'resumed' }
  | { schemaVersion: 1; seq: number; kind: 'finalizing' }
  | { schemaVersion: 1; seq: number; kind: 'external_reply' }
  | {
      schemaVersion: 1;
      seq: number;
      kind: 'terminal';
      status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
      errorCode?: string;
    };

export interface ProgressState {
  seq: number;
  phase: 'starting' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'cancelled' | 'ambiguous';
  currentText?: string;
  timeline: Array<{
    key: string;
    label: string;
    status: 'current' | 'completed' | 'failed';
    count: number;
  }>;
  operationCount: number;
  terminalErrorCode?: string;
  /** Internal idempotency index; the renderer deliberately ignores it. */
  operationStates: Record<string, {
    key: string;
    status: 'started' | 'completed';
    outcome?: ProgressOperation['outcome'];
  }>;
}

const TERMINAL_PHASES = new Set<ProgressState['phase']>([
  'succeeded', 'failed', 'cancelled', 'ambiguous',
]);

const OPERATION_LABELS: Record<ProgressOperation['type'], string> = {
  command: '执行命令',
  file_change: '修改文件',
  mcp: '调用工具',
  other: '执行操作',
};

function finishCurrent(
  timeline: ProgressState['timeline'],
  status: 'completed' | 'failed' = 'completed',
): ProgressState['timeline'] {
  return timeline.map(item => item.status === 'current' ? { ...item, status } : item);
}

function appendTimeline(
  timeline: ProgressState['timeline'],
  item: ProgressState['timeline'][number],
): { timeline: ProgressState['timeline']; key: string } {
  const next = finishCurrent(timeline);
  const last = next.at(-1);
  let key = item.key;
  if (last?.label === item.label) {
    key = last.key;
    next[next.length - 1] = {
      ...last,
      status: item.status,
      count: last.count + item.count,
    };
  } else {
    next.push(item);
  }
  return {
    timeline: next.length <= 4 ? next : [next[0]!, ...next.slice(-3)],
    key,
  };
}

function settleOperationGroup(
  timeline: ProgressState['timeline'],
  key: string,
  operations: ProgressState['operationStates'],
): ProgressState['timeline'] {
  const members = Object.values(operations).filter(operation => operation.key === key);
  const status = members.some(operation => operation.status === 'started')
    ? 'current'
    : members.some(operation => operation.outcome === 'failed' || operation.outcome === 'cancelled')
      ? 'failed'
      : 'completed';
  return timeline.map(item => item.key === key ? { ...item, status } : item);
}

export function initialState(context: ProgressContext): ProgressState {
  return {
    seq: 0,
    phase: context.restored ? 'running' : 'starting',
    ...(context.restored
      ? { currentText: context.locale === 'en' ? 'Execution restored' : '已恢复执行' }
      : {}),
    timeline: [],
    operationCount: 0,
    operationStates: {},
  };
}

export function reduce(
  state: ProgressState,
  event: ProgressEvent,
  context: ProgressContext,
): ProgressState {
  if (event.seq <= state.seq || TERMINAL_PHASES.has(state.phase)) return state;
  const next = {
    ...state,
    seq: event.seq,
    timeline: state.timeline.map(item => ({ ...item })),
    operationStates: { ...state.operationStates },
  };

  if (event.kind === 'turn_started') {
    if (next.timeline.some(item => item.key === 'start')) return { ...next, phase: 'running' };
    const appended = appendTimeline(next.timeline, {
      key: 'start', label: '理解需求', status: 'current', count: 1,
    });
    return { ...next, phase: 'running', timeline: appended.timeline };
  }
  if (event.kind === 'narrative') {
    return { ...next, phase: next.phase === 'starting' ? 'running' : next.phase, currentText: event.text };
  }
  if (event.kind === 'operation') {
    const id = event.operation.id ?? `anonymous:${event.seq}`;
    const known = next.operationStates[id];
    if (known) {
      if (event.operation.phase === 'completed' && known.status !== 'completed') {
        next.operationStates[id] = {
          ...known,
          status: 'completed',
          ...(event.operation.outcome ? { outcome: event.operation.outcome } : {}),
        };
        next.timeline = settleOperationGroup(next.timeline, known.key, next.operationStates);
      }
      return { ...next, phase: 'running' };
    }

    const status = event.operation.phase === 'started'
      ? 'current' as const
      : event.operation.outcome === 'failed' || event.operation.outcome === 'cancelled'
        ? 'failed' as const
        : 'completed' as const;
    const appended = appendTimeline(next.timeline, {
      key: `operation:${event.seq}`,
      label: OPERATION_LABELS[event.operation.type],
      status,
      count: 1,
    });
    next.operationStates[id] = {
      key: appended.key,
      status: event.operation.phase === 'completed' ? 'completed' : 'started',
      ...(event.operation.outcome ? { outcome: event.operation.outcome } : {}),
    };
    next.timeline = settleOperationGroup(appended.timeline, appended.key, next.operationStates);
    return {
      ...next,
      phase: 'running',
      timeline: next.timeline,
      operationCount: next.operationCount + 1,
    };
  }
  if (event.kind === 'waiting') {
    const appended = appendTimeline(next.timeline, {
      key: `waiting:${event.seq}`,
      label: '等待你的输入',
      status: 'current',
      count: 1,
    });
    return {
      ...next,
      phase: 'waiting_input',
      currentText: event.text || undefined,
      timeline: appended.timeline,
    };
  }
  if (event.kind === 'resumed') {
    if (next.phase !== 'waiting_input') return next;
    return {
      ...next,
      phase: 'running',
      currentText: undefined,
      timeline: finishCurrent(next.timeline),
    };
  }
  if (event.kind === 'finalizing') {
    return {
      ...next,
      phase: 'running',
      currentText: context.locale === 'en' ? 'Confirming the result' : '正在确认结果',
    };
  }
  if (event.kind === 'external_reply') {
    return {
      ...next,
      phase: 'succeeded',
      currentText: context.locale === 'en'
        ? 'The answer was sent as a separate message'
        : '答复已通过独立消息发送',
      timeline: finishCurrent(next.timeline),
    };
  }

  const phase = event.status === 'completed' ? 'succeeded' : event.status;
  return {
    ...next,
    phase,
    timeline: finishCurrent(next.timeline, event.status === 'completed' ? 'completed' : 'failed'),
    ...(event.errorCode ? { terminalErrorCode: event.errorCode } : {}),
  };
}

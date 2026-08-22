import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface TurnProgressFactV1 {
  schemaVersion: 1;
  seq: number;
  atMs: number;
  kind: 'turn_started' | 'narrative' | 'operation';
  text?: string;
  operation?: {
    id?: string;
    type: 'command' | 'file_change' | 'mcp' | 'other';
    phase: 'started' | 'completed';
    subjects?: string[];
    outcome?: 'succeeded' | 'failed' | 'cancelled';
  };
}

export type TurnProgressTerminal = 'completed' | 'failed' | 'cancelled' | 'ambiguous';

export interface TurnProgressContextV1 {
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

export type TurnProgressEventV1 =
  | { schemaVersion: 1; seq: number; kind: 'turn_started' }
  | { schemaVersion: 1; seq: number; kind: 'narrative'; text: string }
  | { schemaVersion: 1; seq: number; kind: 'operation'; operation: NonNullable<TurnProgressFactV1['operation']> }
  | { schemaVersion: 1; seq: number; kind: 'waiting'; text: string }
  | { schemaVersion: 1; seq: number; kind: 'resumed' }
  | { schemaVersion: 1; seq: number; kind: 'finalizing' }
  | { schemaVersion: 1; seq: number; kind: 'external_reply' }
  | { schemaVersion: 1; seq: number; kind: 'terminal'; status: TurnProgressTerminal; errorCode?: string };

export interface TurnProgressPluginV1 {
  schemaVersion: 1;
  initialState(context: TurnProgressContextV1): unknown;
  reduce(state: unknown, event: TurnProgressEventV1, context: TurnProgressContextV1): unknown;
  render(state: unknown, context: TurnProgressContextV1): Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every(key => keys.has(key));
}

function cleanText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .replace(/<\/?at\b[^>]*>/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return undefined;
  return Array.from(text).slice(0, limit).join('');
}

function normalizeFileSubjects(value: unknown, workingDir: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const root = resolve(workingDir);
  const subjects = value.flatMap(subject => {
    if (typeof subject !== 'string' || isAbsolute(subject)) return [];
    const path = relative(root, resolve(root, subject));
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return [];
    return [path.split(sep).join('/')];
  }).slice(0, 3);
  return subjects.length > 0 ? subjects : undefined;
}

function normalizeLabels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = value.flatMap(subject => {
    const label = cleanText(subject, 80);
    return label ? [label] : [];
  }).slice(0, 3);
  return labels.length > 0 ? labels : undefined;
}

export function normalizeTurnProgressFact(raw: unknown, workingDir: string): TurnProgressFactV1 | null {
  if (!isRecord(raw)
    || !hasOnlyKeys(raw, ['schemaVersion', 'seq', 'atMs', 'kind', 'text', 'operation'])
    || raw.schemaVersion !== 1
    || !Number.isSafeInteger(raw.seq) || (raw.seq as number) < 0
    || !Number.isSafeInteger(raw.atMs) || (raw.atMs as number) < 0) return null;

  const base = { schemaVersion: 1 as const, seq: raw.seq as number, atMs: raw.atMs as number };
  if (raw.kind === 'turn_started') {
    return raw.text === undefined && raw.operation === undefined ? { ...base, kind: 'turn_started' } : null;
  }
  if (raw.kind === 'narrative') {
    if (raw.operation !== undefined) return null;
    const text = cleanText(raw.text, 240);
    return text ? { ...base, kind: 'narrative', text } : null;
  }
  if (raw.kind !== 'operation' || raw.text !== undefined || !isRecord(raw.operation)) return null;

  const operation = raw.operation;
  if (!hasOnlyKeys(operation, ['id', 'type', 'phase', 'subjects', 'outcome'])
    || !['command', 'file_change', 'mcp', 'other'].includes(operation.type as string)
    || !['started', 'completed'].includes(operation.phase as string)
    || (operation.outcome !== undefined && !['succeeded', 'failed', 'cancelled'].includes(operation.outcome as string))
    || (operation.phase === 'started' && operation.outcome !== undefined)) return null;

  const type = operation.type as NonNullable<TurnProgressFactV1['operation']>['type'];
  const phase = operation.phase as NonNullable<TurnProgressFactV1['operation']>['phase'];
  const id = operation.id === undefined ? undefined : cleanText(operation.id, 128);
  if (operation.id !== undefined && !id) return null;
  const subjects = type === 'file_change'
    ? normalizeFileSubjects(operation.subjects, workingDir)
    : type === 'mcp' || type === 'other'
      ? normalizeLabels(operation.subjects)
      : undefined;

  return {
    ...base,
    kind: 'operation',
    operation: {
      ...(id ? { id } : {}),
      type,
      phase,
      ...(subjects ? { subjects } : {}),
      ...(operation.outcome ? { outcome: operation.outcome as NonNullable<TurnProgressFactV1['operation']>['outcome'] } : {}),
    },
  };
}

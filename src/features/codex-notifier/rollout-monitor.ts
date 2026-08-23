import {
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { codexSessionIdFromRolloutPath } from '../../services/codex-transcript.js';
import { baselineJsonlCursor, scanJsonlFromOffset } from '../../services/jsonl-cursor.js';
import { readCodexTurnContext } from './codex-context.js';
import { resolveCodexNotifierConfig, type ResolvedCodexNotifierConfig } from './config.js';
import { createCodexNotifierCompletionEvent } from './event.js';
import { isInternalCodexPrompt } from './internal-turn.js';
import { enqueueCodexNotifierEvent } from './outbox.js';
import {
  detectScreenLock,
  shouldNotifyForLockState,
  type ScreenLockState,
} from './screen-lock.js';
import type { CodexTaskStatus } from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_FULL_RECONCILE_INTERVAL_MS = 60_000;
const MAX_TRACKED_ROLLOUTS = 256;

interface CodexRolloutFile {
  path: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
}

interface RolloutTerminal {
  turnId: string;
  status: CodexTaskStatus;
  completedAt: string;
  completedAtMs: number;
}

function childDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(path, entry.name));
  } catch {
    return [];
  }
}

function rolloutFilesInDays(days: string[]): CodexRolloutFile[] {
  const result: CodexRolloutFile[] = [];
  for (const day of days) {
    let entries;
    try {
      entries = readdirSync(day, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const sessionId = codexSessionIdFromRolloutPath(entry.name);
      if (!sessionId) continue;
      const path = join(day, entry.name);
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        result.push({ path, sessionId, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Codex 可能在扫描时清理尚未使用的 transcript。
      }
    }
  }
  return result
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, MAX_TRACKED_ROLLOUTS);
}

/** Codex 固定使用 sessions/YYYY/MM/DD；只遍历这三层并按活跃时间保留最近文件。 */
export function listCodexRolloutFiles(codexHome: string): CodexRolloutFile[] {
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return [];
  const days: string[] = [];
  for (const year of childDirectories(root)) {
    for (const month of childDirectories(year)) {
      days.push(...childDirectories(month));
    }
  }
  return rolloutFilesInDays(days);
}

function listTodayCodexRolloutFiles(codexHome: string, now: number): CodexRolloutFile[] {
  const date = new Date(now);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return rolloutFilesInDays([join(codexHome, 'sessions', year, month, day)]);
}

function refreshKnownRollout(path: string): CodexRolloutFile | undefined {
  const sessionId = codexSessionIdFromRolloutPath(basename(path));
  if (!sessionId) return undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    return { path, sessionId, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

function parseTerminalLine(line: string): RolloutTerminal | undefined {
  let row: any;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (row?.type !== 'event_msg' || !row.payload || typeof row.payload !== 'object') {
    return undefined;
  }
  const payload = row.payload as Record<string, unknown>;
  const status: CodexTaskStatus | undefined = payload.type === 'task_complete'
    ? 'completed'
    : payload.type === 'turn_aborted'
      ? 'cancelled'
      : undefined;
  if (!status || typeof payload.turn_id !== 'string' || !payload.turn_id) return undefined;
  if (typeof row.timestamp !== 'string') return undefined;
  const completedAtMs = Date.parse(row.timestamp);
  if (!Number.isFinite(completedAtMs)) return undefined;
  return {
    turnId: payload.turn_id,
    status,
    completedAt: new Date(completedAtMs).toISOString(),
    completedAtMs,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export interface CodexRolloutCompletionMonitorOptions {
  dataDir: string;
  signal?: AbortSignal;
  codexHome?: string;
  pollIntervalMs?: number;
  fullReconcileIntervalMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'debug' | 'warn'>;
  readConfig?: () => ResolvedCodexNotifierConfig;
  detectLockState?: () => ScreenLockState;
  enqueue?: typeof enqueueCodexNotifierEvent;
  listRollouts?: (codexHome: string) => CodexRolloutFile[];
  listTodayRollouts?: (codexHome: string, now: number) => CodexRolloutFile[];
}

/** 监听普通 Codex App rollout，补齐启动 Hook 前已打开的长驻会话。 */
export class CodexRolloutCompletionMonitor {
  private readonly codexHome: string;
  private readonly pollIntervalMs: number;
  private readonly fullReconcileIntervalMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'debug' | 'warn'>;
  private readonly readConfig: () => ResolvedCodexNotifierConfig;
  private readonly detectLockState: () => ScreenLockState;
  private readonly enqueue: typeof enqueueCodexNotifierEvent;
  private readonly listRollouts: (codexHome: string) => CodexRolloutFile[];
  private readonly listTodayRollouts: (codexHome: string, now: number) => CodexRolloutFile[];
  private readonly offsets = new Map<string, number>();
  private observationStartedAt: number | undefined;
  private lastFullReconcileAt: number | undefined;

  constructor(private readonly options: CodexRolloutCompletionMonitorOptions) {
    const configuredCodexHome = process.env.CODEX_HOME?.trim();
    this.codexHome = options.codexHome
      ?? (configuredCodexHome || undefined)
      ?? join(homedir(), '.codex');
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error('codex_rollout_monitor_interval_invalid');
    }
    this.fullReconcileIntervalMs = options.fullReconcileIntervalMs
      ?? DEFAULT_FULL_RECONCILE_INTERVAL_MS;
    if (!Number.isSafeInteger(this.fullReconcileIntervalMs) || this.fullReconcileIntervalMs <= 0) {
      throw new Error('codex_rollout_monitor_reconcile_interval_invalid');
    }
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.readConfig = options.readConfig ?? resolveCodexNotifierConfig;
    this.detectLockState = options.detectLockState ?? detectScreenLock;
    this.enqueue = options.enqueue ?? enqueueCodexNotifierEvent;
    this.listRollouts = options.listRollouts ?? listCodexRolloutFiles;
    this.listTodayRollouts = options.listTodayRollouts ?? listTodayCodexRolloutFiles;
  }

  private stopObservation(): void {
    this.offsets.clear();
    this.observationStartedAt = undefined;
    this.lastFullReconcileAt = undefined;
  }

  pollOnce(): void {
    const config = this.readConfig();
    if (!config.enabled || !config.targetBotAppId) {
      this.stopObservation();
      return;
    }

    const now = this.now();
    const fullReconcile = this.lastFullReconcileAt === undefined
      || now - this.lastFullReconcileAt >= this.fullReconcileIntervalMs;
    const discovered = fullReconcile
      ? this.listRollouts(this.codexHome)
      : this.listTodayRollouts(this.codexHome, now);
    if (fullReconcile) this.lastFullReconcileAt = now;

    const filesByPath = new Map(discovered.map(file => [file.path, file]));
    if (!fullReconcile) {
      for (const path of this.offsets.keys()) {
        if (filesByPath.has(path)) continue;
        const refreshed = refreshKnownRollout(path);
        if (refreshed) filesByPath.set(path, refreshed);
        else this.offsets.delete(path);
      }
    }
    const files = [...filesByPath.values()]
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
      .slice(0, MAX_TRACKED_ROLLOUTS);
    if (this.observationStartedAt === undefined) {
      this.observationStartedAt = now;
      for (const file of files) {
        this.offsets.set(file.path, baselineJsonlCursor(file.path).newOffset);
      }
      return;
    }

    if (fullReconcile) {
      const present = new Set(files.map(file => file.path));
      for (const path of this.offsets.keys()) {
        if (!present.has(path)) this.offsets.delete(path);
      }
    }

    for (const file of files) {
      let offset = this.offsets.get(file.path);
      if (offset === undefined) offset = 0;
      if (file.size < offset) {
        this.offsets.set(file.path, baselineJsonlCursor(file.path).newOffset);
        continue;
      }

      let retryOffset: number | undefined;
      const scanned = scanJsonlFromOffset(file.path, offset, {
        onLine: (line, lineStart) => {
          if (retryOffset !== undefined) return;
          const terminal = parseTerminalLine(line);
          if (!terminal || terminal.completedAtMs < this.observationStartedAt!) return;
          const context = readCodexTurnContext(file.path, terminal.turnId, file.sessionId);
          if (
            context.clientSurface !== 'codex-app'
            || !context.cwd
            || !context.prompt
            || context.internal
            || isInternalCodexPrompt(context.prompt)
          ) {
            return;
          }
          const lockState = config.notifyWhen === 'always'
            ? 'unlocked'
            : this.detectLockState();
          if (!shouldNotifyForLockState(config.notifyWhen, lockState)) return;
          try {
            const event = createCodexNotifierCompletionEvent({
              threadId: file.sessionId,
              nativeTurnId: terminal.turnId,
              status: terminal.status,
              cwd: context.cwd,
              clientSurface: 'codex-app',
              title: context.prompt,
              finalPreview: context.lastAssistantMessage,
              completedAt: terminal.completedAt,
            });
            this.enqueue(
              this.options.dataDir,
              config.targetBotAppId!,
              event,
              config.targetChatId,
            );
            this.logger.debug(
              `[codex-notifier] 旧 Codex App 会话完成事件已入队: ${event.eventId.slice(0, 12)}`,
            );
          } catch (error) {
            retryOffset = lineStart;
            this.logger.warn(
              `[codex-notifier] rollout 完成事件入队失败，将重试: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        },
        onError: error => {
          this.logger.warn(
            `[codex-notifier] rollout 增量读取失败: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      });
      if (scanned) this.offsets.set(file.path, retryOffset ?? scanned.newOffset);
    }
  }

  async run(): Promise<void> {
    while (!this.options.signal?.aborted) {
      try {
        this.pollOnce();
      } catch (error) {
        this.logger.warn(
          `[codex-notifier] rollout 监听轮询失败: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      await delay(this.pollIntervalMs, this.options.signal);
    }
  }
}

export async function runCodexRolloutCompletionMonitor(
  options: CodexRolloutCompletionMonitorOptions,
): Promise<void> {
  await new CodexRolloutCompletionMonitor(options).run();
}

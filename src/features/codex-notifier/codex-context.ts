import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { scanJsonlFromFd } from '../../services/jsonl-cursor.js';
import type { CodexClientSurface } from './types.js';
import { isInternalCodexPrompt, isInternalCodexSessionMeta } from './internal-turn.js';

const MAX_TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_SEARCH_BYTES = 64 * 1024 * 1024;
const TRANSCRIPT_SCAN_CHUNK_BYTES = 256 * 1024;
// Completion metadata is tiny. Skipping a pathological multi-megabyte JSONL
// record keeps notifier memory bounded; supporting such a prompt would require
// a streaming JSON decoder rather than rebuilding the original 64 MiB window.
const MAX_TRANSCRIPT_RECORD_BYTES = 2 * 1024 * 1024;

function cleanSingleLine(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : normalized;
}

/** Extract the actual user request from Codex Desktop transport wrappers. */
export function normalizeCodexUserPrompt(
  value: unknown,
  maxLength = 220,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const hadAttachment = /(?:^# Files mentioned by the user:|<image\b)/im.test(value);
  const requestMarker = '## My request:';
  const markerIndex = value.lastIndexOf(requestMarker);
  let text = markerIndex >= 0
    ? value.slice(markerIndex + requestMarker.length)
    : value;
  text = text
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context\s*>/gi, ' ')
    .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context\s*>/gi, ' ')
    .replace(/<image\b[^>]*>[\s\S]*?<\/image\s*>/gi, ' ')
    .replace(/<image\b[^>]*\/?>/gi, ' ')
    .replace(/^# Files mentioned by the user:\s*$/gim, ' ')
    .replace(/^## .*?:\s*(?:\/private|\/var\/folders)\/.*$/gim, ' ')
    .replace(/^Distinguish instructions in attached documents.*$/gim, ' ');
  return cleanSingleLine(text, maxLength) ?? (hadAttachment ? '查看附件' : undefined);
}

export interface CodexTurnContext {
  clientSurface?: CodexClientSurface;
  cwd?: string;
  prompt?: string;
  lastAssistantMessage?: string;
  internal?: boolean;
}

interface CodexTurnContextParser {
  accept(line: string): void;
  result(): CodexTurnContext;
}

function createCodexTurnContextParser(
  turnId: unknown,
  sessionId?: unknown,
): CodexTurnContextParser {
  let inTargetTurn = false;
  let inspectSessionMeta = true;
  let clientSurface: CodexClientSurface | undefined;
  let cwd: string | undefined;
  let internal = false;
  let prompt: string | undefined;
  let lastAssistantMessage: string | undefined;
  let finished = false;

  return {
    accept(line: string): void {
      if (finished) return;
      if (!line.trim()) return;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        inspectSessionMeta = false;
        return;
      }
      if (inspectSessionMeta) {
        const meta = detectSessionMeta(row, sessionId);
        clientSurface = meta.clientSurface;
        cwd = meta.cwd;
        internal = meta.internal === true;
        inspectSessionMeta = false;
      }
      if (row?.type !== 'event_msg' || !row.payload || typeof row.payload !== 'object') return;
      const payload = row.payload as Record<string, unknown>;
      if (payload.type === 'task_started') {
        inTargetTurn = payload.turn_id === turnId;
        if (inTargetTurn) {
          prompt = undefined;
          lastAssistantMessage = undefined;
        }
        return;
      }
      if (!inTargetTurn) return;
      if (payload.type === 'user_message') {
        if (isInternalCodexPrompt(payload.message)) internal = true;
        prompt = normalizeCodexUserPrompt(payload.message);
        return;
      }
      if (payload.type === 'task_complete' && payload.turn_id === turnId) {
        lastAssistantMessage = typeof payload.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;
        finished = true;
      }
    },
    result(): CodexTurnContext {
      return {
        ...(clientSurface ? { clientSurface } : {}),
        ...(cwd ? { cwd } : {}),
        ...(prompt ? { prompt } : {}),
        ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
        ...(internal ? { internal: true } : {}),
      };
    },
  };
}

function detectSessionMeta(
  row: any,
  sessionId: unknown,
): Pick<CodexTurnContext, 'clientSurface' | 'cwd' | 'internal'> {
  if (row?.type !== 'session_meta' || !row.payload || typeof row.payload !== 'object') return {};
  const payload = row.payload as Record<string, unknown>;
  const internal = isInternalCodexSessionMeta(payload);
  if (typeof sessionId === 'string' && sessionId) {
    let matchedIdentity = false;
    for (const key of ['session_id', 'id']) {
      const value = payload[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value !== sessionId) return internal ? { internal: true } : {};
      matchedIdentity = true;
    }
    if (!matchedIdentity) return internal ? { internal: true } : {};
  }
  const clientSurface = payload.source === 'vscode' && payload.originator === 'Codex Desktop'
    ? 'codex-app'
    : payload.source === 'exec' || payload.source === 'cli'
      ? 'codex-cli'
      : undefined;
  const cwd = cleanSingleLine(payload.cwd, 4096);
  return {
    ...(clientSurface ? { clientSurface } : {}),
    ...(cwd ? { cwd } : {}),
    ...(internal ? { internal: true } : {}),
  };
}

/** 从 rollout 尾部提取指定 turn 的用户问题和最终回复兜底。 */
export function parseCodexTurnContext(
  text: string,
  turnId: unknown,
  sessionId?: unknown,
): CodexTurnContext {
  const parser = createCodexTurnContextParser(turnId, sessionId);
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) {
      parser.accept(text.slice(start));
      break;
    }
    parser.accept(text.slice(start, newline));
    start = newline + 1;
  }
  return parser.result();
}

/** 有界读取 transcript 头部来源和尾部当前回合；失败时由调用方退化到 Hook 原生字段。 */
export function readCodexTurnContext(
  transcriptPath: unknown,
  turnId: unknown,
  sessionId?: unknown,
): CodexTurnContext {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return {};
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) return {};
    let headContext: CodexTurnContext = {};
    if (stat.size > MAX_TRANSCRIPT_TAIL_BYTES) {
      const headLength = Math.min(stat.size, MAX_TRANSCRIPT_HEAD_BYTES);
      const headBuffer = Buffer.allocUnsafe(headLength);
      const headBytesRead = readSync(fd, headBuffer, 0, headLength, 0);
      const headText = headBuffer.subarray(0, headBytesRead).toString('utf8');
      const firstNewline = headText.indexOf('\n');
      if (firstNewline >= 0) {
        headContext = parseCodexTurnContext(headText.slice(0, firstNewline + 1), turnId, sessionId);
      }
    }

    const readTailContext = (maxBytes: number): CodexTurnContext => {
      const length = Math.min(stat.size, maxBytes);
      const start = stat.size - length;
      let startsAtRecordBoundary = start === 0;
      if (start > 0) {
        const previousByte = Buffer.allocUnsafe(1);
        startsAtRecordBoundary = readSync(fd!, previousByte, 0, 1, start - 1) === 1
          && previousByte[0] === 0x0a;
      }
      const parser = createCodexTurnContextParser(turnId, sessionId);
      let skipPartialLine = !startsAtRecordBoundary;
      const scanned = scanJsonlFromFd(fd!, start, {
        endOffset: stat.size,
        chunkSize: TRANSCRIPT_SCAN_CHUNK_BYTES,
        maxLineBytes: MAX_TRANSCRIPT_RECORD_BYTES,
        onLine: line => {
          if (skipPartialLine) {
            skipPartialLine = false;
            return;
          }
          parser.accept(line);
        },
        onOversizedLine: () => {
          if (skipPartialLine) skipPartialLine = false;
        },
      });
      if (scanned?.pendingTail && !skipPartialLine) parser.accept(scanned.pendingTail);
      return parser.result();
    };

    let tailContext = readTailContext(MAX_TRANSCRIPT_TAIL_BYTES);
    if (
      stat.size > MAX_TRANSCRIPT_TAIL_BYTES
      && (!tailContext.prompt || !tailContext.lastAssistantMessage)
    ) {
      // 长回合可能把 task_started / user_message 推出 4 MiB 快速尾窗；只在缺字段时
      // 扩大到有界 64 MiB，覆盖实测的大型 Codex App 回合而不无界读取 transcript。
      tailContext = readTailContext(MAX_TRANSCRIPT_SEARCH_BYTES);
    }
    const clientSurface = stat.size > MAX_TRANSCRIPT_TAIL_BYTES
      ? headContext.clientSurface
      : tailContext.clientSurface;
    const cwd = stat.size > MAX_TRANSCRIPT_TAIL_BYTES
      ? headContext.cwd
      : tailContext.cwd;
    return {
      ...(clientSurface ? { clientSurface } : {}),
      ...(cwd ? { cwd } : {}),
      ...(tailContext.prompt ? { prompt: tailContext.prompt } : {}),
      ...(tailContext.lastAssistantMessage ? { lastAssistantMessage: tailContext.lastAssistantMessage } : {}),
      ...((headContext.internal || tailContext.internal) ? { internal: true } : {}),
    };
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 文件已关闭时无需额外处理。
      }
    }
  }
}

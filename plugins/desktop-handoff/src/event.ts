import { createHash } from 'node:crypto';
import type { DesktopTurnCompletion } from './desktop-ipc.js';
import type { CompletionEvent, DesktopIdentity } from './types.js';

const INTERNAL_PROMPTS = [
  /^\s*You\s+are\s+a\s+helpful\s+assistant\.\s+You\s+will\s+be\s+presented\s+with\s+a\s+user\s+prompt,\s+and\s+your\s+job\s+is\s+to\s+provide\s+a\s+short\s+title\s+for\s+a\s+task\b/i,
  /^\s*Generate\s+\d+\s+to\s+\d+\s+ambient\s+suggestions\b/i,
  /^\s*#\s*Overview\s+Generate\s+\d+\s+to\s+\d+\s+hyperpersonalized\s+suggestions\b/i,
  /^\s*You\s+are\s+an\s+expert\s+at\s+upholding\s+safety\s+and\s+compliance\s+standards\s+for\s+Codex\s+ambient\s+suggestions\b/i,
  /^\s*You\s+are\s+a\s+helpful\s+assistant\.\s*Generate\s+a\s+pull\s+request\s+title\s+and\s+body\b/i,
  /^\s*You\s+are\s+writing\s+a\s+short\s+summary\s+of\s+a\s+final\s+assistant\s+message\b/i,
  /^\s*Using\s+the\s+current\s+thread\s+context\s+and\s+the\s+diff\s+below,\s*generate\s+a\s+single-line\s+git\s+commit\s+message\b/i,
  /^\s*##\s+Memory\s+Writing\s+Agent\s*:/i,
  /^\s*You\s+are\s+judging\s+one\s+planned\s+coding-agent\s+action\b/i,
  /^\s*The\s+following\s+is\s+the\s+Codex\s+agent\s+history\b/i,
  /##\s*GDPA\s+Agent\s+Box\s+Runtime\b/i,
];
const DESKTOP_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isInternalPrompt(prompt: string): boolean {
  return INTERNAL_PROMPTS.some(pattern => pattern.test(prompt));
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, max).join('');
}

export function completionFromHook(
  identity: DesktopIdentity,
  raw: unknown,
  confirmedPrompt: string,
  cwdFromMeta?: string,
): CompletionEvent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const hook = raw as Record<string, unknown>;
  if (hook.hook_event_name !== 'Stop') return undefined;
  const threadId = text(hook.session_id, 256);
  const nativeTurnId = text(hook.turn_id, 256);
  if (!threadId || threadId !== identity.threadId || !DESKTOP_THREAD_ID.test(threadId) || !nativeTurnId) return undefined;
  const cwd = text(hook.cwd, 2_048) ?? cwdFromMeta ?? '';
  const title = text(confirmedPrompt, 180) ?? `${identity.provider === 'traex' ? 'TraeX' : 'Codex'} 任务`;
  const finalPreview = text(hook.last_assistant_message, 6_500) ?? '任务已完成。';
  const completedAt = new Date().toISOString();
  const eventId = createHash('sha256')
    .update(JSON.stringify([identity.larkAppId, identity.provider, threadId, nativeTurnId, 'completed']))
    .digest('hex');
  return {
    ...identity,
    eventId,
    nativeTurnId,
    cwd,
    title,
    finalPreview,
    status: 'completed',
    completedAt,
  };
}

export function completionFromDesktopTurn(
  identity: DesktopIdentity,
  prompt: string,
  completion: DesktopTurnCompletion,
): CompletionEvent {
  const completedAt = new Date().toISOString();
  const eventId = createHash('sha256')
    .update(JSON.stringify([
      identity.larkAppId,
      identity.provider,
      identity.threadId,
      completion.turnId,
      completion.status,
    ]))
    .digest('hex');
  return {
    ...identity,
    eventId,
    nativeTurnId: completion.turnId,
    cwd: completion.cwd,
    title: text(completion.title, 180)
      ?? text(prompt, 180)
      ?? `${identity.provider === 'traex' ? 'TraeX' : 'Codex'} 任务`,
    finalPreview: text(completion.finalText, 6_500)
      ?? (completion.status === 'completed' ? '任务已完成。' : '任务未完成。'),
    status: completion.status,
    completedAt,
  };
}

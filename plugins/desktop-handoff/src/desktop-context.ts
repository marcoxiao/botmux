import { open } from 'node:fs/promises';
import type { DesktopProvider } from './types.js';

// Desktop session_meta embeds tool definitions and can exceed 1 MiB. Keep a
// finite ceiling because transcript_path originates outside the plugin; raise
// this single limit if a desktop release grows beyond it.
const SESSION_META_READ_LIMIT = 4 * 1024 * 1024;

export interface DesktopContext {
  desktop: boolean;
  cwd?: string;
  normalizePrompt(prompt: unknown): string | undefined;
}

function cleanPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let prompt = value
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, ' ')
    .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/gi, ' ')
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, ' ');
  const request = prompt.match(/(?:^|\n)##\s*My request:\s*([\s\S]*)$/i);
  if (request) prompt = request[1] ?? '';
  prompt = prompt
    .replace(/(?:^|\n)#\s*Files mentioned by the user:[\s\S]*?(?=\n#{1,3}\s|$)/gi, ' ')
    .replace(/\/?(?:private|var\/folders|Users)\/[^\s]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!prompt) return undefined;
  return Array.from(prompt).slice(0, 300).join('');
}

async function readSessionMeta(path: string): Promise<Record<string, unknown> | undefined> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(SESSION_META_READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { type?: unknown; payload?: unknown };
        if (parsed.type === 'session_meta' && parsed.payload && typeof parsed.payload === 'object') {
          return parsed.payload as Record<string, unknown>;
        }
      } catch {
        // A partially written trailing line is not a valid provenance record.
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

function matchesSession(meta: Record<string, unknown>, expectedSessionId?: string): boolean {
  if (expectedSessionId === undefined) return true;
  let matched = false;
  for (const key of ['session_id', 'id']) {
    if (meta[key] === undefined) continue;
    if (meta[key] !== expectedSessionId) return false;
    matched = true;
  }
  return matched;
}

export async function readDesktopContext(
  transcriptPath: unknown,
  expectedSessionId: string | undefined,
  provider: DesktopProvider,
): Promise<DesktopContext> {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) {
    return { desktop: false, normalizePrompt: cleanPrompt };
  }
  try {
    const meta = await readSessionMeta(transcriptPath);
    const desktop = !!meta && matchesSession(meta, expectedSessionId) && provider.matchesMeta(meta);
    return {
      desktop,
      ...(typeof meta?.cwd === 'string' && meta.cwd.trim() ? { cwd: meta.cwd.trim() } : {}),
      normalizePrompt: cleanPrompt,
    };
  } catch {
    return { desktop: false, normalizePrompt: cleanPrompt };
  }
}

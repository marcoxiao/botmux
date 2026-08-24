import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig, DesktopProvider } from './types.js';

function userDesktopThread(meta: Record<string, unknown>): boolean {
  return (meta.thread_source === undefined || meta.thread_source === 'user')
    && meta.internal !== true
    && meta.subagent !== true;
}

export const CODEX_PROVIDER: DesktopProvider = Object.freeze({
  id: 'codex',
  productName: 'Codex',
  socketPath: () => join(homedir(), '.codex', 'ipc', 'ipc.sock'),
  matchesMeta: (meta: Record<string, unknown>) => meta.source === 'vscode'
    && meta.originator === 'Codex Desktop'
    && meta.model_provider !== 'trae'
    && userDesktopThread(meta),
});

export const TRAEX_PROVIDER: DesktopProvider = Object.freeze({
  id: 'traex',
  productName: 'TraeX',
  socketPath: () => join(homedir(), '.trae', 'cli', 'ipc', 'ipc.sock'),
  matchesMeta: (meta: Record<string, unknown>) => (meta.source === 'vscode' || meta.source === 'cli')
    && meta.originator === 'Codex Desktop'
    && meta.model_provider === 'trae'
    && userDesktopThread(meta),
});

const PROVIDERS = Object.freeze({
  codex: CODEX_PROVIDER,
  traex: TRAEX_PROVIDER,
});

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function resolveBotConfig(rawConfig: unknown, larkAppId: string): BotConfig | undefined {
  if (!larkAppId.trim()) return undefined;
  const bots = record(record(rawConfig)?.bots);
  const rawBot = record(bots?.[larkAppId]);
  const providerId = rawBot?.provider;
  const workbenchChatId = rawBot?.workbenchChatId;
  if ((providerId !== 'codex' && providerId !== 'traex')
    || typeof workbenchChatId !== 'string'
    || !workbenchChatId.trim()) {
    return undefined;
  }
  return {
    larkAppId,
    workbenchChatId: workbenchChatId.trim(),
    provider: PROVIDERS[providerId],
  };
}

export function providerById(id: unknown): DesktopProvider | undefined {
  return id === 'codex' || id === 'traex' ? PROVIDERS[id] : undefined;
}

import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function codexNotifierRoot(dataDir: string): string {
  return join(dataDir, 'codex-notifier');
}

export function codexNotifierOutboxDir(dataDir: string): string {
  return join(codexNotifierRoot(dataDir), 'outbox');
}

export function codexNotifierDeadLetterDir(dataDir: string): string {
  return join(codexNotifierRoot(dataDir), 'dead-letter');
}

export function codexNotifierConfirmedTurnsDir(dataDir: string): string {
  return join(codexNotifierRoot(dataDir), 'confirmed-turns');
}

export function codexNotifierWorkerStatePath(dataDir: string): string {
  return join(codexNotifierRoot(dataDir), 'worker-state.json');
}

export function codexNotifierWorkerLockPath(dataDir: string): string {
  return join(codexNotifierRoot(dataDir), 'worker.lock');
}

export function codexNotifierTopicRoutesPath(dataDir: string, larkAppId: string): string {
  const suffix = createHash('sha256').update(larkAppId).digest('hex').slice(0, 16);
  return join(dataDir, 'plugin-events', `codex-notifier-topic-routes-${suffix}.json`);
}

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexNotifierEventStore } from '../src/features/codex-notifier/event-store.js';
import { CodexNotifierTopicRouteStore } from '../src/features/codex-notifier/topic-route-store.js';
import { openCodexNotifierStoreWithRecovery } from '../src/features/codex-notifier/store-recovery.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Codex notifier store recovery', () => {
  it.each([
    ['event', (file: string) => new CodexNotifierEventStore(file)],
    ['route', (file: string) => new CodexNotifierTopicRouteStore(file)],
  ])('quarantines a corrupt %s store and recreates an empty store', (_kind, open) => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-store-recovery-'));
    tempDirs.push(dir);
    const file = join(dir, 'store.json');
    writeFileSync(file, '{broken-json', { mode: 0o600 });
    const warn = vi.fn();

    const store = openCodexNotifierStoreWithRecovery({
      filePath: file,
      open: () => open(file),
      logWarn: warn,
      now: () => Date.parse('2026-08-23T03:00:00.000Z'),
    });

    expect(store).toBeDefined();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([
      'store.json.corrupt-20260823T030000000Z',
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('已隔离'));
  });

  it('does not hide constructor failures when no persisted file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-store-recovery-'));
    tempDirs.push(dir);
    const file = join(dir, 'missing.json');

    expect(() => openCodexNotifierStoreWithRecovery({
      filePath: file,
      open: () => { throw new Error('programming error'); },
      logWarn: vi.fn(),
    })).toThrow('programming error');
  });
});

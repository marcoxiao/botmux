import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

describe('Codex Desktop handoff native-only boundary', () => {
  it('不再保留私有 Desktop follower 数据面', () => {
    const retiredClient = ['desktop', 'ipc', 'client'].join('-');
    const retiredProtocol = ['desktop', 'ipc', 'protocol'].join('-');
    expect(existsSync(resolve(ROOT, `src/features/codex-notifier/${retiredClient}.ts`))).toBe(false);
    expect(existsSync(resolve(ROOT, `src/features/codex-notifier/${retiredProtocol}.ts`))).toBe(false);
    const retiredTransportField = ['codex', 'App', 'Transport'].join('');
    for (const path of [
      'src/types.ts',
      'src/core/command-handler.ts',
      'src/core/session-manager.ts',
      'src/core/worker-pool.ts',
      'src/daemon.ts',
    ]) {
      expect(readFileSync(resolve(ROOT, path), 'utf8')).not.toContain(retiredTransportField);
    }
  });
});

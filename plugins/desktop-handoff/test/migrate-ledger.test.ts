import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DesktopHandoffStore } from '../src/store.js';

const execute = promisify(execFile);
const SCRIPT = join(process.cwd(), 'scripts', 'migrate-ledger-v2.mjs');
const CODEX_APP_ID = 'cli_codex';
const CODEX = { larkAppId: CODEX_APP_ID, provider: 'codex' as const, threadId: 'thread-1' };

function v1Ledger() {
  return {
    version: 1,
    confirmedTurns: {
      ['thread-1\u0000turn-pending']: { prompt: '继续检查', createdAt: Date.now() },
    },
    events: {
      'event-1': {
        eventId: 'event-1', threadId: 'thread-1', nativeTurnId: 'turn-1', cwd: '/workspace/app',
        title: '检查架构', finalPreview: '完成', status: 'completed', completedAt: '2026-08-23T00:00:00.000Z',
        recordedAt: 1_777_000_000_001, delivery: 'delivered',
      },
    },
    threads: {
      'thread-1': {
        rootEventId: 'event-1', rootMessageId: 'om_root', latestEventId: 'event-1',
        updatedAt: 1_777_000_000_002, adoptedAt: 1_777_000_000_003,
      },
    },
  };
}

describe('migrate-ledger-v2', () => {
  it('一次性保留现有 Codex 话题、事件、待确认轮次和接管状态', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-handoff-migrate-'));
    const path = join(dir, 'ledger.json');
    await writeFile(path, `${JSON.stringify(v1Ledger())}\n`, { mode: 0o600 });

    await execute(process.execPath, [SCRIPT, '--ledger', path, '--codex-app-id', CODEX_APP_ID]);

    const migrated = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
    expect(migrated.version).toBe(2);
    expect(Object.values(migrated.events)).toContainEqual(expect.objectContaining(CODEX));
    expect(Object.values(migrated.threads)).toContainEqual(expect.objectContaining({
      ...CODEX,
      rootEventId: 'event-1', rootMessageId: 'om_root', latestEventId: 'event-1',
      adoptedAt: 1_777_000_000_003,
    }));

    const store = new DesktopHandoffStore(path);
    await expect(store.confirmedTurn(CODEX, 'turn-pending')).resolves.toBe('继续检查');
    await expect(store.resolveTakeover(CODEX_APP_ID, 'event-1')).resolves.toMatchObject({
      route: { rootMessageId: 'om_root', adoptedAt: 1_777_000_000_003 },
    });
  });

  it('输入无效时拒绝迁移且源文件逐字节不变', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-handoff-migrate-'));
    const path = join(dir, 'ledger.json');
    const source = '{"version":1,"confirmedTurns":{},"events":{},"threads":{"thread-1":{"latestEventId":"missing","updatedAt":1}}}\n';
    await writeFile(path, source, { mode: 0o600 });

    await expect(execute(process.execPath, [SCRIPT, '--ledger', path, '--codex-app-id', CODEX_APP_ID]))
      .rejects.toThrow();
    await expect(readFile(path, 'utf8')).resolves.toBe(source);
  });

  it('拒绝重复或额外参数，避免迁移目标被静默覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-handoff-migrate-'));
    const path = join(dir, 'ledger.json');
    const source = `${JSON.stringify(v1Ledger())}\n`;
    await writeFile(path, source, { mode: 0o600 });

    await expect(execute(process.execPath, [
      SCRIPT,
      '--ledger', path,
      '--codex-app-id', CODEX_APP_ID,
      '--codex-app-id', 'cli_unexpected',
    ])).rejects.toThrow();
    await expect(readFile(path, 'utf8')).resolves.toBe(source);
  });
});

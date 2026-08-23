import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRolloutCompletionMonitor } from '../src/features/codex-notifier/rollout-monitor.js';

const THREAD_ID = '01a023fd-2d01-7443-98be-0b3a1277af8f';
const TURN_ID = '01a02c61-e59f-7c23-b674-9f726c37c609';
const COMPLETED_AT = '2026-08-23T02:25:16.748Z';

function row(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function sessionMeta(source: 'vscode' | 'cli' = 'vscode'): string {
  return row({
    timestamp: '2026-08-21T11:03:46.815Z',
    type: 'session_meta',
    payload: {
      session_id: THREAD_ID,
      id: THREAD_ID,
      cwd: '/workspace/project',
      source,
      originator: source === 'vscode' ? 'Codex Desktop' : 'Codex CLI',
    },
  });
}

function terminalTurn(): string {
  return [
    row({
      timestamp: '2026-08-23T02:10:08.428Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: TURN_ID },
    }),
    row({
      timestamp: '2026-08-23T02:10:10.836Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '修复旧会话漏报' },
    }),
    row({
      timestamp: COMPLETED_AT,
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: TURN_ID, last_agent_message: '已经修复' },
    }),
  ].join('');
}

function rolloutPath(codexHome: string): string {
  const dir = join(codexHome, 'sessions', '2026', '08', '21');
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-2026-08-21T19-03-09-${THREAD_ID}.jsonl`);
}

function monitor(codexHome: string, enqueue = vi.fn()) {
  return {
    enqueue,
    instance: new CodexRolloutCompletionMonitor({
      dataDir: '/tmp/botmux-rollout-monitor-test',
      codexHome,
      now: () => Date.parse('2026-08-23T02:20:00.000Z'),
      readConfig: () => ({
        enabled: true,
        targetBotAppId: 'cli_target',
        targetChatId: 'oc_workbench',
        notifyWhen: 'always',
      }),
      logger: { debug: () => undefined, warn: () => undefined },
      enqueue,
    }),
  };
}

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Codex rollout completion monitor', () => {
  it('does not perform a full historical discovery on every fast poll', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'botmux-rollout-monitor-cadence-'));
    temporaryDirs.push(codexHome);
    let now = Date.parse('2026-08-23T02:20:00.000Z');
    const listRollouts = vi.fn(() => []);
    const instance = new CodexRolloutCompletionMonitor({
      dataDir: '/tmp/botmux-rollout-monitor-test',
      codexHome,
      now: () => now,
      readConfig: () => ({
        enabled: true,
        targetBotAppId: 'cli_target',
        targetChatId: 'oc_workbench',
        notifyWhen: 'always',
      }),
      logger: { debug: () => undefined, warn: () => undefined },
      enqueue: vi.fn(),
      listRollouts,
    });

    instance.pollOnce();
    instance.pollOnce();
    expect(listRollouts).toHaveBeenCalledTimes(1);

    now += 60_000;
    instance.pollOnce();
    expect(listRollouts).toHaveBeenCalledTimes(2);
  });

  it('baselines history and enqueues only a later App completion', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'botmux-rollout-monitor-'));
    temporaryDirs.push(codexHome);
    const file = rolloutPath(codexHome);
    writeFileSync(file, `${sessionMeta()}${terminalTurn()}`);
    const { instance, enqueue } = monitor(codexHome);

    instance.pollOnce();
    expect(enqueue).not.toHaveBeenCalled();

    const nextTurn = terminalTurn()
      .replaceAll(TURN_ID, '01a02c61-e59f-7c23-b674-9f726c37c610')
      .replace('修复旧会话漏报', '完成上线后的新任务');
    appendFileSync(file, nextTurn);
    instance.pollOnce();

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      '/tmp/botmux-rollout-monitor-test',
      'cli_target',
      expect.objectContaining({
        clientSurface: 'codex-app',
        nativeTurnId: '01a02c61-e59f-7c23-b674-9f726c37c610',
        title: '完成上线后的新任务',
        finalPreview: '已经修复',
        cwd: '/workspace/project',
      }),
      'oc_workbench',
    );
  });

  it('ignores new CLI rollouts even when they complete after observation starts', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'botmux-rollout-monitor-cli-'));
    temporaryDirs.push(codexHome);
    const { instance, enqueue } = monitor(codexHome);
    instance.pollOnce();

    writeFileSync(rolloutPath(codexHome), `${sessionMeta('cli')}${terminalTurn()}`);
    instance.pollOnce();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('retries the same terminal line when durable enqueue fails', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'botmux-rollout-monitor-retry-'));
    temporaryDirs.push(codexHome);
    const file = rolloutPath(codexHome);
    writeFileSync(file, sessionMeta());
    const enqueue = vi.fn()
      .mockImplementationOnce(() => { throw new Error('disk unavailable'); })
      .mockImplementationOnce(() => '/outbox/event.json');
    const { instance } = monitor(codexHome, enqueue);
    instance.pollOnce();

    appendFileSync(file, terminalTurn());
    instance.pollOnce();
    instance.pollOnce();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]?.[2]?.eventId).toBe(enqueue.mock.calls[1]?.[2]?.eventId);
  });

  it('does not backfill turns that completed while the notifier was disabled', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'botmux-rollout-monitor-disabled-'));
    temporaryDirs.push(codexHome);
    const file = rolloutPath(codexHome);
    writeFileSync(file, sessionMeta());
    let enabled = false;
    const enqueue = vi.fn();
    const instance = new CodexRolloutCompletionMonitor({
      dataDir: '/tmp/botmux-rollout-monitor-test',
      codexHome,
      now: () => Date.parse('2026-08-23T02:20:00.000Z'),
      readConfig: () => ({
        enabled,
        targetBotAppId: 'cli_target',
        targetChatId: 'oc_workbench',
        notifyWhen: 'always',
      }),
      logger: { debug: () => undefined, warn: () => undefined },
      enqueue,
    });

    instance.pollOnce();
    appendFileSync(file, terminalTurn());
    enabled = true;
    instance.pollOnce();
    instance.pollOnce();

    expect(enqueue).not.toHaveBeenCalled();
  });
});

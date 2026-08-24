import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { completionFromDesktopTurn } from '../src/event.js';
import { DesktopHandoffStore } from '../src/store.js';
import type { CompletionEvent, DesktopIdentity } from '../src/types.js';

const CODEX: DesktopIdentity = { larkAppId: 'cli_codex', provider: 'codex', threadId: 'thread-1' };
const TRAEX: DesktopIdentity = { larkAppId: 'cli_traex', provider: 'traex', threadId: 'thread-1' };

function event(identity: DesktopIdentity, eventId = 'event-1', turnId = 'turn-1'): CompletionEvent {
  return {
    ...identity,
    eventId,
    nativeTurnId: turnId,
    cwd: '/workspace/app',
    title: '检查架构',
    finalPreview: '完成',
    status: 'completed',
    completedAt: '2026-08-23T00:00:00.000Z',
  };
}

describe('DesktopHandoffStore', () => {
  it('原子保存用户轮次证明、事件和话题根消息', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-handoff-store-'));
    const store = new DesktopHandoffStore(join(dir, 'ledger.json'));
    await store.confirmTurn(CODEX, 'turn-1', '检查架构');
    expect(await store.consumeConfirmedTurn(CODEX, 'turn-1')).toBe('检查架构');
    expect(await store.consumeConfirmedTurn(CODEX, 'turn-1')).toBeUndefined();

    const first = event(CODEX);
    expect(await store.recordEvent(first)).toEqual({ duplicate: false });
    expect(await store.reserveRoot(CODEX, 'event-1')).toMatchObject({ eventId: 'event-1' });
    await store.markDelivered('event-1', 'delivered');
    expect(await store.recordEvent(first)).toEqual({ duplicate: true });
    await store.markRoot(CODEX, 'event-1', 'om_root');
    await store.markAdopted(CODEX, 'om_root');
    await store.recordEvent(event(CODEX, 'event-2', 'turn-2'));

    expect(await store.resolveTakeover(CODEX.larkAppId, 'event-1')).toMatchObject({
      event: { eventId: 'event-2', threadId: 'thread-1', provider: 'codex' },
      route: { rootMessageId: 'om_root' },
    });
    expect(await store.thread(CODEX)).toMatchObject({
      ...CODEX,
      rootEventId: 'event-1', rootMessageId: 'om_root', latestEventId: 'event-2', adoptedAt: expect.any(Number),
    });
    expect(await store.routeByRoot(CODEX.larkAppId, 'om_root')).toMatchObject({
      ...CODEX,
      adoptedAt: expect.any(Number),
    });
  });

  it('用 Bot、Provider 和 thread 复合身份隔离所有状态', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-handoff-store-'));
    const store = new DesktopHandoffStore(join(dir, 'ledger.json'));
    await store.confirmTurn(CODEX, 'turn-1', 'Codex prompt');
    expect(await store.confirmedTurn(TRAEX, 'turn-1')).toBeUndefined();

    await store.recordEvent(event(CODEX));
    await store.reserveRoot(CODEX, 'event-1');
    await store.markRoot(CODEX, 'event-1', 'om_codex');

    expect(await store.thread(TRAEX)).toBeUndefined();
    expect(await store.routeByRoot(TRAEX.larkAppId, 'om_codex')).toBeUndefined();
    expect(await store.resolveTakeover(TRAEX.larkAppId, 'event-1')).toBeUndefined();
  });

  it('复合身份进入事件 ID，阻止相同原生 ID 跨 Provider 去重', () => {
    const completion = {
      turnId: 'turn-native', status: 'completed' as const, finalText: '完成', cwd: '/workspace/app', title: '检查架构',
    };
    const codex = completionFromDesktopTurn(CODEX, '检查架构', completion);
    const traex = completionFromDesktopTurn(TRAEX, '检查架构', completion);
    expect(codex).toMatchObject(CODEX);
    expect(traex).toMatchObject(TRAEX);
    expect(codex.eventId).not.toBe(traex.eventId);
  });

  it('话题路由生命周期独立于短期事件，直到根消息被明确撤回', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-handoff-store-'));
    const store = new DesktopHandoffStore(join(dir, 'ledger.json'));
    const first = event(CODEX);
    await store.recordEvent(first);
    await store.reserveRoot(CODEX, first.eventId);
    await store.markRoot(CODEX, first.eventId, 'om_root');
    await store.markAdopted(CODEX, 'om_root');
    await store.removeEvent(first.eventId);

    expect(await store.routeByRoot(CODEX.larkAppId, 'om_root')).toMatchObject({ ...CODEX, rootMessageId: 'om_root' });
    await store.clearRoot(CODEX, 'om_root');
    expect(await store.routeByRoot(CODEX.larkAppId, 'om_root')).toBeUndefined();
    expect(await store.thread(CODEX)).not.toHaveProperty('adoptedAt');
  });

  it('根事件被全局事件上限淘汰后，原根卡仍解析到该会话最新事件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-handoff-store-'));
    const store = new DesktopHandoffStore(join(dir, 'ledger.json'));
    await store.recordEvent(event(CODEX, 'root-event', 'turn-0'));
    await store.reserveRoot(CODEX, 'root-event');
    await store.markRoot(CODEX, 'root-event', 'om_root');
    for (let index = 0; index < 513; index += 1) {
      await store.recordEvent(event(CODEX, `event-${index}`, `turn-${index}`));
    }
    expect(await store.resolveTakeover(CODEX.larkAppId, 'root-event')).toMatchObject({
      event: { eventId: 'event-512' },
      route: { rootEventId: 'root-event', rootMessageId: 'om_root' },
    });
  }, 20_000);

  it('非 v2 账本直接拒绝，不静默兼容或丢数据', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-handoff-store-'));
    const path = join(dir, 'ledger.json');
    await writeFile(path, JSON.stringify({ version: 1, confirmedTurns: {}, events: {}, threads: {} }));
    await expect(new DesktopHandoffStore(path).thread(CODEX))
      .rejects.toThrow('desktop_handoff_ledger_invalid');
  });
});

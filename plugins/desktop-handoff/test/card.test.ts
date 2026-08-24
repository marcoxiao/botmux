import { describe, expect, it } from 'vitest';
import {
  buildCompletionCard,
  buildMessageResultCard,
  buildOpenAppResultCard,
  buildTakeoverResultCard,
} from '../src/card.js';

describe('CardKit cards', () => {
  it('根卡片按钮只携带 action 和 event_id', () => {
    const card = buildCompletionCard({
      eventId: 'event-1', larkAppId: 'cli_codex', provider: 'codex',
      threadId: 'thread-secret', nativeTurnId: 'turn-secret', cwd: '/private/path',
      title: '检查架构', finalPreview: '已完成', status: 'completed',
      completedAt: '2026-08-23T00:00:00.000Z',
    }, true);
    const encoded = JSON.stringify(card);
    expect(encoded).toContain('desktop-handoff.takeover');
    expect(encoded).toContain('event-1');
    expect(encoded).not.toContain('thread-secret');
    expect(encoded).not.toContain('/private/path');
  });

  it('同一套 CardKit 按 Provider 展示 Codex 或 TraeX Desktop', () => {
    const base = {
      eventId: 'event-1', larkAppId: 'cli_traex', provider: 'traex' as const,
      threadId: 'thread-secret', nativeTurnId: 'turn-secret', cwd: '/private/path',
      title: '检查架构', finalPreview: '已完成', status: 'completed' as const,
      completedAt: '2026-08-23T00:00:00.000Z',
    };
    const traex = JSON.stringify(buildCompletionCard(base, true));
    expect(traex).toContain('TraeX Desktop');
    expect(traex).not.toContain('Codex App');

    const codex = JSON.stringify(buildCompletionCard({ ...base, larkAppId: 'cli_codex', provider: 'codex' }, true));
    expect(codex).toContain('Codex Desktop');
    expect(codex).not.toContain('TraeX');
  });

  it('接管成功和离线都返回统一 CardKit 结果卡', () => {
    expect(buildTakeoverResultCard('codex', 'success')).toMatchObject({ header: { template: 'green' } });
    const offline = buildTakeoverResultCard('traex', 'offline', 'event-1');
    expect(offline).toMatchObject({ header: { template: 'red' } });
    expect(JSON.stringify(offline)).toContain('TraeX Desktop');
    expect(JSON.stringify(offline)).toContain('desktop-handoff.takeover');
    expect(JSON.stringify(buildOpenAppResultCard({
      eventId: 'event-1', larkAppId: 'cli_codex', provider: 'codex',
      threadId: 'thread-secret', nativeTurnId: 'turn-secret', cwd: '/private/path',
      title: '检查架构', finalPreview: '已完成', status: 'completed',
      completedAt: '2026-08-23T00:00:00.000Z',
    }, true))).toContain('desktop-handoff.takeover');
  });

  it('话题输入失败态统一使用 CardKit 2.0 且不暴露内部错误', () => {
    for (const state of ['not-adopted', 'offline', 'busy', 'delivery-unknown', 'unsupported'] as const) {
      const card = buildMessageResultCard('codex', state);
      expect(card).toMatchObject({ schema: '2.0', config: { update_multi: true } });
      expect(JSON.stringify(card)).not.toMatch(/socket|stack|thread[_ ]?id/i);
    }
    const busy = JSON.stringify(buildMessageResultCard('traex', 'busy'));
    expect(busy).toContain('TraeX Desktop');
    expect(busy).toContain('正在处理');
    expect(busy).toContain('没有排队');
    const unknown = JSON.stringify(buildMessageResultCard('codex', 'delivery-unknown'));
    expect(unknown).toContain('不要立即重发');
    expect(unknown).not.toContain('没有排队');
  });
});

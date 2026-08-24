import { describe, expect, it, vi } from 'vitest';
import { openTraexApp } from '../src/open-app.js';

describe('openTraexApp', () => {
  it('只运行固定系统命令，不接收飞书或会话参数', async () => {
    const run = vi.fn(async () => undefined);
    await expect(openTraexApp(run)).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Traex']);
  });

  it('系统命令失败时只返回失败状态', async () => {
    const run = vi.fn(async () => { throw new Error('launch failed'); });
    await expect(openTraexApp(run)).resolves.toEqual({ ok: false, error: 'launch failed' });
  });
});

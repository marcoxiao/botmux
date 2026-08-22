import { describe, expect, it, vi } from 'vitest';
import {
  probeCodexNotifierHookHealth,
  type CodexAppHook,
} from '../src/features/codex-notifier/index.js';

const COMMAND = '/Users/test/.botmux/bin/botmux codex-watch-hook';

function hook(
  eventName: 'stop' | 'userPromptSubmit',
  overrides: Partial<CodexAppHook> = {},
): CodexAppHook {
  return {
    eventName,
    command: COMMAND,
    enabled: true,
    trustStatus: 'trusted',
    ...overrides,
  };
}

describe('Codex notifier Hook health', () => {
  it('reports trusted only when both native Hook events are enabled and trusted', async () => {
    const health = await probeCodexNotifierHookHealth({
      now: () => Date.parse('2026-08-23T00:00:00.000Z'),
      listHooks: vi.fn(async () => [hook('stop'), hook('userPromptSubmit')]),
    });

    expect(health).toEqual({
      status: 'trusted',
      checkedAt: '2026-08-23T00:00:00.000Z',
    });
  });

  it.each([
    {
      expected: 'untrusted',
      hooks: [hook('stop'), hook('userPromptSubmit', { trustStatus: 'untrusted' })],
    },
    {
      expected: 'disabled',
      hooks: [hook('stop'), hook('userPromptSubmit', { enabled: false })],
    },
    {
      expected: 'missing',
      hooks: [hook('stop')],
    },
  ] as const)('reports $expected without mutating Hook config', async ({ expected, hooks }) => {
    await expect(probeCodexNotifierHookHealth({
      listHooks: async () => [...hooks],
    })).resolves.toMatchObject({ status: expected });
  });

  it('reports an unavailable probe without throwing or exposing stack data', async () => {
    const health = await probeCodexNotifierHookHealth({
      listHooks: async () => { throw new Error('app-server timed out'); },
    });

    expect(health.status).toBe('unavailable');
    expect(health.error).toBe('app-server timed out');
  });
});

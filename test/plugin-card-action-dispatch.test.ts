import { describe, expect, it, vi } from 'vitest';
import { handleCardAction } from '../src/im/lark/card-handler.js';

describe('lark plugin card action dispatch', () => {
  it('returns the result of a claimed plugin action before session lookup', async () => {
    const data = {
      operator: { open_id: 'ou_owner' },
      action: { value: { action: 'desktop-handoff.takeover', event_id: 'evt-1' } },
      context: { open_message_id: 'om_card' },
    };
    const pluginCardAction = vi.fn(async () => ({
      handled: true,
      result: { toast: { type: 'success', content: '已接管' } },
    }));

    await expect(handleCardAction(data, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
      pluginCardAction,
    }, 'cli_bot')).resolves.toEqual({
      toast: { type: 'success', content: '已接管' },
    });
    expect(pluginCardAction).toHaveBeenCalledWith(data, 'cli_bot');
  });

  it('does not consume an action that no enabled plugin claims', async () => {
    const pluginCardAction = vi.fn(async () => ({ handled: false as const }));
    await expect(handleCardAction({
      action: { value: { action: 'unknown.click' } },
    }, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
      pluginCardAction,
    }, 'cli_bot')).resolves.toBeUndefined();
    expect(pluginCardAction).toHaveBeenCalledOnce();
  });
});

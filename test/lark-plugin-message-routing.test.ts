import { describe, expect, it, vi } from 'vitest';
import { dispatchPluginTopicMessage } from '../src/im/lark/event-dispatcher.js';

describe('Lark plugin topic message routing', () => {
  const base = {
    larkAppId: 'cli_bot',
    chatId: 'oc_workbench',
    messageId: 'om_input',
    senderOpenId: 'ou_owner',
    talkAllowed: true,
    message: {
      root_id: 'om_root',
      thread_id: 'omt_thread',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 从飞书继续' }),
      mentions: [{ key: '@_user_1', name: 'AI马仔', id: { open_id: 'ou_bot' } }],
    },
  };

  it('passes only a normalized real topic reply to the plugin', async () => {
    const handle = vi.fn(async () => true);

    await expect(dispatchPluginTopicMessage(base, handle)).resolves.toBe(true);
    expect(handle).toHaveBeenCalledWith({
      larkAppId: 'cli_bot',
      chatId: 'oc_workbench',
      messageId: 'om_input',
      rootMessageId: 'om_root',
      senderOpenId: 'ou_owner',
      text: '从飞书继续',
    });
  });

  it.each([
    ['no root', { message: { ...base.message, root_id: undefined } }],
    ['no thread', { message: { ...base.message, thread_id: undefined } }],
    ['not allowed', { talkAllowed: false }],
    ['no sender', { senderOpenId: undefined }],
  ])('does not expose %s messages to plugins', async (_name, override) => {
    const handle = vi.fn(async () => true);

    await expect(dispatchPluginTopicMessage({ ...base, ...override }, handle)).resolves.toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  it('returns false when no enabled plugin implements message handling', async () => {
    await expect(dispatchPluginTopicMessage(base, undefined)).resolves.toBe(false);
  });
});

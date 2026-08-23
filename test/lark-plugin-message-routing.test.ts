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
    }, undefined);
  });

  it('uses thread_id as the root identity for Lark\'s send-to-chat topic shape', async () => {
    const handle = vi.fn(async () => true);
    const resolve = vi.fn(() => ({ pluginId: 'desktop-handoff', rootMessageId: 'om_root' }));

    for (const root_id of [undefined, '']) {
      await expect(dispatchPluginTopicMessage({
        ...base,
        message: { ...base.message, root_id, thread_id: 'omt_thread' },
      }, handle, resolve)).resolves.toBe(true);
    }
    expect(handle).toHaveBeenCalledTimes(2);
    expect(handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ rootMessageId: 'om_root' }),
      'desktop-handoff',
    );
  });

  it.each([
    ['no topic identity', { message: { ...base.message, root_id: undefined, thread_id: undefined } }],
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

  it('fails closed for a persistently claimed root when its plugin is disabled', async () => {
    const claimed = vi.fn(() => ({ pluginId: 'desktop-handoff', rootMessageId: 'om_root' }));

    await expect(dispatchPluginTopicMessage(base, undefined, claimed)).resolves.toBe(true);
    expect(claimed).toHaveBeenCalledWith('cli_bot', 'om_root');
  });

  it('fails closed for a claimed root before ordinary authorization routing', async () => {
    const claimed = vi.fn(() => ({ pluginId: 'desktop-handoff', rootMessageId: 'om_root' }));

    await expect(dispatchPluginTopicMessage(
      { ...base, talkAllowed: false },
      undefined,
      claimed,
    )).resolves.toBe(true);
  });

  it('fails closed for an unresolved rootless alias inside an exclusive plugin chat', async () => {
    const handle = vi.fn(async () => false);

    await expect(dispatchPluginTopicMessage({
      ...base,
      message: { ...base.message, root_id: '', thread_id: 'omt_unresolved' },
    }, handle, () => undefined, () => true)).resolves.toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });

  it('fails closed for an unresolved rooted reply inside an exclusive plugin chat', async () => {
    const handle = vi.fn(async () => false);

    await expect(dispatchPluginTopicMessage(
      base,
      handle,
      () => undefined,
      () => true,
    )).resolves.toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });
});

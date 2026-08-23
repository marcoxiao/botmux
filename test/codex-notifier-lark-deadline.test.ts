import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  reply: vi.fn(),
  request: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({
    request: mocks.request,
    im: { v1: { message: { create: mocks.create, reply: mocks.reply } } },
  }),
  getAllBots: () => [],
  getBot: vi.fn(),
  formatLarkError: (value: unknown) => String(value),
  loadBotConfigs: () => [],
}));

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: vi.fn(),
}));

import {
  getMessageChatId,
  LarkMessageError,
  replyMessage,
  sendMessage,
  sendUserMessage,
} from '../src/im/lark/client.js';

describe('Codex notifier Lark request deadlines', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.reply.mockReset();
    mocks.request.mockReset();
  });

  it('passes timeout and AbortSignal to the SDK generic DM request', async () => {
    const controller = new AbortController();
    mocks.request.mockResolvedValue({ code: 0, data: { message_id: 'om_card' } });

    await expect(sendUserMessage(
      'app',
      'ou_owner',
      '{"schema":"2.0"}',
      'interactive',
      'stable-uuid',
      { timeoutMs: 1_234, signal: controller.signal },
    )).resolves.toBe('om_card');

    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'open_id' },
      timeout: 1_234,
      signal: controller.signal,
      data: expect.objectContaining({
        receive_id: 'ou_owner',
        msg_type: 'interactive',
        uuid: 'stable-uuid',
      }),
    }));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps the generated SDK path for existing unbounded callers', async () => {
    mocks.create.mockResolvedValue({ code: 0, data: { message_id: 'om_legacy' } });
    await expect(sendUserMessage('app', 'ou_owner', 'hello')).resolves.toBe('om_legacy');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('lets an AbortSignal cancel an in-flight DM request', async () => {
    const controller = new AbortController();
    const cancelled = new Error('delivery cancelled');
    mocks.request.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));

    const delivery = sendUserMessage(
      'app',
      'ou_owner',
      '{"schema":"2.0"}',
      'interactive',
      'stable-uuid',
      { timeoutMs: 1_234, signal: controller.signal },
    );
    controller.abort(cancelled);
    await expect(delivery).rejects.toBe(cancelled);
  });

  it('passes timeout and AbortSignal to group send and reply requests', async () => {
    const controller = new AbortController();
    mocks.request
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_root' } })
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_reply' } });
    const options = { timeoutMs: 1_234, signal: controller.signal };

    await expect(sendMessage(
      'app',
      'oc_workbench',
      '{"schema":"2.0"}',
      'interactive',
      'root-uuid',
      undefined,
      options,
    )).resolves.toBe('om_root');
    await expect(replyMessage(
      'app',
      'om_root',
      '{"schema":"2.0"}',
      'interactive',
      true,
      'reply-uuid',
      undefined,
      options,
    )).resolves.toBe('om_reply');

    expect(mocks.request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'chat_id' },
      timeout: 1_234,
      signal: controller.signal,
      data: expect.objectContaining({ receive_id: 'oc_workbench', uuid: 'root-uuid' }),
    }));
    expect(mocks.request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'POST',
      url: '/open-apis/im/v1/messages/om_root/reply',
      timeout: 1_234,
      signal: controller.signal,
      data: expect.objectContaining({ reply_in_thread: true, uuid: 'reply-uuid' }),
    }));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it('classifies deadline-bound rate limits as retryable and definite 4xx as permanent', async () => {
    const options = { timeoutMs: 1_234, signal: new AbortController().signal };
    mocks.request
      .mockRejectedValueOnce({
        response: { status: 429, data: { code: 99991400, msg: 'rate limited' } },
      })
      .mockResolvedValueOnce({ code: 99991672, msg: 'permission denied' });

    await expect(sendMessage(
      'app',
      'oc_workbench',
      'hello',
      'text',
      'rate-uuid',
      undefined,
      options,
    )).rejects.toMatchObject<LarkMessageError>({ disposition: 'retryable', code: 99991400 });
    await expect(sendMessage(
      'app',
      'oc_workbench',
      'hello',
      'text',
      'permission-uuid',
      undefined,
      options,
    )).rejects.toMatchObject<LarkMessageError>({ disposition: 'permanent', code: 99991672 });
  });

  it('passes timeout and AbortSignal through message lookup', async () => {
    const controller = new AbortController();
    mocks.request.mockResolvedValue({
      code: 0,
      data: { items: [{ chat_id: 'oc_private' }] },
    });

    await expect(getMessageChatId('app', 'om_card', {
      timeoutMs: 900,
      signal: controller.signal,
    })).resolves.toBe('oc_private');

    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/open-apis/im/v1/messages/om_card',
      timeout: 900,
      signal: controller.signal,
    }));
  });

  it('propagates cancellation instead of hiding it as a missing chat', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    mocks.request.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));

    const lookup = getMessageChatId('app', 'om_card', {
      timeoutMs: 900,
      signal: controller.signal,
    });
    controller.abort(cancelled);
    await expect(lookup).rejects.toBe(cancelled);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  getBot: vi.fn(),
}));

vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    getBot: (...args: unknown[]) => mocks.getBot(...args),
    getBotClient: () => ({
      cardkit: { v1: { card: { create: mocks.create, update: mocks.update } } },
    }),
    getBotUploadClient: vi.fn(),
    getAllBots: () => [],
    loadBotConfigs: () => [],
    formatLarkError: (value: unknown) => String(value),
  };
});

import {
  createCardEntity,
  LarkCardKitError,
  updateCardEntity,
} from '../src/im/lark/client.js';

const rawCard = JSON.stringify({
  schema: '2.0',
  body: {
    elements: [{ tag: 'button', text: '完成', value: { action: 'feedback' } }],
  },
});
const stampedCard = JSON.stringify({
  schema: '2.0',
  body: {
    elements: [{ tag: 'button', text: '完成', value: { action: 'feedback', __bm_cb: 1 } }],
  },
});

describe('Lark CardKit entity adapters', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.update.mockReset();
    mocks.getBot.mockReset();
    mocks.getBot.mockReturnValue({ config: { apiOnly: false } });
  });

  it('creates a stamped Card JSON 2.0 entity and returns its id', async () => {
    mocks.create.mockResolvedValue({ code: 0, data: { card_id: 'card-1' } });

    await expect(createCardEntity('app-1', rawCard)).resolves.toBe('card-1');
    expect(mocks.create).toHaveBeenCalledWith({
      data: { type: 'card_json', data: stampedCard },
    });
  });

  it('fully updates a stamped entity with the caller-owned intent identity', async () => {
    mocks.update.mockResolvedValue({ code: 0, data: {} });

    await expect(updateCardEntity('app-1', 'card-1', rawCard, 4, 'tp_update_4'))
      .resolves.toBeUndefined();
    expect(mocks.update).toHaveBeenCalledWith({
      path: { card_id: 'card-1' },
      data: {
        card: { type: 'card_json', data: stampedCard },
        sequence: 4,
        uuid: 'tp_update_4',
      },
    });
  });

  it('treats a successful create response without card_id as permanent', async () => {
    mocks.create.mockResolvedValue({ code: 0, data: {} });

    await expect(createCardEntity('app-1', rawCard)).rejects.toMatchObject({
      name: 'LarkCardKitError',
      disposition: 'permanent',
    });
  });

  it.each([429, 500, 503])('classifies HTTP %i as retryable', async (status) => {
    mocks.update.mockRejectedValue({ response: { status } });

    await expect(updateCardEntity('app-1', 'card-1', rawCard, 1, 'intent-1'))
      .rejects.toMatchObject({ disposition: 'retryable', code: status });
  });

  it('classifies a request timeout without a response as ambiguous', async () => {
    mocks.create.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));

    await expect(createCardEntity('app-1', rawCard)).rejects.toMatchObject({
      disposition: 'ambiguous',
    });
  });

  it('classifies explicit HTTP and business 4xx failures as permanent', async () => {
    mocks.create.mockRejectedValue({ response: { status: 403, data: { code: 99991672 } } });
    await expect(createCardEntity('app-1', rawCard)).rejects.toMatchObject({
      disposition: 'permanent',
      code: 403,
    });

    mocks.update.mockResolvedValue({ code: 230011, msg: 'message withdrawn' });
    await expect(updateCardEntity('app-1', 'card-1', rawCard, 1, 'intent-1'))
      .rejects.toEqual(expect.objectContaining({
        name: 'LarkCardKitError',
        disposition: 'permanent',
        code: 230011,
      }));
  });

  it('uses a typed error for callers to branch without parsing messages', () => {
    const error = new LarkCardKitError('failed', 'ambiguous');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LarkCardKitError');
  });

  it('keeps api-only bots outside the CardKit transport boundary', async () => {
    mocks.getBot.mockReturnValue({ config: { apiOnly: true } });

    await expect(createCardEntity('local-only', rawCard)).rejects.toMatchObject({
      name: 'LarkTransportDisabledError',
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

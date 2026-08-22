import { describe, expect, it, vi } from 'vitest';

import { daemonListsChat } from '../src/dashboard/codex-notifier-target-chat.js';

describe('daemonListsChat', () => {
  it('accepts only an exact chat from the target bot live chat list', async () => {
    const fetchDaemonIpc = vi.fn(async () => new Response(JSON.stringify({
      chats: [
        { chatId: 'oc_other' },
        { chatId: 'oc_workbench' },
      ],
    }), { status: 200 }));

    await expect(daemonListsChat(fetchDaemonIpc, 11451, 'oc_workbench')).resolves.toBe(true);
    await expect(daemonListsChat(fetchDaemonIpc, 11451, 'oc_work')).resolves.toBe(false);
    expect(fetchDaemonIpc).toHaveBeenCalledWith(
      11451,
      '/api/groups',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ['non-2xx response', new Response(JSON.stringify({ chats: [{ chatId: 'oc_workbench' }] }), { status: 503 })],
    ['malformed payload', new Response(JSON.stringify({ chats: 'oc_workbench' }), { status: 200 })],
  ])('fails closed for a %s', async (_label, response) => {
    const fetchDaemonIpc = vi.fn(async () => response);
    await expect(daemonListsChat(fetchDaemonIpc, 11451, 'oc_workbench')).resolves.toBe(false);
  });

  it('fails closed when the daemon cannot be queried', async () => {
    const fetchDaemonIpc = vi.fn(async () => { throw new Error('offline'); });
    await expect(daemonListsChat(fetchDaemonIpc, 11451, 'oc_workbench')).resolves.toBe(false);
  });
});

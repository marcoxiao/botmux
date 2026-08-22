import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import {
  CodexNotifierDeliveryCoordinator,
  CodexNotifierTopicRouteStore,
  codexNotifierEventId,
  codexNotifierFallbackMessageUuid,
  codexNotifierMessageUuid,
} from '../src/features/codex-notifier/index.js';
import type { CodexTaskCompletedEvent } from '../src/features/codex-notifier/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function event(turn: string, threadId = '019f8d92-df7c-7572-83ca-b1e99f20204c'):
CodexTaskCompletedEvent {
  const identity = {
    source: 'codex-desktop' as const,
    threadId,
    nativeTurnId: turn,
    status: 'completed' as const,
  };
  return {
    schemaVersion: 1,
    eventId: codexNotifierEventId(identity),
    type: 'task.completed',
    ...identity,
    clientSurface: 'codex-app',
    title: `任务 ${turn}`,
    cwd: '/workspace/project',
    completedAt: '2026-08-23T08:00:00.000Z',
    finalPreview: `完成 ${turn}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-delivery-'));
  tempDirs.push(dir);
  const routeStore = new CodexNotifierTopicRouteStore(join(dir, 'routes.json'));
  const sendMessage = vi.fn(async () => 'om_root');
  const replyMessage = vi.fn(async () => 'om_reply');
  const sendUserMessage = vi.fn(async () => 'om_dm');
  const coordinator = new CodexNotifierDeliveryCoordinator({
    larkAppId: 'cli_test',
    routeStore,
    getOwnerOpenId: () => 'ou_owner',
    sendMessage,
    replyMessage,
    sendUserMessage,
    platform: 'darwin',
  });
  return { coordinator, routeStore, sendMessage, replyMessage, sendUserMessage };
}

describe('Codex notifier delivery coordinator', () => {
  it('keeps the legacy owner DM path when targetChatId is absent', async () => {
    const { coordinator, sendMessage, sendUserMessage } = createHarness();
    const completion = event('dm');

    await expect(coordinator.deliver(completion)).resolves.toEqual({
      destination: 'dm',
      messageId: 'om_dm',
    });
    expect(sendUserMessage).toHaveBeenCalledWith(
      'cli_test',
      'ou_owner',
      expect.stringContaining('codex_notifier_continue'),
      'interactive',
      codexNotifierMessageUuid(completion.eventId),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('creates one root then replies later turns into the same native thread', async () => {
    const { coordinator, routeStore, sendMessage, replyMessage } = createHarness();
    const first = event('first');
    const second = event('second');

    await expect(coordinator.deliver(first, 'oc_workbench')).resolves.toEqual({
      destination: 'group',
      messageId: 'om_root',
    });
    await expect(coordinator.deliver(second, 'oc_workbench')).resolves.toEqual({
      destination: 'group',
      messageId: 'om_reply',
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'cli_test',
      'oc_workbench',
      expect.any(String),
      'interactive',
      codexNotifierMessageUuid(first.eventId),
    );
    expect(replyMessage).toHaveBeenCalledWith(
      'cli_test',
      'om_root',
      expect.any(String),
      'interactive',
      true,
      codexNotifierMessageUuid(second.eventId),
    );
    expect(routeStore.get(first.threadId, 'oc_workbench')?.rootMessageId).toBe('om_root');
  });

  it('serializes concurrent first deliveries for the same bot, chat and thread', async () => {
    const { coordinator, sendMessage, replyMessage } = createHarness();
    const root = deferred<string>();
    sendMessage.mockImplementationOnce(() => root.promise);

    const firstDelivery = coordinator.deliver(event('concurrent-1'), 'oc_workbench');
    const secondDelivery = coordinator.deliver(event('concurrent-2'), 'oc_workbench');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(replyMessage).not.toHaveBeenCalled();
    root.resolve('om_root');

    await expect(Promise.all([firstDelivery, secondDelivery])).resolves.toEqual([
      { destination: 'group', messageId: 'om_root' },
      { destination: 'group', messageId: 'om_reply' },
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(replyMessage).toHaveBeenCalledTimes(1);
  });

  it('reuses the in-flight delivery for an exact event retry', async () => {
    const { coordinator, sendMessage, replyMessage } = createHarness();
    const root = deferred<string>();
    sendMessage.mockImplementationOnce(() => root.promise);
    const completion = event('same-event');

    const firstDelivery = coordinator.deliver(completion, 'oc_workbench');
    const retriedDelivery = coordinator.deliver(completion, 'oc_workbench');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    root.resolve('om_root');

    await expect(Promise.all([firstDelivery, retriedDelivery])).resolves.toEqual([
      { destination: 'group', messageId: 'om_root' },
      { destination: 'group', messageId: 'om_root' },
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it('retries the same root UUID when route persistence fails after Lark accepts the card', async () => {
    const { coordinator, routeStore, sendMessage, sendUserMessage } = createHarness();
    const completion = event('bind-retry');
    const bind = vi.spyOn(routeStore, 'bind');
    bind.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(coordinator.deliver(completion, 'oc_workbench')).rejects.toThrow('disk full');
    await expect(coordinator.deliver(completion, 'oc_workbench')).resolves.toEqual({
      destination: 'group',
      messageId: 'om_root',
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map(call => call[4])).toEqual([
      codexNotifierMessageUuid(completion.eventId),
      codexNotifierMessageUuid(completion.eventId),
    ]);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(routeStore.get(completion.threadId, 'oc_workbench')?.rootMessageId).toBe('om_root');
  });

  it('does not serialize independent threads', async () => {
    const { coordinator, sendMessage } = createHarness();
    const first = deferred<string>();
    const second = deferred<string>();
    sendMessage
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const deliveries = [
      coordinator.deliver(event('parallel-1', 'thread-a'), 'oc_workbench'),
      coordinator.deliver(event('parallel-2', 'thread-b'), 'oc_workbench'),
    ];
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    first.resolve('om_a');
    second.resolve('om_b');
    await Promise.all(deliveries);
  });

  it('falls back to an alert-only DM and keeps the route on unknown reply errors', async () => {
    const { coordinator, routeStore, replyMessage, sendUserMessage } = createHarness();
    const completion = event('fallback');
    routeStore.bind({
      threadId: completion.threadId,
      chatId: 'oc_workbench',
      rootMessageId: 'om_root',
    });
    replyMessage.mockRejectedValueOnce(new Error('timeout'));

    await expect(coordinator.deliver(completion, 'oc_workbench')).resolves.toEqual({
      destination: 'fallback_dm',
      messageId: 'om_dm',
    });
    const fallbackCard = String(sendUserMessage.mock.calls[0]?.[2]);
    expect(fallbackCard).toContain('目标群话题投递失败');
    expect(fallbackCard).not.toContain('codex_notifier_continue');
    expect(fallbackCard).not.toContain('codex_notifier_open_app');
    expect(routeStore.get(completion.threadId, 'oc_workbench')).toBeDefined();
    expect(sendUserMessage.mock.calls[0]?.[4]).toBe(
      codexNotifierFallbackMessageUuid(completion.eventId),
    );
    expect(codexNotifierFallbackMessageUuid(completion.eventId)).not.toBe(
      codexNotifierMessageUuid(completion.eventId),
    );
  });

  it('invalidates only a withdrawn route and does not rebuild a root for that event', async () => {
    const { coordinator, routeStore, sendMessage, replyMessage } = createHarness();
    const completion = event('withdrawn');
    routeStore.bind({
      threadId: completion.threadId,
      chatId: 'oc_workbench',
      rootMessageId: 'om_root',
    });
    replyMessage.mockRejectedValueOnce(new MessageWithdrawnError('om_root'));

    await expect(coordinator.deliver(completion, 'oc_workbench')).resolves.toMatchObject({
      destination: 'fallback_dm',
    });
    expect(routeStore.get(completion.threadId, 'oc_workbench')).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

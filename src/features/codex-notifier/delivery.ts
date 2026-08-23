import {
  LarkMessageError,
  MessageWithdrawnError,
  replyMessage as larkReplyMessage,
  sendMessage as larkSendMessage,
  sendUserMessage as larkSendUserMessage,
  type LarkRequestOptions,
} from '../../im/lark/client.js';
import { buildCodexCompletionCard, buildCodexNotifierDeliveryFailureCard } from './card.js';
import { codexNotifierFallbackMessageUuid, codexNotifierMessageUuid } from './event.js';
import type { CodexNotifierTopicRouteStore } from './topic-route-store.js';
import type { CodexTaskCompletedEvent } from './types.js';

export interface CodexNotifierDeliveryResult {
  messageId: string;
  destination: 'dm' | 'group' | 'fallback_dm';
}

export interface CodexNotifierDeliveryCoordinatorOptions {
  larkAppId: string;
  routeStore: CodexNotifierTopicRouteStore;
  getOwnerOpenId: () => string | undefined;
  sendMessage?: typeof larkSendMessage;
  replyMessage?: typeof larkReplyMessage;
  sendUserMessage?: typeof larkSendUserMessage;
  platform?: NodeJS.Platform;
}

/** 决定通知落点；事件账本和重试语义仍由 daemon/outbox 负责。 */
export class CodexNotifierDeliveryCoordinator {
  private readonly eventDeliveries = new Map<string, Promise<CodexNotifierDeliveryResult>>();
  private readonly latches = new Map<string, Promise<unknown>>();
  private readonly sendMessage: typeof larkSendMessage;
  private readonly replyMessage: typeof larkReplyMessage;
  private readonly sendUserMessage: typeof larkSendUserMessage;

  constructor(private readonly options: CodexNotifierDeliveryCoordinatorOptions) {
    this.sendMessage = options.sendMessage ?? larkSendMessage;
    this.replyMessage = options.replyMessage ?? larkReplyMessage;
    this.sendUserMessage = options.sendUserMessage ?? larkSendUserMessage;
  }

  async deliver(
    event: CodexTaskCompletedEvent,
    targetChatId?: string,
    requestOptions?: LarkRequestOptions,
  ): Promise<CodexNotifierDeliveryResult> {
    const eventKey = `${this.options.larkAppId}:${event.eventId}`;
    const inFlight = this.eventDeliveries.get(eventKey);
    if (inFlight) return inFlight;

    const delivery = targetChatId
      ? this.queueGroupDelivery(event, targetChatId, requestOptions)
      : this.deliverOwnerDm(event, requestOptions);
    this.eventDeliveries.set(eventKey, delivery);
    try {
      return await delivery;
    } finally {
      if (this.eventDeliveries.get(eventKey) === delivery) {
        this.eventDeliveries.delete(eventKey);
      }
    }
  }

  private async queueGroupDelivery(
    event: CodexTaskCompletedEvent,
    targetChatId: string,
    requestOptions?: LarkRequestOptions,
  ): Promise<CodexNotifierDeliveryResult> {
    const key = `${this.options.larkAppId}:${targetChatId}:${event.threadId}`;
    const previous = this.latches.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.deliverGroup(event, targetChatId, requestOptions));
    this.latches.set(key, current);
    try {
      return await current;
    } finally {
      if (this.latches.get(key) === current) this.latches.delete(key);
    }
  }

  private async deliverOwnerDm(
    event: CodexTaskCompletedEvent,
    requestOptions?: LarkRequestOptions,
  ): Promise<CodexNotifierDeliveryResult> {
    const ownerOpenId = this.requireOwnerOpenId();
    const messageId = await this.sendOwner(
      ownerOpenId,
      buildCodexCompletionCard(event, { platform: this.options.platform }),
      codexNotifierMessageUuid(event.eventId),
      requestOptions,
    );
    return { destination: 'dm', messageId };
  }

  private async deliverGroup(
    event: CodexTaskCompletedEvent,
    chatId: string,
    requestOptions?: LarkRequestOptions,
  ): Promise<CodexNotifierDeliveryResult> {
    const route = this.options.routeStore.get(event.threadId, chatId);
    const card = buildCodexCompletionCard(event, { platform: this.options.platform });
    const uuid = codexNotifierMessageUuid(event.eventId);

    if (!route) {
      let messageId: string;
      try {
        messageId = await this.sendGroup(chatId, card, uuid, requestOptions);
      } catch (error) {
        if (error instanceof MessageWithdrawnError
          || error instanceof LarkMessageError && error.disposition === 'permanent') {
          return this.deliverFallbackDm(event, requestOptions);
        }
        throw error;
      }
      // 远端发送成功但本地持久化失败时必须抛出，让 outbox 用同一 UUID 重试；
      // 不能把事件标成已投递，否则会永久留下无路由的孤儿根卡。
      this.options.routeStore.bind({
        threadId: event.threadId,
        chatId,
        rootMessageId: messageId,
      });
      return { destination: 'group', messageId };
    }

    try {
      const messageId = await this.replyGroup(
        route.rootMessageId,
        card,
        uuid,
        requestOptions,
      );
      return { destination: 'group', messageId };
    } catch (error) {
      if (error instanceof MessageWithdrawnError) {
        this.options.routeStore.invalidate(event.threadId, chatId);
        return this.deliverFallbackDm(event, requestOptions);
      }
      if (error instanceof LarkMessageError && error.disposition === 'permanent') {
        return this.deliverFallbackDm(event, requestOptions);
      }
      throw error;
    }
  }

  private async deliverFallbackDm(
    event: CodexTaskCompletedEvent,
    requestOptions?: LarkRequestOptions,
  ): Promise<CodexNotifierDeliveryResult> {
    const ownerOpenId = this.requireOwnerOpenId();
    const messageId = await this.sendOwner(
      ownerOpenId,
      buildCodexNotifierDeliveryFailureCard(event),
      codexNotifierFallbackMessageUuid(event.eventId),
      requestOptions,
    );
    return { destination: 'fallback_dm', messageId };
  }

  private requireOwnerOpenId(): string {
    const ownerOpenId = this.options.getOwnerOpenId()?.trim();
    if (!ownerOpenId) throw new Error('codex_notifier_owner_unavailable');
    return ownerOpenId;
  }

  private sendGroup(
    chatId: string,
    card: string,
    uuid: string,
    requestOptions?: LarkRequestOptions,
  ): Promise<string> {
    return requestOptions
      ? this.sendMessage(
        this.options.larkAppId,
        chatId,
        card,
        'interactive',
        uuid,
        undefined,
        requestOptions,
      )
      : this.sendMessage(this.options.larkAppId, chatId, card, 'interactive', uuid);
  }

  private replyGroup(
    rootMessageId: string,
    card: string,
    uuid: string,
    requestOptions?: LarkRequestOptions,
  ): Promise<string> {
    return requestOptions
      ? this.replyMessage(
        this.options.larkAppId,
        rootMessageId,
        card,
        'interactive',
        true,
        uuid,
        undefined,
        requestOptions,
      )
      : this.replyMessage(
        this.options.larkAppId,
        rootMessageId,
        card,
        'interactive',
        true,
        uuid,
      );
  }

  private sendOwner(
    ownerOpenId: string,
    card: string,
    uuid: string,
    requestOptions?: LarkRequestOptions,
  ): Promise<string> {
    return requestOptions
      ? this.sendUserMessage(
        this.options.larkAppId,
        ownerOpenId,
        card,
        'interactive',
        uuid,
        requestOptions,
      )
      : this.sendUserMessage(
        this.options.larkAppId,
        ownerOpenId,
        card,
        'interactive',
        uuid,
      );
  }
}

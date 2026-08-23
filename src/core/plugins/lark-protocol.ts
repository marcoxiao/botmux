import type { PluginConfigApi } from './runtime.js';

export interface LarkLocalEventContext {
  larkAppId: string;
  managedSession: boolean;
}

export interface LarkCardActionContext {
  larkAppId: string;
}

export interface LarkCardAction {
  operator?: {
    open_id?: string;
    union_id?: string;
  };
  action?: {
    value?: Record<string, string>;
    option?: unknown;
    options?: unknown;
    form_value?: Record<string, unknown>;
  };
  context?: { open_message_id?: string };
  open_message_id?: string;
}

export interface LarkSharedAdoptRef {
  sessionId: string;
  threadId: string;
  chatId: string;
  rootMessageId: string;
}

export interface LarkSharedAdoptRequest {
  eventId: string;
  threadId: string;
  nativeTurnId: string;
  cwd: string;
  title?: string;
  finalPreview?: string;
  status: 'completed' | 'failed' | 'cancelled';
  completedAt: string;
  cardMessageId: string;
  ownerOpenId: string;
}

export type LarkPluginHostDispatchContext =
  | { kind: 'local-event' }
  | {
      kind: 'card-action';
      operatorOpenId?: string;
      cardMessageId?: string;
    };

/** Narrow, stable capability object exposed to a Lark contribution. */
export interface LarkPluginHost {
  config: PluginConfigApi;
  sendCard(input: {
    chatId: string;
    card: Record<string, unknown>;
    uuid?: string;
  }): Promise<{ messageId: string }>;
  replyCard(input: {
    rootMessageId: string;
    card: Record<string, unknown>;
    uuid?: string;
  }): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  getOwnerOpenId(): string | undefined;
  findSharedAdopt(threadId: string): Promise<LarkSharedAdoptRef | undefined>;
  sharedAdopt(input: LarkSharedAdoptRequest): Promise<LarkSharedAdoptRef>;
  openCodexApp(threadId: string): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Stable daemon-side contribution contract. The concrete Host capabilities are
 * injected when an event is dispatched; the loader deliberately validates no
 * business-specific fields.
 */
export interface LarkPluginV1 {
  schemaVersion: 1;
  actions: readonly string[];
  handleLocalEvent?(
    event: unknown,
    context: LarkLocalEventContext,
    host: LarkPluginHost,
  ): Promise<unknown>;
  handleCardAction?(
    data: LarkCardAction,
    context: LarkCardActionContext,
    host: LarkPluginHost,
  ): Promise<unknown>;
}

export interface LoadedLarkPlugin {
  pluginId: string;
  plugin: LarkPluginV1;
}

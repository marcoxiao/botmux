export type TaskStatus = 'completed' | 'failed' | 'cancelled';

export type ProviderId = 'codex' | 'traex';

export interface DesktopProvider {
  id: ProviderId;
  productName: 'Codex' | 'TraeX';
  socketPath(): string;
  matchesMeta(meta: Record<string, unknown>): boolean;
}

export interface BotConfig {
  larkAppId: string;
  workbenchChatId: string;
  provider: DesktopProvider;
}

export interface DesktopIdentity {
  larkAppId: string;
  provider: ProviderId;
  threadId: string;
}

export interface CompletionEvent extends DesktopIdentity {
  eventId: string;
  nativeTurnId: string;
  cwd: string;
  title: string;
  finalPreview: string;
  status: TaskStatus;
  completedAt: string;
}

export interface PluginConfigApi {
  path: string;
  get<T = unknown>(key?: string): T | undefined;
  set(key: string, value: unknown): void;
  replace?(value: Record<string, unknown>): void;
}

export interface LarkPluginHost {
  config: PluginConfigApi;
  sendCard(input: {
    chatId: string;
    card: Record<string, unknown>;
    uuid?: string;
    replyClaim?: 'exclusive';
  }): Promise<{ messageId: string }>;
  replyCard(input: { rootMessageId: string; card: Record<string, unknown>; uuid?: string }): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  getOwnerOpenId(): string | undefined;
  openCodexApp(threadId: string): Promise<{ ok: boolean; error?: string }>;
}

export interface LarkPluginMessageContext {
  larkAppId: string;
  chatId: string;
  messageId: string;
  rootMessageId: string;
  senderOpenId: string;
  text: string;
}

export interface LarkCardAction {
  operator?: { open_id?: string };
  action?: { value?: Record<string, string> };
  context?: { open_message_id?: string };
  open_message_id?: string;
}

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
    host: unknown,
  ): Promise<unknown>;
  handleCardAction?(
    data: LarkCardAction,
    context: LarkCardActionContext,
    host: unknown,
  ): Promise<unknown>;
}

export interface LoadedLarkPlugin {
  pluginId: string;
  plugin: LarkPluginV1;
}

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pluginRuntimeDir, resolvePluginPath } from './paths.js';
import { orderedPluginRecords } from './runtime.js';
import type {
  LarkCardAction,
  LarkCardActionContext,
  LarkLocalEventContext,
  LarkPluginMessageContext,
  LarkPluginHost,
  LarkPluginHostDispatchContext,
  LarkPluginV1,
  LoadedLarkPlugin,
} from './lark-protocol.js';

const ACTION_ID_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;

function validateLarkPlugin(pluginId: string, exported: unknown): LarkPluginV1 {
  if (!exported || typeof exported !== 'object' || Array.isArray(exported)) {
    throw new Error(`invalid_lark_plugin_exports:${pluginId}`);
  }
  const candidate = exported as Partial<LarkPluginV1>;
  if (candidate.schemaVersion !== 1) {
    throw new Error(`invalid_lark_plugin_schema:${pluginId}`);
  }
  if (!Array.isArray(candidate.actions)) {
    throw new Error(`invalid_lark_plugin_actions:${pluginId}`);
  }
  if (
    typeof candidate.handleLocalEvent !== 'function'
    && typeof candidate.handleCardAction !== 'function'
    && typeof candidate.handleMessage !== 'function'
  ) {
    throw new Error(`invalid_lark_plugin_handlers:${pluginId}`);
  }
  for (const action of candidate.actions) {
    if (typeof action !== 'string' || !ACTION_ID_PATTERN.test(action)) {
      throw new Error(`invalid_lark_plugin_action:${pluginId}:${String(action)}`);
    }
    if (!action.startsWith(`${pluginId}.`)) {
      throw new Error(`invalid_lark_plugin_action_namespace:${pluginId}:${action}`);
    }
  }
  if (candidate.actions.length > 0 && typeof candidate.handleCardAction !== 'function') {
    throw new Error(`invalid_lark_plugin_card_handler:${pluginId}`);
  }
  return {
    schemaVersion: 1,
    actions: [...candidate.actions],
    ...(candidate.handleLocalEvent ? { handleLocalEvent: candidate.handleLocalEvent } : {}),
    ...(candidate.handleCardAction ? { handleCardAction: candidate.handleCardAction } : {}),
    ...(candidate.handleMessage ? { handleMessage: candidate.handleMessage } : {}),
  };
}

export async function loadLarkPlugins(pluginIds: readonly string[]): Promise<LoadedLarkPlugin[]> {
  if (pluginIds.length === 0) return [];
  const loaded: LoadedLarkPlugin[] = [];
  for (const record of orderedPluginRecords(pluginIds)) {
    const contribution = record.contributions?.lark;
    if (!contribution) continue;
    const entry = resolvePluginPath(
      pluginRuntimeDir(record.id),
      contribution.entry,
      'lark_entry',
    );
    if (!existsSync(entry)) {
      throw new Error(`lark_plugin_entry_not_found:${record.id}:${contribution.entry}`);
    }
    const mod = await import(pathToFileURL(entry).href);
    const plugin = validateLarkPlugin(record.id, mod.default ?? mod);
    loaded.push({ pluginId: record.id, plugin });
  }
  return loaded;
}

export interface LarkPluginDispatcher {
  dispatchLocalEvent(
    pluginId: string,
    event: unknown,
    context: LarkLocalEventContext,
  ): Promise<unknown>;
  dispatchCardAction(
    data: LarkCardAction,
    context: LarkCardActionContext,
  ): Promise<{ handled: false } | { handled: true; result: unknown }>;
  dispatchMessage(context: LarkPluginMessageContext): Promise<{ handled: boolean }>;
}

export function createLarkPluginDispatcher(
  plugins: readonly LoadedLarkPlugin[],
  hostForPlugin: (
    pluginId: string,
    dispatchContext: LarkPluginHostDispatchContext,
  ) => LarkPluginHost,
): LarkPluginDispatcher {
  const byId = new Map(plugins.map(entry => [entry.pluginId, entry]));
  const byAction = new Map<string, LoadedLarkPlugin>();
  for (const loaded of plugins) {
    for (const action of loaded.plugin.actions) byAction.set(action, loaded);
  }
  return {
    async dispatchLocalEvent(pluginId, event, context) {
      const loaded = byId.get(pluginId);
      if (!loaded) throw new Error(`lark_plugin_not_enabled:${pluginId}`);
      const handler = loaded.plugin.handleLocalEvent;
      if (!handler) {
        throw new Error(`lark_plugin_local_event_handler_not_found:${pluginId}`);
      }
      return handler(event, context, hostForPlugin(pluginId, { kind: 'local-event' }));
    },
    async dispatchCardAction(data, context) {
      const action = data.action?.value?.action;
      if (typeof action !== 'string') return { handled: false };
      const loaded = byAction.get(action);
      if (!loaded?.plugin.handleCardAction) return { handled: false };
      const result = await loaded.plugin.handleCardAction(
        data,
        context,
        hostForPlugin(loaded.pluginId, {
          kind: 'card-action',
          operatorOpenId: data.operator?.open_id,
          cardMessageId: data.context?.open_message_id ?? data.open_message_id,
        }),
      );
      return { handled: true, result };
    },
    async dispatchMessage(context) {
      for (const loaded of plugins) {
        const handler = loaded.plugin.handleMessage;
        if (!handler) continue;
        const result = await handler(
          context,
          hostForPlugin(loaded.pluginId, { kind: 'message' }),
        );
        if (result.handled) return { handled: true };
      }
      return { handled: false };
    },
  };
}

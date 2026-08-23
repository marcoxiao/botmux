import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pluginRuntimeDir, resolvePluginPath } from './paths.js';
import { orderedPluginRecords } from './runtime.js';
import type { LarkPluginV1, LoadedLarkPlugin } from './lark-protocol.js';

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
  ) {
    throw new Error(`invalid_lark_plugin_handlers:${pluginId}`);
  }
  for (const action of candidate.actions) {
    if (typeof action !== 'string' || !ACTION_ID_PATTERN.test(action)) {
      throw new Error(`invalid_lark_plugin_action:${pluginId}:${String(action)}`);
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
  };
}

export async function loadLarkPlugins(pluginIds: readonly string[]): Promise<LoadedLarkPlugin[]> {
  if (pluginIds.length === 0) return [];
  const loaded: LoadedLarkPlugin[] = [];
  const actionOwners = new Map<string, string>();
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
    for (const action of plugin.actions) {
      const owner = actionOwners.get(action);
      if (owner) {
        throw new Error(`duplicate_lark_plugin_action:${action}:${owner},${record.id}`);
      }
      actionOwners.set(action, record.id);
    }
    loaded.push({ pluginId: record.id, plugin });
  }
  return loaded;
}

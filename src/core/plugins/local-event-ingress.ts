import type { LarkLocalEventContext } from './lark-protocol.js';

interface PluginLocalEventIngressDeps {
  larkAppId: string;
  enabledPluginIds: readonly string[];
  dispatch(
    pluginId: string,
    event: unknown,
    context: LarkLocalEventContext,
  ): Promise<unknown>;
  onError?(pluginId: string, error: unknown): void;
}

export interface PluginLocalEventIngressResult {
  statusCode: number;
  body: Record<string, unknown>;
}

function isExactEnvelope(raw: unknown): raw is {
  pluginId: string;
  targetBotAppId: string;
  managedSession: boolean;
  event: unknown;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'event,managedSession,pluginId,targetBotAppId') return false;
  return typeof value.pluginId === 'string'
    && /^[a-z][a-z0-9-]{0,63}$/.test(value.pluginId)
    && typeof value.targetBotAppId === 'string'
    && value.targetBotAppId.length > 0
    && value.targetBotAppId.length <= 128
    && typeof value.managedSession === 'boolean';
}

/** Validate and dispatch an already Host-authenticated local plugin event. */
export async function handlePluginLocalEventIngress(
  raw: unknown,
  deps: PluginLocalEventIngressDeps,
): Promise<PluginLocalEventIngressResult> {
  if (!isExactEnvelope(raw)) {
    return { statusCode: 400, body: { ok: false, error: 'bad_body' } };
  }
  if (raw.targetBotAppId !== deps.larkAppId) {
    return { statusCode: 403, body: { ok: false, error: 'target_bot_mismatch' } };
  }
  if (!deps.enabledPluginIds.includes(raw.pluginId)) {
    return { statusCode: 403, body: { ok: false, error: 'plugin_not_enabled' } };
  }
  try {
    const result = await deps.dispatch(raw.pluginId, raw.event, {
      larkAppId: deps.larkAppId,
      managedSession: raw.managedSession,
    });
    const status = result
      && typeof result === 'object'
      && !Array.isArray(result)
      && (result as Record<string, unknown>).status === 'duplicate'
      ? 'duplicate'
      : 'accepted';
    return { statusCode: 200, body: { ok: true, status } };
  } catch (error) {
    deps.onError?.(raw.pluginId, error);
    return { statusCode: 502, body: { ok: false, error: 'plugin_event_failed' } };
  }
}

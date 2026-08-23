import { fetchDaemonIpc } from '../daemon-ipc-auth.js';
import { findOnlineDaemon } from '../../utils/daemon-discovery.js';

export interface PluginLocalEventEnvelope {
  pluginId: string;
  targetBotAppId: string;
  managedSession: boolean;
  event: unknown;
}

export interface PluginLocalEventClientDeps {
  findDaemon?: typeof findOnlineDaemon;
  fetchDaemon?: typeof fetchDaemonIpc;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PluginLocalEventBestEffortDeps extends PluginLocalEventClientDeps {
  onDrop?: (error: unknown) => void;
}

export async function emitPluginLocalEvent(
  envelope: PluginLocalEventEnvelope,
  deps: PluginLocalEventClientDeps = {},
): Promise<{ status: 'accepted' | 'duplicate' }> {
  const daemon = (deps.findDaemon ?? findOnlineDaemon)(envelope.targetBotAppId);
  if (!daemon) throw new Error(`target_daemon_offline:${envelope.targetBotAppId}`);
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? 15_000);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const response = await (deps.fetchDaemon ?? fetchDaemonIpc)(
    daemon.ipcPort,
    '/api/plugin-events',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal,
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`plugin_event_emit_failed:${response.status}:${text.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('plugin_event_emit_response_invalid');
  }
  const status = parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).status
    : undefined;
  if (status !== 'accepted' && status !== 'duplicate') {
    throw new Error('plugin_event_emit_disposition_invalid');
  }
  return { status };
}

/**
 * Hook-only delivery policy: a stopped daemon must never block the originating
 * Codex turn. The event is dropped deliberately; there is no local outbox.
 */
export async function emitPluginLocalEventBestEffort(
  envelope: PluginLocalEventEnvelope,
  deps: PluginLocalEventBestEffortDeps = {},
): Promise<{ status: 'accepted' | 'duplicate' | 'dropped' }> {
  try {
    return await emitPluginLocalEvent(envelope, deps);
  } catch (error) {
    deps.onDrop?.(error);
    return { status: 'dropped' };
  }
}

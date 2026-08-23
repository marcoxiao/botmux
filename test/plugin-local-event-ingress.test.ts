import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handlePluginLocalEventIngress } from '../src/core/plugins/local-event-ingress.js';

describe('plugin local event ingress', () => {
  const baseDeps = () => ({
    larkAppId: 'cli_target',
    enabledPluginIds: ['desktop-handoff'],
    dispatch: vi.fn(async () => ({ status: 'accepted' })),
  });

  it('dispatches an exact trusted envelope to the enabled target plugin', async () => {
    const deps = baseDeps();
    const event = { hook_event_name: 'Stop', session_id: 'thread-1' };

    await expect(handlePluginLocalEventIngress({
      pluginId: 'desktop-handoff',
      targetBotAppId: 'cli_target',
      managedSession: false,
      event,
    }, deps)).resolves.toEqual({
      statusCode: 200,
      body: { ok: true, status: 'accepted' },
    });
    expect(deps.dispatch).toHaveBeenCalledWith(
      'desktop-handoff',
      event,
      { larkAppId: 'cli_target', managedSession: false },
    );
  });

  it('rejects a mismatched target bot before plugin dispatch', async () => {
    const deps = baseDeps();
    const result = await handlePluginLocalEventIngress({
      pluginId: 'desktop-handoff',
      targetBotAppId: 'cli_other',
      managedSession: false,
      event: {},
    }, deps);

    expect(result).toEqual({
      statusCode: 403,
      body: { ok: false, error: 'target_bot_mismatch' },
    });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('rejects installed but disabled plugins without fallback', async () => {
    const deps = baseDeps();
    const result = await handlePluginLocalEventIngress({
      pluginId: 'other-plugin',
      targetBotAppId: 'cli_target',
      managedSession: false,
      event: {},
    }, deps);

    expect(result).toEqual({
      statusCode: 403,
      body: { ok: false, error: 'plugin_not_enabled' },
    });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { pluginId: 'desktop-handoff', targetBotAppId: 'cli_target', managedSession: 'false', event: {} },
    { pluginId: 'desktop-handoff', targetBotAppId: 'cli_target', managedSession: false, event: {}, extra: true },
  ])('rejects malformed or over-broad envelopes', async (raw) => {
    const deps = baseDeps();
    const result = await handlePluginLocalEventIngress(raw, deps);
    expect(result).toEqual({
      statusCode: 400,
      body: { ok: false, error: 'bad_body' },
    });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('maps plugin failures to a bounded delivery error', async () => {
    const deps = baseDeps();
    deps.dispatch.mockRejectedValueOnce(new Error('private detail'));

    await expect(handlePluginLocalEventIngress({
      pluginId: 'desktop-handoff',
      targetBotAppId: 'cli_target',
      managedSession: true,
      event: {},
    }, deps)).resolves.toEqual({
      statusCode: 502,
      body: { ok: false, error: 'plugin_event_failed' },
    });
  });

  it('wires the daemon route behind Host HMAC before generic dispatch', () => {
    const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const start = source.indexOf("ipcRoute('POST', '/api/plugin-events'");
    const end = source.indexOf("ipcRoute('POST', '/api/hooks/emit'", start);
    const route = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(route.indexOf('isTrustedHostIpcRequest(req)')).toBeGreaterThanOrEqual(0);
    expect(route.indexOf('handlePluginLocalEventIngress('))
      .toBeGreaterThan(route.indexOf('isTrustedHostIpcRequest(req)'));
    expect(route).not.toContain('pluginId !== CODEX_NOTIFIER_PLUGIN_ID');
  });
});

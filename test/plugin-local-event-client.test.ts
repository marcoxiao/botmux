import { describe, expect, it, vi } from 'vitest';
import {
  emitPluginLocalEvent,
  emitPluginLocalEventBestEffort,
} from '../src/core/plugins/local-event-client.js';

describe('plugin local event client', () => {
  it('sends the exact host-generated envelope to the selected daemon', async () => {
    const fetchDaemon = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      status: 'accepted',
    }), { status: 200 }));
    const event = { hook_event_name: 'Stop' };

    await expect(emitPluginLocalEvent({
      pluginId: 'desktop-handoff',
      targetBotAppId: 'cli_target',
      managedSession: true,
      event,
    }, {
      findDaemon: vi.fn(() => ({ larkAppId: 'cli_target', ipcPort: 4321 })),
      fetchDaemon: fetchDaemon as never,
    })).resolves.toEqual({ status: 'accepted' });

    expect(fetchDaemon).toHaveBeenCalledWith(
      4321,
      '/api/plugin-events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          pluginId: 'desktop-handoff',
          targetBotAppId: 'cli_target',
          managedSession: true,
          event,
        }),
      }),
    );
  });

  it('fails clearly when the target daemon is offline', async () => {
    await expect(emitPluginLocalEvent({
      pluginId: 'desktop-handoff',
      targetBotAppId: 'cli_target',
      managedSession: false,
      event: {},
    }, {
      findDaemon: vi.fn(() => null),
      fetchDaemon: vi.fn() as never,
    })).rejects.toThrow('target_daemon_offline:cli_target');
  });

  it('does not expose daemon error bodies as a successful disposition', async () => {
    await expect(emitPluginLocalEvent({
      pluginId: 'desktop-handoff',
      targetBotAppId: 'cli_target',
      managedSession: false,
      event: {},
    }, {
      findDaemon: vi.fn(() => ({ larkAppId: 'cli_target', ipcPort: 4321 })),
      fetchDaemon: vi.fn(async () => new Response('{"error":"plugin_not_enabled"}', { status: 403 })) as never,
    })).rejects.toThrow('plugin_event_emit_failed:403');
  });

  it('drops an offline event only when the caller explicitly selects best-effort', async () => {
    const onDrop = vi.fn();
    await expect(emitPluginLocalEventBestEffort({
      pluginId: 'desktop-handoff',
      targetBotAppId: 'cli_target',
      managedSession: false,
      event: { hook_event_name: 'Stop' },
    }, {
      findDaemon: vi.fn(() => null),
      fetchDaemon: vi.fn() as never,
      onDrop,
    })).resolves.toEqual({ status: 'dropped' });

    expect(onDrop).toHaveBeenCalledOnce();
    expect(onDrop.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

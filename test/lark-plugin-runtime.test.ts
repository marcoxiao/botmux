import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginRuntimeDir } from '../src/core/plugins/paths.js';
import {
  createLarkPluginDispatcher,
  loadLarkPlugins,
} from '../src/core/plugins/lark-runtime.js';
import { upsertInstalledPlugin } from '../src/services/plugin-registry-store.js';

describe('lark plugin runtime', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-lark-plugin-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function installPlugin(id: string, source: string): void {
    const now = new Date().toISOString();
    upsertInstalledPlugin({
      id,
      packageName: `@botmux/plugin-${id}`,
      version: '0.1.0',
      source: { type: 'local', spec: `/plugins/${id}` },
      manifest: { schemaVersion: 1, id },
      contributions: { lark: { entry: 'lark/index.js' } },
      installedAt: now,
      updatedAt: now,
    });
    const entryDir = join(pluginRuntimeDir(id), 'lark');
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(entryDir, 'index.js'), source);
  }

  it('loads enabled lark contributions in manifest order', async () => {
    installPlugin('desktop-handoff', `
      module.exports = {
        schemaVersion: 1,
        actions: ['desktop-handoff.takeover'],
        handleLocalEvent: async () => ({ status: 'accepted' }),
        handleCardAction: async () => ({ toast: { type: 'success', content: 'ok' } }),
      };
    `);

    const loaded = await loadLarkPlugins(['desktop-handoff']);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].pluginId).toBe('desktop-handoff');
    expect(loaded[0].plugin.actions).toEqual(['desktop-handoff.takeover']);
  });

  it('does not load installed but disabled lark contributions', async () => {
    installPlugin('desktop-handoff', `
      module.exports = {
        schemaVersion: 1,
        actions: [],
        handleLocalEvent: async () => ({ status: 'accepted' }),
      };
    `);

    await expect(loadLarkPlugins([])).resolves.toEqual([]);
  });

  it('loads a message-only contribution and stops after the first claim', async () => {
    installPlugin('observer', `
      module.exports = {
        schemaVersion: 1,
        actions: [],
        handleMessage: async (context) => {
          globalThis.__observerMessage = context;
          return { handled: false };
        },
      };
    `);
    installPlugin('desktop-handoff', `
      module.exports = {
        schemaVersion: 1,
        actions: [],
        handleMessage: async (context, host) => {
          globalThis.__desktopMessage = { context, host };
          return { handled: true };
        },
      };
    `);
    installPlugin('unreachable', `
      module.exports = {
        schemaVersion: 1,
        actions: [],
        handleMessage: async () => {
          globalThis.__unreachableMessage = true;
          return { handled: true };
        },
      };
    `);
    const dispatcher = createLarkPluginDispatcher(
      await loadLarkPlugins(['observer', 'desktop-handoff', 'unreachable']),
      (pluginId, dispatchContext) => ({ pluginId, dispatchContext }),
    );
    const context = {
      larkAppId: 'cli_bot',
      chatId: 'oc_workbench',
      messageId: 'om_input',
      rootMessageId: 'om_root',
      senderOpenId: 'ou_owner',
      text: '从飞书继续',
    };

    await expect(dispatcher.dispatchMessage(context)).resolves.toEqual({ handled: true });
    expect((globalThis as any).__observerMessage).toEqual(context);
    expect((globalThis as any).__desktopMessage).toEqual({
      context,
      host: { pluginId: 'desktop-handoff', dispatchContext: { kind: 'message' } },
    });
    expect((globalThis as any).__unreachableMessage).toBeUndefined();
    delete (globalThis as any).__observerMessage;
    delete (globalThis as any).__desktopMessage;

    await expect(dispatcher.dispatchMessage(context, 'desktop-handoff'))
      .resolves.toEqual({ handled: true });
    expect((globalThis as any).__observerMessage).toBeUndefined();
    expect((globalThis as any).__desktopMessage).toEqual({
      context,
      host: { pluginId: 'desktop-handoff', dispatchContext: { kind: 'message' } },
    });
    delete (globalThis as any).__desktopMessage;
  });

  it('does not swallow a message handler error and accidentally fall back', async () => {
    installPlugin('desktop-handoff', `
      module.exports = {
        schemaVersion: 1,
        actions: [],
        handleMessage: async () => { throw new Error('desktop_ipc_failed'); },
      };
    `);
    const dispatcher = createLarkPluginDispatcher(
      await loadLarkPlugins(['desktop-handoff']),
      () => ({}),
    );

    await expect(dispatcher.dispatchMessage({
      larkAppId: 'cli_bot', chatId: 'oc_workbench', messageId: 'om_input',
      rootMessageId: 'om_root', senderOpenId: 'ou_owner', text: '继续',
    })).rejects.toThrow('desktop_ipc_failed');
  });

  it.each([
    ['bad-schema', `module.exports = { schemaVersion: 2, actions: [], handleLocalEvent: async () => ({}) };`, 'invalid_lark_plugin_schema:bad-schema'],
    ['missing-handlers', `module.exports = { schemaVersion: 1, actions: [] };`, 'invalid_lark_plugin_handlers:missing-handlers'],
    ['missing-card-handler', `module.exports = { schemaVersion: 1, actions: ['missing-card-handler.click'], handleLocalEvent: async () => ({}) };`, 'invalid_lark_plugin_card_handler:missing-card-handler'],
    ['invalid-action', `module.exports = { schemaVersion: 1, actions: ['bad action'], handleCardAction: async () => ({}) };`, 'invalid_lark_plugin_action:invalid-action:bad action'],
    ['foreign-action', `module.exports = { schemaVersion: 1, actions: ['other.click'], handleCardAction: async () => ({}) };`, 'invalid_lark_plugin_action_namespace:foreign-action:other.click'],
  ])('fails closed for %s', async (id, source, message) => {
    installPlugin(id, source);
    await expect(loadLarkPlugins([id])).rejects.toThrow(message);
  });

  it('dispatches a local event only to the explicitly addressed loaded plugin', async () => {
    installPlugin('desktop-handoff', `
      module.exports = {
        schemaVersion: 1,
        actions: [],
        handleLocalEvent: async (event, context, host) => ({ event, context, host }),
      };
    `);
    const dispatcher = createLarkPluginDispatcher(
      await loadLarkPlugins(['desktop-handoff']),
      (pluginId, dispatchContext) => ({ pluginId, dispatchContext }),
    );

    await expect(dispatcher.dispatchLocalEvent(
      'desktop-handoff',
      { type: 'task.completed' },
      { larkAppId: 'cli_bot', managedSession: false },
    )).resolves.toEqual({
      event: { type: 'task.completed' },
      context: { larkAppId: 'cli_bot', managedSession: false },
      host: {
        pluginId: 'desktop-handoff',
        dispatchContext: { kind: 'local-event' },
      },
    });
    await expect(dispatcher.dispatchLocalEvent(
      'disabled-plugin',
      {},
      { larkAppId: 'cli_bot', managedSession: false },
    )).rejects.toThrow('lark_plugin_not_enabled:disabled-plugin');
  });

  it('fails closed when an addressed plugin has no local event handler', async () => {
    installPlugin('action-only', `
      module.exports = {
        schemaVersion: 1,
        actions: ['action-only.click'],
        handleCardAction: async () => ({}),
      };
    `);
    const dispatcher = createLarkPluginDispatcher(
      await loadLarkPlugins(['action-only']),
      () => ({}),
    );

    await expect(dispatcher.dispatchLocalEvent(
      'action-only',
      {},
      { larkAppId: 'cli_bot', managedSession: false },
    )).rejects.toThrow('lark_plugin_local_event_handler_not_found:action-only');
  });

  it('dispatches only declared namespaced card actions and preserves handled undefined', async () => {
    installPlugin('desktop-handoff', `
      module.exports = {
        schemaVersion: 1,
        actions: ['desktop-handoff.takeover'],
        handleCardAction: async (data, context, host) => {
          globalThis.__larkActionCall = { data, context, host };
          return undefined;
        },
      };
    `);
    const dispatcher = createLarkPluginDispatcher(
      await loadLarkPlugins(['desktop-handoff']),
      (pluginId, dispatchContext) => ({ pluginId, dispatchContext }),
    );
    const data = { action: { value: { action: 'desktop-handoff.takeover' } } };

    await expect(dispatcher.dispatchCardAction(
      data,
      { larkAppId: 'cli_bot' },
    )).resolves.toEqual({ handled: true, result: undefined });
    expect((globalThis as any).__larkActionCall).toEqual({
      data,
      context: { larkAppId: 'cli_bot' },
      host: {
        pluginId: 'desktop-handoff',
        dispatchContext: {
          kind: 'card-action',
          operatorOpenId: undefined,
          cardMessageId: undefined,
        },
      },
    });
    await expect(dispatcher.dispatchCardAction(
      { action: { value: { action: 'unknown.click' } } },
      { larkAppId: 'cli_bot' },
    )).resolves.toEqual({ handled: false });
    delete (globalThis as any).__larkActionCall;
  });
});

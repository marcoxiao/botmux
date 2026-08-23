import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginRuntimeDir } from '../src/core/plugins/paths.js';
import { loadLarkPlugins } from '../src/core/plugins/lark-runtime.js';
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
        actions: ['desktop_handoff.takeover'],
        handleLocalEvent: async () => ({ status: 'accepted' }),
        handleCardAction: async () => ({ toast: { type: 'success', content: 'ok' } }),
      };
    `);

    const loaded = await loadLarkPlugins(['desktop-handoff']);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].pluginId).toBe('desktop-handoff');
    expect(loaded[0].plugin.actions).toEqual(['desktop_handoff.takeover']);
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

  it.each([
    ['bad-schema', `module.exports = { schemaVersion: 2, actions: [], handleLocalEvent: async () => ({}) };`, 'invalid_lark_plugin_schema:bad-schema'],
    ['missing-handlers', `module.exports = { schemaVersion: 1, actions: [] };`, 'invalid_lark_plugin_handlers:missing-handlers'],
    ['missing-card-handler', `module.exports = { schemaVersion: 1, actions: ['demo.click'], handleLocalEvent: async () => ({}) };`, 'invalid_lark_plugin_card_handler:missing-card-handler'],
    ['invalid-action', `module.exports = { schemaVersion: 1, actions: ['bad action'], handleCardAction: async () => ({}) };`, 'invalid_lark_plugin_action:invalid-action:bad action'],
  ])('fails closed for %s', async (id, source, message) => {
    installPlugin(id, source);
    await expect(loadLarkPlugins([id])).rejects.toThrow(message);
  });

  it('rejects duplicate action ids across enabled plugins', async () => {
    const source = `module.exports = {
      schemaVersion: 1,
      actions: ['desktop_handoff.takeover'],
      handleCardAction: async () => ({}),
    };`;
    installPlugin('first', source);
    installPlugin('second', source);

    await expect(loadLarkPlugins(['first', 'second']))
      .rejects.toThrow('duplicate_lark_plugin_action:desktop_handoff.takeover:first,second');
  });
});

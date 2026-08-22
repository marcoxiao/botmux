import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginRuntimeDir } from '../src/core/plugins/paths.js';
import {
  loadTurnProgressPlugin,
  resolveTurnProgressPluginId,
} from '../src/core/plugins/runtime.js';
import { upsertInstalledPlugin } from '../src/services/plugin-registry-store.js';

describe('turn progress plugin runtime', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-turn-progress-plugin-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function installPlugin(id: string, source?: string): void {
    const now = new Date().toISOString();
    upsertInstalledPlugin({
      id,
      packageName: `@botmux/plugin-${id}`,
      version: '0.1.0',
      source: { type: 'local', spec: `/plugins/${id}` },
      manifest: { schemaVersion: 1, id },
      contributions: { turnProgress: { entry: 'turn-progress/index.js' } },
      installedAt: now,
      updatedAt: now,
    });
    if (source === undefined) return;
    const entryDir = join(pluginRuntimeDir(id), 'turn-progress');
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(entryDir, 'index.js'), source);
  }

  it('loads the one explicitly selected valid contribution', async () => {
    installPlugin('ignored', 'module.exports = {};\n');
    installPlugin('semantic-progress', `
      module.exports = {
        schemaVersion: 1,
        initialState: () => ({ phase: 'running' }),
        reduce: (state) => state,
        render: () => ({ schema: '2.0', body: { elements: [] } }),
      };
    `);

    expect(resolveTurnProgressPluginId(['semantic-progress'])).toBe('semantic-progress');
    const loaded = await loadTurnProgressPlugin(['semantic-progress']);
    expect(loaded?.pluginId).toBe('semantic-progress');
    expect(loaded?.plugin.render({}, {
      schemaVersion: 1,
      sessionId: 'session-1',
      primaryTurnId: 'turn-1',
      turnId: 'turn-1',
      workerGeneration: 1,
      cliId: 'codex-app',
      locale: 'zh',
      restored: false,
    })).toMatchObject({ schema: '2.0' });
  });

  it('does not fall back to globally installed contributions', async () => {
    installPlugin('semantic-progress', `
      module.exports = {
        schemaVersion: 1,
        initialState: () => ({}),
        reduce: (state) => state,
        render: () => ({ schema: '2.0' }),
      };
    `);

    expect(resolveTurnProgressPluginId([])).toBeUndefined();
    await expect(loadTurnProgressPlugin([])).resolves.toBeUndefined();
  });

  it('rejects multiple selected contributions in manifest order', () => {
    installPlugin('first');
    installPlugin('second');

    expect(() => resolveTurnProgressPluginId(['first', 'second']))
      .toThrow('multiple_turn_progress_plugins:first,second');
  });

  it.each([
    ['bad-schema', `module.exports = {
      schemaVersion: 2,
      initialState: () => ({}),
      reduce: (state) => state,
      render: () => ({ schema: '2.0' }),
    };`, 'invalid_turn_progress_plugin_schema:bad-schema'],
    ['missing-function', `module.exports = {
      schemaVersion: 1,
      initialState: () => ({}),
      render: () => ({ schema: '2.0' }),
    };`, 'invalid_turn_progress_plugin_exports:missing-function'],
    ['array-render', `module.exports = {
      schemaVersion: 1,
      initialState: () => ({}),
      reduce: (state) => state,
      render: () => [],
    };`, 'invalid_turn_progress_plugin_render:array-render'],
  ])('fails closed for %s', async (id, source, message) => {
    installPlugin(id, source);
    await expect(loadTurnProgressPlugin([id])).rejects.toThrow(message);
  });
});

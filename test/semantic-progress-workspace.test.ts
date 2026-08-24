import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const plugin = resolve(root, 'plugins', 'semantic-progress');

describe('Semantic Progress workspace integration', () => {
  it('keeps the imported package identity and workspace build contract', async () => {
    const packagePath = resolve(plugin, 'package.json');
    expect(existsSync(packagePath), 'plugins/semantic-progress/package.json').toBe(true);

    const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as {
      name?: string;
      version?: string;
      private?: boolean;
      files?: string[];
      scripts?: Record<string, string>;
      botmux?: { id?: string; displayName?: string };
    };
    expect(pkg).toMatchObject({
      name: '@botmux-ai/plugin-semantic-progress',
      version: '0.1.0',
      private: true,
      files: ['dist'],
      botmux: {
        id: 'semantic-progress',
        displayName: 'Semantic Progress',
      },
    });
    expect(pkg.scripts?.build).toBe('node scripts/clean-dist.mjs && tsc -p tsconfig.json');

    const vitestPath = resolve(plugin, 'vitest.config.ts');
    expect(existsSync(vitestPath), 'plugins/semantic-progress/vitest.config.ts').toBe(true);
    const vitest = await import(pathToFileURL(vitestPath).href) as {
      default?: { test?: { include?: string[] } };
    };
    expect(vitest.default?.test?.include).toEqual(['test/**/*.test.ts']);
    expect(existsSync(resolve(plugin, '.gitignore'))).toBe(false);
    expect(existsSync(resolve(plugin, 'pnpm-lock.yaml'))).toBe(false);
  });

  it('keeps the fixed source entry and plugin test surface', async () => {
    const srcEntries = await readdir(resolve(plugin, 'src'), { withFileTypes: true });
    expect(srcEntries.map(entry => entry.name).sort()).toEqual([
      'card.ts',
      'reducer.ts',
      'turn-progress',
    ]);
    expect(srcEntries.find(entry => entry.name === 'card.ts')?.isFile()).toBe(true);
    expect(srcEntries.find(entry => entry.name === 'reducer.ts')?.isFile()).toBe(true);
    expect(srcEntries.find(entry => entry.name === 'turn-progress')?.isDirectory()).toBe(true);

    const entryEntries = await readdir(resolve(plugin, 'src', 'turn-progress'), {
      withFileTypes: true,
    });
    expect(entryEntries.map(entry => entry.name)).toEqual(['index.ts']);
    expect(entryEntries[0]?.isFile()).toBe(true);

    const testEntries = await readdir(resolve(plugin, 'test'), { withFileTypes: true });
    expect(testEntries.map(entry => entry.name).sort()).toEqual([
      'build-output.test.ts',
      'card.test.ts',
      'reducer.test.ts',
    ]);
    expect(testEntries.every(entry => entry.isFile())).toBe(true);
    expect(existsSync(resolve(plugin, 'src', 'turn-progress', 'index.ts'))).toBe(true);
  });

  it('keeps the root lock importers aligned with actual plugin workspace packages', async () => {
    const lock = parse(await readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8')) as {
      importers?: Record<string, unknown>;
    };
    expect(lock.importers).toHaveProperty('plugins/semantic-progress');

    const pluginEntries = await readdir(resolve(root, 'plugins'), { withFileTypes: true });
    const workspacePackages = pluginEntries
      .filter(entry => entry.isDirectory())
      .map(entry => `plugins/${entry.name}`)
      .filter(importer => existsSync(resolve(root, importer, 'package.json')))
      .sort();
    const pluginImporters = Object.keys(lock.importers ?? {})
      .filter(importer => importer.startsWith('plugins/'))
      .sort();
    expect(pluginImporters).toEqual(workspacePackages);
  });

  it('documents monorepo development and link installation without the old checkout', async () => {
    const readmePath = resolve(plugin, 'README.md');
    expect(existsSync(readmePath), 'plugins/semantic-progress/README.md').toBe(true);

    const readme = await readFile(readmePath, 'utf8');
    expect(readme).not.toContain('botmux-plugin-semantic-progress');
    expect(readme).toContain('pnpm semantic-progress:check');
    expect(readme).toContain('botmux plugin install ./plugins/semantic-progress --link');
  });

  it('wires explicit root scripts and builds both plugins before Core', async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['semantic-progress:build']).toBe(
      'pnpm --dir plugins/semantic-progress build',
    );
    expect(pkg.scripts?.['semantic-progress:test']).toBe(
      'pnpm --dir plugins/semantic-progress test',
    );
    expect(pkg.scripts?.['semantic-progress:check']).toBe(
      'pnpm --dir plugins/semantic-progress check',
    );

    const build = pkg.scripts?.build ?? '';
    const semanticBuild = build.indexOf('pnpm semantic-progress:build');
    const desktopBuild = build.indexOf('pnpm desktop-handoff:build');
    const audit = build.indexOf('pnpm audit:domains');
    const coreBuild = build.indexOf('node scripts/clean-dist.mjs && tsc');
    expect(semanticBuild).toBeGreaterThanOrEqual(0);
    expect(desktopBuild).toBeGreaterThanOrEqual(0);
    expect(audit).toBeGreaterThanOrEqual(0);
    expect(coreBuild).toBeGreaterThanOrEqual(0);
    expect(semanticBuild).toBeLessThan(audit);
    expect(desktopBuild).toBeLessThan(audit);
    expect(audit).toBeLessThan(coreBuild);
  });

  it('runs both plugin test suites explicitly in CI after the build', async () => {
    const ci = parse(await readFile(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
      jobs?: { build?: { steps?: Array<{ run?: unknown }> } };
    };
    const runs = (ci.jobs?.build?.steps ?? [])
      .map(step => step.run)
      .filter((run): run is string => typeof run === 'string');
    const build = runs.indexOf('pnpm build');
    const semanticTest = runs.indexOf('pnpm semantic-progress:test');
    const desktopTest = runs.indexOf('pnpm desktop-handoff:test');
    expect(runs.filter(run => run === 'pnpm build')).toHaveLength(1);
    expect(runs.filter(run => run === 'pnpm semantic-progress:test')).toHaveLength(1);
    expect(runs.filter(run => run === 'pnpm desktop-handoff:test')).toHaveLength(1);
    expect(semanticTest).toBeGreaterThan(build);
    expect(desktopTest).toBeGreaterThan(build);
  });
});

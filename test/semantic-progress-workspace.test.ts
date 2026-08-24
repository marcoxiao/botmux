import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
      scripts?: Record<string, string>;
      botmux?: { id?: string; displayName?: string };
    };
    expect(pkg).toMatchObject({
      name: '@botmux-ai/plugin-semantic-progress',
      version: '0.1.0',
      private: true,
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
    expect(existsSync(resolve(plugin, 'pnpm-lock.yaml'))).toBe(false);
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
    const ci = await readFile(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const build = ci.indexOf('- run: pnpm build');
    const semanticTest = ci.indexOf('- run: pnpm semantic-progress:test');
    const desktopTest = ci.indexOf('- run: pnpm desktop-handoff:test');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(semanticTest).toBeGreaterThan(build);
    expect(desktopTest).toBeGreaterThan(build);
  });
});

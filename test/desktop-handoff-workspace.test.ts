import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const plugin = resolve(root, 'plugins', 'desktop-handoff');

describe('Desktop Handoff workspace integration', () => {
  it('registers only the plugins directory as the new workspace boundary', async () => {
    const workspace = parse(await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8')) as {
      packages?: string[];
    };
    expect(workspace.packages).toEqual(['plugins/*']);
  });

  it('keeps Desktop Handoff as a self-contained BotMux plugin package', async () => {
    const pkg = JSON.parse(await readFile(resolve(plugin, 'package.json'), 'utf8')) as {
      name?: string;
      private?: boolean;
      botmux?: { id?: string };
    };
    expect(pkg).toMatchObject({
      name: '@botmux-ai/plugin-desktop-handoff',
      private: true,
      botmux: { id: 'desktop-handoff' },
    });
    expect(existsSync(resolve(plugin, 'src', 'lark', 'index.ts'))).toBe(true);
    expect(existsSync(resolve(plugin, 'test', 'lark.test.ts'))).toBe(true);
    expect(existsSync(resolve(plugin, 'pnpm-lock.yaml'))).toBe(false);
  });

  it('builds and checks the plugin explicitly from the BotMux root', async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['desktop-handoff:build']).toBe(
      'pnpm --dir plugins/desktop-handoff build',
    );
    expect(pkg.scripts?.['desktop-handoff:test']).toBe(
      'pnpm --dir plugins/desktop-handoff test',
    );
    expect(pkg.scripts?.['desktop-handoff:check']).toBe(
      'pnpm --dir plugins/desktop-handoff check',
    );
    expect(pkg.scripts?.build?.startsWith('pnpm desktop-handoff:build && ')).toBe(true);
  });

  it('keeps historical Desktop Handoff decisions in the root documentation tree', () => {
    for (const path of [
      'docs/superpowers/plans/2026-08-23-traex-desktop-handoff.md',
      'docs/superpowers/plans/2026-08-24-same-chat-routing-and-hook-recovery.md',
      'docs/superpowers/specs/2026-08-23-traex-desktop-handoff-design.md',
      'docs/superpowers/specs/2026-08-24-same-chat-routing-and-hook-recovery-design.md',
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }
  });
});

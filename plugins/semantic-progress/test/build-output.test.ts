import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const distUrl = new URL('../dist/', import.meta.url);
const dist = fileURLToPath(distUrl);

describe('build output', () => {
  it('cleans stale output and emits the turn-progress entrypoint', async () => {
    const staleMarker = new URL('semantic-progress-stale.marker', distUrl);
    await mkdir(dist, { recursive: true });
    await writeFile(staleMarker, 'stale build output', 'utf8');
    expect(existsSync(staleMarker)).toBe(true);

    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    await execute(pnpm, ['build'], { cwd: pluginRoot });

    expect(existsSync(staleMarker)).toBe(false);
    expect(existsSync(new URL('turn-progress/index.js', distUrl))).toBe(true);
    expect(existsSync(new URL('turn-progress/index.d.ts', distUrl))).toBe(true);
  }, 30_000);
});

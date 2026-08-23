import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertLiveCheckout } from '../scripts/live-checkout-pin.mjs';

describe('live checkout pin', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'botmux-live-checkout-'));
    roots.push(root);
    const canonical = join(root, 'canonical');
    const other = join(root, 'other');
    const alias = join(root, 'alias');
    const pinPath = join(root, 'live-checkout');
    return { root, canonical, other, alias, pinPath };
  }

  it('allows the pinned checkout, including a symlink alias', () => {
    const { canonical, alias, pinPath } = fixture();
    writeFileSync(canonical, 'checkout');
    symlinkSync(canonical, alias);
    writeFileSync(pinPath, `${canonical}\n`);

    expect(() => assertLiveCheckout(alias, pinPath)).not.toThrow();
    expect(realpathSync(alias)).toBe(realpathSync(canonical));
  });

  it('rejects a different checkout before it can mutate the shared runtime', () => {
    const { canonical, other, pinPath } = fixture();
    writeFileSync(canonical, 'canonical');
    writeFileSync(other, 'other');
    writeFileSync(pinPath, `${canonical}\n`);

    expect(() => assertLiveCheckout(other, pinPath)).toThrow(
      /BotMux 线上运行源已固定.*canonical.*other/s,
    );
  });

  it('keeps ordinary upstream behavior when no pin is configured', () => {
    const { other, pinPath } = fixture();
    writeFileSync(other, 'other');

    expect(() => assertLiveCheckout(other, pinPath)).not.toThrow();
  });
});

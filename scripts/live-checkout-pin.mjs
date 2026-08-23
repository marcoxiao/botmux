import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function liveCheckoutPinPath() {
  return resolve(homedir(), '.botmux', '.live-checkout');
}

function canonicalPath(path) {
  return realpathSync(resolve(path));
}

/**
 * Optional guard for one shared ~/.botmux runtime.
 *
 * Upstream keeps its normal "last checkout wins" behavior when the pin file is
 * absent.  Operators that share several worktrees can pin one production
 * checkout and make every other updated checkout fail before touching PM2 or
 * the global wrapper.
 */
export function assertLiveCheckout(checkout, pinPath = liveCheckoutPinPath()) {
  if (!existsSync(pinPath)) return;
  const configured = readFileSync(pinPath, 'utf8').trim();
  if (!configured) throw new Error(`BotMux 线上运行源配置为空: ${pinPath}`);

  const pinned = canonicalPath(configured);
  const candidate = canonicalPath(checkout);
  if (pinned === candidate) return;

  throw new Error(
    `BotMux 线上运行源已固定为 ${pinned}；拒绝由 ${candidate} 改写共享运行时。\n`
    + `如确需切换，请在目标 checkout 执行 BOTMUX_FORCE_LIVE_CHECKOUT=1 pnpm use:here。`,
  );
}

export function pinLiveCheckout(checkout, pinPath = liveCheckoutPinPath()) {
  writeFileSync(pinPath, `${canonicalPath(checkout)}\n`, { mode: 0o600 });
}

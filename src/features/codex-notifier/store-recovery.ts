import { existsSync, lstatSync, renameSync } from 'node:fs';

export interface CodexNotifierStoreRecoveryOptions<T> {
  filePath: string;
  open: () => T;
  logWarn: (message: string) => void;
  now?: () => number;
}

/** Preserve a corrupt local ledger for diagnosis, then start from an empty one. */
export function openCodexNotifierStoreWithRecovery<T>(
  options: CodexNotifierStoreRecoveryOptions<T>,
): T {
  try {
    return options.open();
  } catch (error) {
    if (!existsSync(options.filePath)) throw error;
    const stat = lstatSync(options.filePath);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw error;

    const timestamp = new Date(options.now?.() ?? Date.now())
      .toISOString()
      .replace(/[-:.]/g, '');
    let quarantinePath = `${options.filePath}.corrupt-${timestamp}`;
    let suffix = 1;
    while (existsSync(quarantinePath)) {
      quarantinePath = `${options.filePath}.corrupt-${timestamp}-${suffix}`;
      suffix += 1;
    }
    renameSync(options.filePath, quarantinePath);
    options.logWarn(
      `[codex-notifier] 本地状态损坏，已隔离到 ${quarantinePath} 并重建空账本: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return options.open();
  }
}

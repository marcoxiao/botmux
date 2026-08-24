import { execFile } from 'node:child_process';

export type AppRunner = (file: string, args: readonly string[]) => Promise<void>;

const systemRunner: AppRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 10_000 }, error => error ? reject(error) : resolve());
});

export async function openTraexApp(run: AppRunner = systemRunner): Promise<{ ok: boolean; error?: string }> {
  try {
    await run('/usr/bin/open', ['-a', 'Traex']);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

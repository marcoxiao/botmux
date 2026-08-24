import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('build output', () => {
  it('不保留已删除的 Codex-only 历史模块', () => {
    expect(existsSync(join(process.cwd(), 'dist', 'codex-context.js'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'dist', 'codex-context.d.ts'))).toBe(false);
  });
});

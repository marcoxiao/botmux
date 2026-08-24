import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('package contents', () => {
  it('发布包包含运行产物、文档和一次性迁移命令', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      files?: string[];
    };
    expect(pkg.files).toEqual(expect.arrayContaining([
      'dist',
      'README.md',
      'scripts/migrate-ledger-v2.mjs',
    ]));
    expect(pkg.files).not.toContain('scripts/clean-dist.mjs');
  });
});

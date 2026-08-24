import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDesktopContext } from '../src/desktop-context.js';
import { CODEX_PROVIDER, TRAEX_PROVIDER } from '../src/provider.js';

const THREAD_ID = '01a02d9c-fb00-7042-a396-ee9529207d03';

async function transcript(payload: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-handoff-context-'));
  const path = join(dir, 'rollout.jsonl');
  await writeFile(path, `${JSON.stringify({
    type: 'session_meta',
    payload: { id: THREAD_ID, cwd: '/workspace/app', ...payload },
  })}\n`);
  return path;
}

describe('readDesktopContext', () => {
  it('只接受 Codex Desktop 用户主会话', async () => {
    const desktop = await transcript({ source: 'vscode', originator: 'Codex Desktop' });
    await expect(readDesktopContext(desktop, THREAD_ID, CODEX_PROVIDER)).resolves.toMatchObject({
      desktop: true,
      cwd: '/workspace/app',
    });
    await expect(readDesktopContext(
      await transcript({ source: 'vscode', originator: 'Codex Desktop', subagent: true }),
      THREAD_ID,
      CODEX_PROVIDER,
    )).resolves.toMatchObject({ desktop: false });
    await expect(readDesktopContext(
      await transcript({ source: 'vscode', originator: 'Codex Desktop', thread_source: 'subagent' }),
      THREAD_ID,
      CODEX_PROVIDER,
    )).resolves.toMatchObject({ desktop: false });
  });

  it.each(['vscode', 'cli'])('接受 TraeX Desktop 的 %s 来源', async source => {
    const path = await transcript({ source, originator: 'Codex Desktop', model_provider: 'trae' });
    await expect(readDesktopContext(path, THREAD_ID, TRAEX_PROVIDER)).resolves.toMatchObject({
      desktop: true,
      cwd: '/workspace/app',
    });
  });

  it('接受包含大型工具定义的 TraeX Desktop session_meta', async () => {
    const path = await transcript({
      source: 'vscode',
      originator: 'Codex Desktop',
      model_provider: 'trae',
      base_instructions: 'x'.repeat(1_500_000),
    });
    await expect(readDesktopContext(path, THREAD_ID, TRAEX_PROVIDER)).resolves.toMatchObject({
      desktop: true,
      cwd: '/workspace/app',
    });
  });

  it('拒绝 CLI、Provider 串线和 session ID 不一致', async () => {
    const tui = await transcript({ source: 'cli', originator: 'codex-tui', model_provider: 'trae' });
    await expect(readDesktopContext(tui, THREAD_ID, TRAEX_PROVIDER)).resolves.toMatchObject({ desktop: false });

    const traex = await transcript({ source: 'vscode', originator: 'Codex Desktop', model_provider: 'trae' });
    await expect(readDesktopContext(traex, THREAD_ID, CODEX_PROVIDER)).resolves.toMatchObject({ desktop: false });
    await expect(readDesktopContext(traex, '01a02d9c-fb00-7042-a396-ee9529207d04', TRAEX_PROVIDER))
      .resolves.toMatchObject({ desktop: false });
  });

  it('提取明确用户请求并移除环境与附件噪声', async () => {
    const context = await readDesktopContext(
      await transcript({ source: 'vscode', originator: 'Codex Desktop' }),
      THREAD_ID,
      CODEX_PROVIDER,
    );
    expect(context.normalizePrompt(`
<in-app-browser-context>ignore</in-app-browser-context>
<environment_context>ignore</environment_context>
# Files mentioned by the user:\n/private/a.png
## My request:\n  请检查双端链路
`)).toBe('请检查双端链路');
  });
});

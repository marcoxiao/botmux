import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODEX_PROVIDER,
  resolveBotConfig,
  TRAEX_PROVIDER,
} from '../src/provider.js';

const CODEX_APP_ID = 'cli_codex';
const TRAEX_APP_ID = 'cli_traex';
const WORKBENCH_CHAT_ID = 'oc_workbench';

const config = {
  bots: {
    [CODEX_APP_ID]: { provider: 'codex', workbenchChatId: WORKBENCH_CHAT_ID },
    [TRAEX_APP_ID]: { provider: 'traex', workbenchChatId: WORKBENCH_CHAT_ID },
  },
};

describe('desktop providers', () => {
  it('按已认证的飞书应用解析固定 Provider', () => {
    expect(resolveBotConfig(config, CODEX_APP_ID)).toMatchObject({
      larkAppId: CODEX_APP_ID,
      workbenchChatId: WORKBENCH_CHAT_ID,
      provider: { id: 'codex', productName: 'Codex' },
    });
    expect(resolveBotConfig(config, TRAEX_APP_ID)).toMatchObject({
      larkAppId: TRAEX_APP_ID,
      workbenchChatId: WORKBENCH_CHAT_ID,
      provider: { id: 'traex', productName: 'TraeX' },
    });
    expect(resolveBotConfig(config, 'cli_unknown')).toBeUndefined();
  });

  it('拒绝未知 Provider 和不完整 Bot 配置', () => {
    expect(resolveBotConfig({ bots: { [CODEX_APP_ID]: { provider: 'other', workbenchChatId: WORKBENCH_CHAT_ID } } }, CODEX_APP_ID))
      .toBeUndefined();
    expect(resolveBotConfig({ bots: { [CODEX_APP_ID]: { provider: 'codex', workbenchChatId: ' ' } } }, CODEX_APP_ID))
      .toBeUndefined();
  });

  it('socket 路径固定在各自 Desktop 目录', () => {
    expect(CODEX_PROVIDER.socketPath()).toBe(join(homedir(), '.codex', 'ipc', 'ipc.sock'));
    expect(TRAEX_PROVIDER.socketPath()).toBe(join(homedir(), '.trae', 'cli', 'ipc', 'ipc.sock'));
  });
});

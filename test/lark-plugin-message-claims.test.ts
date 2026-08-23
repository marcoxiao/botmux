import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LarkPluginMessageClaimStore } from '../src/core/plugins/lark-message-claims.js';

describe('LarkPluginMessageClaimStore', () => {
  it('durably remembers plugin-owned roots independently of plugin enablement', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'botmux-plugin-claims-')), 'claims.json');
    const first = new LarkPluginMessageClaimStore(path);
    first.claim({
      pluginId: 'desktop-handoff',
      larkAppId: 'cli_bot',
      chatId: 'oc_workbench',
      rootMessageId: 'om_root',
      aliases: ['omt_thread'],
    });

    const restored = new LarkPluginMessageClaimStore(path);
    expect(restored.resolve('cli_bot', 'om_root')).toEqual({
      pluginId: 'desktop-handoff', rootMessageId: 'om_root',
    });
    expect(restored.resolve('cli_bot', 'omt_thread')).toEqual({
      pluginId: 'desktop-handoff', rootMessageId: 'om_root',
    });
    expect(restored.resolve('cli_other', 'om_root')).toBeUndefined();
    expect(restored.resolve('cli_bot', 'om_unknown')).toBeUndefined();
  });

  it('drops unknown legacy fields when the claim file is next written', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'botmux-plugin-claims-')), 'claims.json');
    writeFileSync(path, `${JSON.stringify({
      version: 1,
      claims: {},
      exclusiveChats: {
        'cli_bot\u0000oc_workbench': {
          pluginId: 'desktop-handoff',
          larkAppId: 'cli_bot',
          chatId: 'oc_workbench',
          claimedAt: 1,
        },
      },
    })}\n`);
    const store = new LarkPluginMessageClaimStore(path);
    store.claim({
      pluginId: 'desktop-handoff',
      larkAppId: 'cli_bot',
      chatId: 'oc_workbench',
      rootMessageId: 'om_root',
    });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      claims: expect.any(Object),
    });
  });
});

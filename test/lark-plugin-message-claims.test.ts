import { mkdtempSync } from 'node:fs';
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
    expect(restored.hasExclusiveChat('cli_bot', 'oc_workbench')).toBe(false);
    restored.claimExclusiveChat('desktop-handoff', 'cli_bot', 'oc_workbench');
    expect(new LarkPluginMessageClaimStore(path).hasExclusiveChat('cli_bot', 'oc_workbench')).toBe(true);
    expect(restored.hasExclusiveChat('cli_bot', 'oc_other')).toBe(false);
  });

  it('does not let two plugins own the same dedicated chat', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'botmux-plugin-claims-')), 'claims.json');
    const store = new LarkPluginMessageClaimStore(path);
    store.claimExclusiveChat('desktop-handoff', 'cli_bot', 'oc_workbench');
    expect(() => store.claimExclusiveChat('other-plugin', 'cli_bot', 'oc_workbench'))
      .toThrow('lark_plugin_exclusive_chat_already_claimed');
  });
});

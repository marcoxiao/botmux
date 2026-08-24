# Desktop Handoff Monorepo Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Desktop Handoff into `botmux/plugins/desktop-handoff` as the only source package, build it from the BotMux root, and point the live plugin installation at the in-repository `dist`.

**Architecture:** Keep Desktop Handoff behind the existing BotMux plugin manifest and Lark Host protocol. Add a narrowly scoped pnpm workspace for `plugins/*`, keep package-local source/tests/scripts, and make the root build produce both plugin and Core artifacts without importing plugin business code into `src/`.

**Tech Stack:** Node.js 22, TypeScript, pnpm 9 workspace, Vitest, BotMux local linked-plugin installer, PM2.

---

### Task 1: Define the repository integration contract with a failing test

**Files:**
- Create: `test/desktop-handoff-workspace.test.ts`
- Read: `package.json`
- Read: `docs/superpowers/specs/2026-08-24-desktop-handoff-monorepo-integration-design.md`

- [ ] **Step 1: Add the structural contract test**

```ts
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const plugin = resolve(root, 'plugins', 'desktop-handoff');

describe('Desktop Handoff workspace integration', () => {
  it('registers only the plugins directory as the new workspace boundary', async () => {
    const workspace = parse(await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8')) as {
      packages?: string[];
    };
    expect(workspace.packages).toEqual(['plugins/*']);
  });

  it('keeps Desktop Handoff as a self-contained BotMux plugin package', async () => {
    const pkg = JSON.parse(await readFile(resolve(plugin, 'package.json'), 'utf8')) as {
      name?: string;
      private?: boolean;
      botmux?: { id?: string };
    };
    expect(pkg).toMatchObject({
      name: '@botmux-ai/plugin-desktop-handoff',
      private: true,
      botmux: { id: 'desktop-handoff' },
    });
    expect(existsSync(resolve(plugin, 'src', 'lark', 'index.ts'))).toBe(true);
    expect(existsSync(resolve(plugin, 'test', 'lark.test.ts'))).toBe(true);
    expect(existsSync(resolve(plugin, 'pnpm-lock.yaml'))).toBe(false);
  });

  it('builds and checks the plugin explicitly from the BotMux root', async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['desktop-handoff:build'])
      .toBe('pnpm --dir plugins/desktop-handoff build');
    expect(pkg.scripts?.['desktop-handoff:test'])
      .toBe('pnpm --dir plugins/desktop-handoff test');
    expect(pkg.scripts?.['desktop-handoff:check'])
      .toBe('pnpm --dir plugins/desktop-handoff check');
    expect(pkg.scripts?.build?.startsWith('pnpm desktop-handoff:build && ')).toBe(true);
  });

  it('keeps historical Desktop Handoff decisions in the root documentation tree', () => {
    for (const path of [
      'docs/superpowers/plans/2026-08-23-traex-desktop-handoff.md',
      'docs/superpowers/plans/2026-08-24-same-chat-routing-and-hook-recovery.md',
      'docs/superpowers/specs/2026-08-23-traex-desktop-handoff-design.md',
      'docs/superpowers/specs/2026-08-24-same-chat-routing-and-hook-recovery-design.md',
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
pnpm exec vitest run --project unit test/desktop-handoff-workspace.test.ts
```

Expected: FAIL because `pnpm-workspace.yaml` and `plugins/desktop-handoff/package.json` do not exist.

### Task 2: Move the package and establish the workspace

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `plugins/desktop-handoff/README.md`
- Create: `plugins/desktop-handoff/package.json`
- Create: `plugins/desktop-handoff/tsconfig.json`
- Create: `plugins/desktop-handoff/src/**`
- Create: `plugins/desktop-handoff/test/**`
- Create: `plugins/desktop-handoff/scripts/**`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Test: `test/desktop-handoff-workspace.test.ts`

- [ ] **Step 1: Copy only the package-owned final sources**

Run from `/Users/bytedance/AiProjects/botmux`:

```sh
mkdir -p plugins/desktop-handoff
cp -R /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/src plugins/desktop-handoff/src
cp -R /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/test plugins/desktop-handoff/test
cp -R /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/scripts plugins/desktop-handoff/scripts
cp /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/package.json plugins/desktop-handoff/package.json
cp /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/tsconfig.json plugins/desktop-handoff/tsconfig.json
cp /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/README.md plugins/desktop-handoff/README.md
```

Do not copy `.git`, `.gitignore`, `dist`, `node_modules`, or the package-local `pnpm-lock.yaml`.

- [ ] **Step 2: Add the narrow workspace declaration**

```yaml
packages:
  - 'plugins/*'
```

- [ ] **Step 3: Add root build and verification scripts**

Add these scripts to the root `package.json`:

```json
{
  "desktop-handoff:build": "pnpm --dir plugins/desktop-handoff build",
  "desktop-handoff:test": "pnpm --dir plugins/desktop-handoff test",
  "desktop-handoff:check": "pnpm --dir plugins/desktop-handoff check"
}
```

Change the root build prefix from:

```json
"build": "pnpm audit:domains && ..."
```

to:

```json
"build": "pnpm desktop-handoff:build && pnpm audit:domains && ..."
```

- [ ] **Step 4: Regenerate the single root lock file**

Run:

```sh
pnpm install --lockfile-only --ignore-scripts
```

Expected: root `pnpm-lock.yaml` contains importer `plugins/desktop-handoff`; no nested lock file exists.

- [ ] **Step 5: Run the integration contract and verify GREEN**

Run:

```sh
pnpm exec vitest run --project unit test/desktop-handoff-workspace.test.ts
```

Expected: the first three tests pass; only the historical-document test remains red until Task 3.

### Task 3: Consolidate the engineering history

**Files:**
- Create: `docs/superpowers/plans/2026-08-23-traex-desktop-handoff.md`
- Create: `docs/superpowers/plans/2026-08-24-same-chat-routing-and-hook-recovery.md`
- Create: `docs/superpowers/specs/2026-08-23-traex-desktop-handoff-design.md`
- Create: `docs/superpowers/specs/2026-08-24-same-chat-routing-and-hook-recovery-design.md`
- Test: `test/desktop-handoff-workspace.test.ts`

- [ ] **Step 1: Copy the four final design records into the root docs tree**

Run from `/Users/bytedance/AiProjects/botmux`:

```sh
cp /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/docs/superpowers/plans/2026-08-23-traex-desktop-handoff.md docs/superpowers/plans/
cp /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/docs/superpowers/plans/2026-08-24-same-chat-routing-and-hook-recovery.md docs/superpowers/plans/
cp /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/docs/superpowers/specs/2026-08-23-traex-desktop-handoff-design.md docs/superpowers/specs/
cp /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/docs/superpowers/specs/2026-08-24-same-chat-routing-and-hook-recovery-design.md docs/superpowers/specs/
```

- [ ] **Step 2: Re-run the structural contract**

Run:

```sh
pnpm exec vitest run --project unit test/desktop-handoff-workspace.test.ts
```

Expected: 4 tests pass, including all four root documentation paths.

- [ ] **Step 3: Commit the source integration**

Run:

```sh
git add package.json pnpm-lock.yaml pnpm-workspace.yaml test/desktop-handoff-workspace.test.ts plugins/desktop-handoff
git add -f docs/superpowers/plans/2026-08-23-traex-desktop-handoff.md docs/superpowers/plans/2026-08-24-same-chat-routing-and-hook-recovery.md docs/superpowers/specs/2026-08-23-traex-desktop-handoff-design.md docs/superpowers/specs/2026-08-24-same-chat-routing-and-hook-recovery-design.md
git commit -m "feat(plugin): integrate desktop handoff workspace"
```

Expected: the commit excludes `CLAUDE.md` and `.superpowers/` user changes.

### Task 4: Verify package and Core behavior before cutover

**Files:**
- Verify: `plugins/desktop-handoff/**`
- Verify: `src/core/plugins/**`
- Verify: `test/lark-plugin-*.test.ts`

- [ ] **Step 1: Run the package's full check**

Run:

```sh
pnpm desktop-handoff:check
```

Expected: TypeScript build passes and all 52 plugin tests pass.

- [ ] **Step 2: Run Core integration tests**

Run:

```sh
pnpm exec vitest run --project unit \
  test/desktop-handoff-workspace.test.ts \
  test/lark-plugin-message-routing.test.ts \
  test/lark-plugin-message-claims.test.ts \
  test/lark-plugin-runtime.test.ts \
  test/plugin-card-action-dispatch.test.ts \
  test/plugin-local-event-client.test.ts \
  test/plugin-local-event-ingress.test.ts \
  test/plugin-service-link-watch.test.ts
```

Expected: all selected files pass.

- [ ] **Step 3: Run TypeScript and full build**

Run:

```sh
pnpm exec tsc --noEmit
pnpm build
```

Expected: both commands exit 0; root build first rebuilds `plugins/desktop-handoff/dist`, then creates audited Core `dist`.

### Task 5: Atomically cut over the live plugin

**Files:**
- Runtime link: `~/.botmux/plugins/desktop-handoff/dist`
- Runtime registry: `~/.botmux/plugins-registry.json`
- Runtime state preserved: `~/.botmux/plugins/desktop-handoff/config.json`
- Runtime state preserved: `~/.botmux/plugins/desktop-handoff/desktop-handoff-ledger.json`
- Runtime claims preserved: `~/.botmux/lark-plugin-message-claims.json`

- [ ] **Step 1: Snapshot the current source and runtime link**

Run read-only checks:

```sh
git status --short
readlink ~/.botmux/plugins/desktop-handoff/dist
```

Expected: source link still targets the external repository before cutover; unrelated user changes are visible and untouched.

- [ ] **Step 2: Reinstall through the existing atomic installer**

Run:

```sh
node dist/cli.js plugin install ./plugins/desktop-handoff --link
```

Expected: install reports `desktop-handoff`; config, ledger, settings and claims remain present.

- [ ] **Step 3: Verify the unique internal link and registry source**

Run:

```sh
readlink ~/.botmux/plugins/desktop-handoff/dist
node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.env.HOME+'/.botmux/plugins-registry.json'));console.log(x.plugins['desktop-handoff'])"
```

Expected: link target is `/Users/bytedance/AiProjects/botmux/plugins/desktop-handoff/dist`; registry local spec is `/Users/bytedance/AiProjects/botmux/plugins/desktop-handoff` with `link: true`.

- [ ] **Step 4: Restart and verify the single process topology**

Run:

```sh
pnpm daemon:restart
pnpm daemon:status
```

Expected: exactly `botmux-0`, `botmux-1`, and `botmux-dashboard` are online under one PM2 supervisor; any worker children belong to restored active sessions.

### Task 6: Run post-cutover acceptance and deep review

**Files:**
- Review: `plugins/desktop-handoff/src/**`
- Review: `plugins/desktop-handoff/test/**`
- Review: `package.json`
- Review: `pnpm-workspace.yaml`
- Review: `pnpm-lock.yaml`
- Review: `src/core/plugins/**`

- [ ] **Step 1: Verify runtime state invariants**

Run:

```sh
node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.env.HOME+'/.botmux/lark-plugin-message-claims.json'));console.log({keys:Object.keys(x),claims:Object.keys(x.claims||{}).length,hasExclusiveChats:Object.hasOwn(x,'exclusiveChats')})"
```

Expected: keys are only `version` and `claims`; `hasExclusiveChats` is false.

- [ ] **Step 2: Emit real Codex and TraeX completion events using current Desktop transcripts**

Run the exact four events below:

```sh
node -e 'process.stdout.write(JSON.stringify({hook_event_name:"UserPromptSubmit",session_id:"01a02f6a-22f8-7cf3-8bf1-c6dab1354cec",turn_id:"monorepo-acceptance-codex-20260824",transcript_path:"/Users/bytedance/.codex/sessions/2026/08/24/rollout-2026-08-24T00-18-00-01a02f6a-22f8-7cf3-8bf1-c6dab1354cec.jsonl",cwd:"/Users/bytedance/Documents/Codex/2026-08-24/xiu",prompt:"BOTMUX monorepo Codex Handoff 验收"}))' | ~/.botmux/bin/botmux plugin emit desktop-handoff --bot cli_aa9f099867385ccc
node -e 'process.stdout.write(JSON.stringify({hook_event_name:"Stop",session_id:"01a02f6a-22f8-7cf3-8bf1-c6dab1354cec",turn_id:"monorepo-acceptance-codex-20260824",transcript_path:"/Users/bytedance/.codex/sessions/2026/08/24/rollout-2026-08-24T00-18-00-01a02f6a-22f8-7cf3-8bf1-c6dab1354cec.jsonl",cwd:"/Users/bytedance/Documents/Codex/2026-08-24/xiu",last_assistant_message:"Codex monorepo Handoff 链路可达。"}))' | ~/.botmux/bin/botmux plugin emit desktop-handoff --bot cli_aa9f099867385ccc
node -e 'process.stdout.write(JSON.stringify({hook_event_name:"UserPromptSubmit",session_id:"01a02f69-c842-7c33-ae02-7755e27c6f37",turn_id:"monorepo-acceptance-traex-20260824",transcript_path:"/Users/bytedance/.trae/cli/sessions/2026/08/24/rollout-2026-08-24T00-17-36-01a02f69-c842-7c33-ae02-7755e27c6f37.jsonl",cwd:"/Users/bytedance/AiProjects/ai-native-platform-frontend",prompt:"BOTMUX monorepo TraeX Handoff 验收"}))' | ~/.botmux/bin/botmux plugin emit desktop-handoff --bot cli_aa033b41d0f8dd1c
node -e 'process.stdout.write(JSON.stringify({hook_event_name:"Stop",session_id:"01a02f69-c842-7c33-ae02-7755e27c6f37",turn_id:"monorepo-acceptance-traex-20260824",transcript_path:"/Users/bytedance/.trae/cli/sessions/2026/08/24/rollout-2026-08-24T00-17-36-01a02f69-c842-7c33-ae02-7755e27c6f37.jsonl",cwd:"/Users/bytedance/AiProjects/ai-native-platform-frontend",last_assistant_message:"TraeX monorepo Handoff 链路可达。"}))' | ~/.botmux/bin/botmux plugin emit desktop-handoff --bot cli_aa033b41d0f8dd1c
```

Then verify the plugin ledger records both native turn IDs with `delivery: "delivered"`, the correct `larkAppId`, `provider`, `threadId`, and a root message ID.

- [ ] **Step 3: Verify the already completed inbound routing evidence remains valid**

Check the Feishu root threads, daemon logs, ledger and Desktop rollouts for:

```text
ordinary new topic -> BotMux Session -> NORMAL-ROUTE-OK
Codex root claim -> Codex Desktop -> same root thread reply
TraeX root claim -> TraeX Desktop -> same root thread reply
```

Do not count a message posted under an ordinary BotMux Session thread as Handoff evidence, even if its text contains `HANDOFF`.

- [ ] **Step 4: Run final automated verification**

Run:

```sh
pnpm desktop-handoff:check
pnpm exec vitest run --project unit test/desktop-handoff-workspace.test.ts test/lark-plugin-message-routing.test.ts test/lark-plugin-message-claims.test.ts test/lark-plugin-runtime.test.ts test/plugin-card-action-dispatch.test.ts test/plugin-local-event-client.test.ts test/plugin-local-event-ingress.test.ts test/plugin-service-link-watch.test.ts
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Review against minimal-plugin constraints**

Confirm all of the following from the final diff:

```text
no Core import from plugins/desktop-handoff
no plugin import from BotMux src private modules
no external repository path in tracked runtime/build configuration
no duplicate lock file
no compatibility fallback to the old source path
no new daemon or service
no changes to user-owned CLAUDE.md or .superpowers files
```

- [ ] **Step 6: Commit any verification-only corrections**

If review finds an in-scope defect, first add a failing regression test, apply the smallest fix, re-run Step 4, and commit only those files with a focused `fix(plugin): ...` message. If review finds no defect, create no empty commit.

### Task 7: Retire the external repository only with explicit approval

**Files:**
- Candidate removal: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff`

- [ ] **Step 1: Prove no live or tracked dependency remains**

Run:

```sh
rg -n '/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff|botmux-plugin-desktop-handoff' /Users/bytedance/AiProjects/botmux ~/.botmux/plugins-registry.json ~/.codex/hooks.json ~/.trae/cli/hooks.json
readlink ~/.botmux/plugins/desktop-handoff/dist
```

Expected: the absolute external path is absent from tracked/runtime configuration and the live link targets the in-repository package. Repository-name references are allowed only in migrated historical documents where they describe past state.

- [ ] **Step 2: Ask for destructive cleanup approval**

Present the exact path `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff`, state that the integrated BotMux commit is the new source of truth, and do not delete until the user explicitly authorizes removal.

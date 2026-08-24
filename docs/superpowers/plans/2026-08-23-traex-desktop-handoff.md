# TraeX Desktop Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing thin Desktop Handoff plugin so the Codex and TraeX Feishu bots independently adopt and continue their corresponding Desktop sessions in one CardKit workbench.

**Architecture:** Keep one shared Lark/CardKit/ledger flow and select one of two immutable provider descriptors from the authenticated Lark App ID. Store every route under `larkAppId + provider + threadId`; reuse the existing owner/follower IPC protocol with a provider-specific fixed socket. Migrate the current Codex ledger once before enabling TraeX, without adding BotMux core branches.

**Tech Stack:** TypeScript, Node.js built-ins, Vitest, BotMux Lark plugin v1, Codex/TraeX Desktop owner/follower IPC, Feishu CardKit.

---

## File map

- Create `src/provider.ts`: static Codex/TraeX provider definitions and global Bot-to-provider config parsing.
- Replace `src/codex-context.ts` with `src/desktop-context.ts`: provider-aware Desktop transcript provenance parsing.
- Modify `src/desktop-ipc.ts`: keep one protocol client; require the selected provider socket at call sites and expose busy distinctly.
- Modify `src/types.ts`: provider, bot and composite Desktop identity types.
- Modify `src/event.ts`: include the composite identity in deterministic event IDs.
- Modify `src/store.ts`: version 2 composite ledger only.
- Create `scripts/migrate-ledger-v2.mjs`: validate and atomically convert the current version 1 Codex ledger.
- Modify `src/card.ts`: render Codex/TraeX product names from the event or route.
- Modify `src/lark/index.ts`: resolve provider from authenticated Bot context and pass its socket through every operation.
- Modify `README.md`: dual-Bot configuration, hook commands and runtime boundary.
- Add or modify tests beside each source responsibility.

### Task 1: Provider configuration and Desktop provenance

**Files:**
- Create: `src/provider.ts`
- Create: `src/desktop-context.ts`
- Delete: `src/codex-context.ts`
- Modify: `src/types.ts`
- Create: `test/provider.test.ts`
- Modify: `test/codex-context.test.ts` (rename to `test/desktop-context.test.ts`)

- [ ] **Step 1: Write failing provider and provenance tests**

Cover these exact cases:

```ts
expect(resolveBotConfig(config, CODEX_APP_ID)?.provider.id).toBe('codex');
expect(resolveBotConfig(config, TRAEX_APP_ID)?.provider.id).toBe('traex');
expect(resolveBotConfig(config, 'cli_unknown')).toBeUndefined();
expect(CODEX_PROVIDER.socketPath()).toBe(join(homedir(), '.codex', 'ipc', 'ipc.sock'));
expect(TRAEX_PROVIDER.socketPath()).toBe(join(homedir(), '.trae', 'cli', 'ipc', 'ipc.sock'));
```

Transcript tests must accept Codex Desktop, accept TraeX Desktop with `source: "vscode"` and `source: "cli"`, and reject `originator: "codex-tui"`, provider mismatch, subagent/internal threads and mismatched session IDs.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm vitest run test/provider.test.ts test/desktop-context.test.ts
```

Expected: fail because provider and generic Desktop context APIs do not exist.

- [ ] **Step 3: Implement the minimal static provider model**

Use plain values, not classes:

```ts
export type ProviderId = 'codex' | 'traex';

export interface DesktopProvider {
  id: ProviderId;
  productName: 'Codex' | 'TraeX';
  socketPath(): string;
  matchesMeta(meta: Record<string, unknown>): boolean;
}

export interface BotConfig {
  larkAppId: string;
  workbenchChatId: string;
  provider: DesktopProvider;
}
```

`resolveBotConfig` accepts only the two provider IDs and non-empty workbench chat IDs. `readDesktopContext` reuses the current bounded session-meta read and prompt cleaning logic, then delegates provenance to `matchesMeta`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all provider/context tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/provider.ts src/desktop-context.ts src/types.ts test/provider.test.ts test/desktop-context.test.ts
git rm src/codex-context.ts test/codex-context.test.ts
git commit -m "refactor: isolate desktop providers"
```

### Task 2: Composite event identity and version 2 ledger

**Files:**
- Modify: `src/types.ts`
- Modify: `src/event.ts`
- Modify: `src/store.ts`
- Create: `scripts/migrate-ledger-v2.mjs`
- Modify: `test/store.test.ts`
- Create: `test/migrate-ledger.test.ts`

- [ ] **Step 1: Write failing identity, isolation and migration tests**

Create the identity explicitly:

```ts
const codex = { larkAppId: CODEX_APP_ID, provider: 'codex', threadId: THREAD_ID } as const;
const traex = { larkAppId: TRAEX_APP_ID, provider: 'traex', threadId: THREAD_ID } as const;
```

Assert that:

- identical thread/turn/status values generate different event IDs for Codex and TraeX;
- `store.thread(codex)` cannot return `store.thread(traex)`;
- `routeByRoot(TRAEX_APP_ID, codexRoot)` is undefined;
- migration preserves the current Codex root IDs, latest event and `adoptedAt`;
- invalid v1 input leaves the source file byte-for-byte unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm vitest run test/store.test.ts test/migrate-ledger.test.ts
```

Expected: fail because the store still accepts only thread IDs and ledger version 1.

- [ ] **Step 3: Implement ledger version 2**

Use one canonical route key and store the identity in every route:

```ts
export interface DesktopIdentity {
  larkAppId: string;
  provider: ProviderId;
  threadId: string;
}

interface ThreadRoute extends DesktopIdentity {
  rootEventId?: string;
  rootMessageId?: string;
  latestEventId: string;
  updatedAt: number;
  adoptedAt?: number;
}
```

Every store API must accept `DesktopIdentity`; `routeByRoot` and `resolveTakeover` must also require the authenticated Lark App ID. Runtime store parsing accepts version 2 only.

- [ ] **Step 4: Implement the one-time migration command**

The command accepts `--ledger` and `--codex-app-id`, validates all v1 references, builds the complete v2 value in memory, writes a `0600` temporary file, fsyncs it and renames it over the source. It refuses version 2 and malformed input rather than guessing.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all store and migration tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/event.ts src/store.ts scripts/migrate-ledger-v2.mjs test/store.test.ts test/migrate-ledger.test.ts
git commit -m "feat: isolate desktop handoff routes"
```

### Task 3: Provider-aware CardKit and IPC delivery

**Files:**
- Modify: `src/card.ts`
- Modify: `src/desktop-ipc.ts`
- Modify: `test/card.test.ts`
- Modify: `test/desktop-ipc.test.ts`

- [ ] **Step 1: Write failing CardKit and socket-isolation tests**

Assert that TraeX cards say `TraeX Desktop`, Codex snapshots remain unchanged except for provider plumbing, and each IPC request connects only to the supplied provider socket. Add a server response test that maps an explicit busy rejection to `desktop_thread_busy`, while unknown delivery after `startTurn` remains `desktop_turn_delivery_unknown`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm vitest run test/card.test.ts test/desktop-ipc.test.ts
```

Expected: fail because cards are Codex-specific and busy is not classified.

- [ ] **Step 3: Implement provider-aware presentation and error mapping**

Pass `ProviderId` to card builders, derive the fixed product label from `provider.ts`, and add `busy` to the message result states. Keep the existing frame parser, owner discovery, follower subscription and completion extraction unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all card and IPC tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/card.ts src/desktop-ipc.ts test/card.test.ts test/desktop-ipc.test.ts
git commit -m "feat: support TraeX desktop transport"
```

### Task 4: Dual-Bot Lark orchestration

**Files:**
- Modify: `src/lark/index.ts`
- Modify: `src/types.ts`
- Modify: `test/lark.test.ts`

- [ ] **Step 1: Write failing end-to-end plugin tests**

Build two plugin hosts against one config and assert:

- Codex local events use the Codex identity and socket;
- TraeX local events use the TraeX identity and socket;
- a TraeX card action received by Codex is rejected;
- a TraeX topic message cannot resolve a Codex root;
- identical thread IDs remain isolated;
- follower completion returns through the same Bot and same root CardKit topic;
- offline, busy and delivery-unknown states do not fall through to BotMux.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm vitest run test/lark.test.ts
```

Expected: fail because the handler still uses one global target Bot and the default Codex socket.

- [ ] **Step 3: Implement minimal orchestration changes**

At the start of every handler, resolve `BotConfig` from authenticated `context.larkAppId`. Build `DesktopIdentity`, pass `provider.socketPath()` to `probeDesktopThread` and `sendDesktopTurn`, and pass `provider.id` into events and CardKit. Unknown Bot configs return ignored/handled fail-closed results as appropriate.

Codex open-app continues to call `host.openCodexApp(threadId)`. TraeX open-app uses the fixed `/usr/bin/open -a Traex` invocation with no user-controlled argument.

- [ ] **Step 4: Run focused and full plugin tests**

```bash
pnpm vitest run test/lark.test.ts
pnpm check
```

Expected: focused tests pass, then all plugin tests and TypeScript build pass.

- [ ] **Step 5: Commit**

```bash
git add src/lark/index.ts src/types.ts test/lark.test.ts
git commit -m "feat: route Codex and TraeX handoffs"
```

### Task 5: Documentation, deployment and real regression

**Files:**
- Modify: `README.md`
- Runtime state after automated checks only:
  - `~/.botmux/plugins/desktop-handoff/config.json`
  - `~/.botmux/plugins/desktop-handoff/desktop-handoff-ledger.json`
  - `~/.botmux/bots.json`
  - `~/.trae/cli/hooks.json`（canonical）
  - `~/.trae/hooks.json`（仅清理旧 Handoff 条目）

- [ ] **Step 1: Update README and verify the package**

Document the `bots` map, both Hook commands, fixed sockets, one-time App restart requirement, text-only boundary and no-queue semantics. Run:

```bash
pnpm check
git diff --check
```

Expected: all tests/build pass and no whitespace errors.

- [ ] **Step 2: Commit documentation**

```bash
git add README.md
git commit -m "docs: configure dual desktop handoff"
```

- [ ] **Step 3: Stage and validate runtime migration**

Build first. Generate complete temporary v2 ledger, dual-Bot config, Bot enablement and TraeX Hook files. Parse every staged JSON file before stopping BotMux. Do not expose or rewrite Feishu secrets.

- [ ] **Step 4: Stop, replace and restart BotMux**

Stop BotMux only after all staged files validate. Preserve exact old files until startup and Codex regression pass. Replace the staged files, restart BotMux and verify both daemons plus Dashboard listeners are online.

- [ ] **Step 5: Run Codex gate first**

In the existing adopted Codex topic send `只回复 CODEX-PROVIDER-REGRESSION-OK`. Verify it appears in the same Codex Desktop thread and the reply returns to the same CardKit topic. From Codex Desktop send one new turn and verify it also returns to that topic.

If either direction fails, stop and restore the old runtime files before enabling TraeX.

- [ ] **Step 6: Enable and verify TraeX**

Restart TraeX App once so its current sessions load the new Hook. Complete a TraeX Desktop turn, verify「马仔二号」creates a CardKit root in「马仔工作台」, click takeover, then send `只回复 TRAEX-HANDOFF-E2E-OK`. Verify exact same TraeX Desktop thread and same CardKit topic.

- [ ] **Step 7: Final review**

Run `pnpm check`, `git diff --check`, inspect runtime logs for new plugin errors, verify the plugin repo is clean, and review the final diff against the design. Do not claim completion until both live loops pass.

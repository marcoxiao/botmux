# Desktop Handoff Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Codex Desktop 完成通知与显式飞书接管实现为独立插件，并让接管后的双向消息完全复用 BotMux 上游 Shared Adopt。

**Architecture:** BotMux Core 只新增通用 `lark` 插件贡献、可信本地事件分发和一个受限的 Shared Adopt Host 能力。独立 `botmux-plugin-desktop-handoff` 处理 Codex Hook、事件账本、CardKit 通知与按钮；接管成功后退出普通消息链路，由原生 Session/Worker 接管。

**Tech Stack:** TypeScript、Node.js ESM、Vitest、BotMux 插件约定、飞书 CardKit v2、Codex App Server Shared Adopt。

---

## 文件边界

BotMux Core：

- `src/core/plugins/types.ts`：登记 `lark` 静态贡献。
- `src/core/plugins/convention-scanner.ts`：只扫描固定入口 `lark/index.js`。
- `src/core/plugins/lark-protocol.ts`：定义稳定的插件协议和 Host 能力。
- `src/core/plugins/lark-runtime.ts`：加载、校验、去重 action ID 并分发事件。
- `src/core/plugins/runtime.ts`：复用现有插件基础 API，不承载飞书业务。
- `src/core/plugins/materializer.ts`：在启用快照中展示 `lark` 能力。
- `src/im/lark/card-handler.ts`：在内建动作前委托唯一的插件 action。
- `src/daemon.ts`：组装当前 Bot 的 Lark Host，并把现有 `/api/plugin-events` 泛化。
- `src/cli.ts`：复用现有 `plugin emit`；让插件 CLI 命令拿到受限的本地事件发送能力。
- `test/lark-plugin-runtime.test.ts`：协议、冲突、启用和 fail-closed 测试。
- `test/plugin-local-event-ingress.test.ts`：Host HMAC、目标 Bot 和启用范围测试。
- `test/plugin-card-action-dispatch.test.ts`：动作路由与未处理回落测试。

独立插件：

- `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/package.json`：独立插件包。
- `src/lark/index.ts`：本地事件与 CardKit action 入口。
- `src/cli/index.ts`：Codex Hook 兼容命令，只采集并调用 Host emit。
- `src/event.ts`：严格完成事件 schema、幂等 ID 和 Hook 转换。
- `src/codex-context.ts`：有界解析 transcript，只接受 Codex Desktop。
- `src/store.ts`：有界原子事件/话题账本。
- `src/card.ts`：统一 CardKit v2 通知与结果卡。
- `test/*.test.ts`：插件纯逻辑和 Host 合同测试。

清理：

- 删除 fork 专用 `src/features/codex-notifier/desktop-ipc-client.ts` 和 `desktop-ipc-protocol.ts`。
- 从 `src/types.ts`、Worker、Session、Daemon 和测试中删除 `codexAppTransport: 'desktop-ipc'` 分支。
- 保留上游内建 notifier 文件及其不属于 fork 的能力。

---

### Task 1: 增加通用 Lark 插件贡献

**Files:**
- Modify: `src/core/plugins/types.ts`
- Modify: `src/core/plugins/convention-scanner.ts`
- Modify: `src/core/plugins/materializer.ts`
- Create: `src/core/plugins/lark-protocol.ts`
- Create: `src/core/plugins/lark-runtime.ts`
- Test: `test/lark-plugin-runtime.test.ts`
- Test: `test/plugin-manifest-store.test.ts`

- [ ] **Step 1: 写 scanner 与 runtime 的失败测试**

```ts
expect(scanPluginContributions(root, manifest)?.lark).toEqual({ entry: 'lark/index.js' });
await expect(loadLarkPlugins(['bad-schema'])).rejects.toThrow('invalid_lark_plugin_schema');
await expect(loadLarkPlugins(['a', 'b'])).rejects.toThrow('duplicate_lark_plugin_action');
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run test/lark-plugin-runtime.test.ts test/plugin-manifest-store.test.ts --maxWorkers=1`

Expected: FAIL，因为 `lark` contribution 和 loader 尚不存在。

- [ ] **Step 3: 实现最小协议与 loader**

```ts
export interface LarkPluginV1 {
  schemaVersion: 1;
  actions: string[];
  handleLocalEvent?(event: unknown, context: LarkLocalEventContext, host: LarkPluginHost): Promise<unknown>;
  handleCardAction?(data: LarkCardAction, context: LarkCardActionContext, host: LarkPluginHost): Promise<unknown>;
}
```

固定扫描 `lark/index.js`；loader 校验 schema、action 格式、重复 ID 和 handler 类型。没有 `lark` 贡献的插件不加载。

- [ ] **Step 4: 运行测试并提交**

Run: `pnpm exec vitest run test/lark-plugin-runtime.test.ts test/plugin-manifest-store.test.ts --maxWorkers=1`

Expected: PASS。

Commit: `feat(plugins): add generic lark contribution`

### Task 2: 泛化可信本地插件事件入口

**Files:**
- Modify: `src/core/plugins/runtime.ts`
- Modify: `src/cli.ts`
- Modify: `src/daemon.ts`
- Create: `test/plugin-local-event-ingress.test.ts`
- Modify: `test/plugin-manifest-store.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
await expect(dispatchLocalEvent('desktop-handoff', event, host)).resolves.toEqual({ status: 'accepted' });
expect(untrustedResponse.statusCode).toBe(403);
expect(disabledPluginResponse.body.error).toBe('plugin_not_enabled');
expect(wrongBotResponse.body.error).toBe('target_bot_mismatch');
```

同时固定插件 CLI handler 可以拿到调用方注入的 `emitLocalEvent`，但不能覆盖 `config`、`resolve` 等基础安全 API。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run test/plugin-local-event-ingress.test.ts test/plugin-manifest-store.test.ts --maxWorkers=1`

Expected: FAIL，因为 `/api/plugin-events` 仍写死 `codex-watch`。

- [ ] **Step 3: 实现通用分发**

```ts
type PluginLocalEventEnvelope = {
  pluginId: string;
  targetBotAppId: string;
  event: unknown;
};
```

复用现有 Host HMAC、64 KiB 上限和 `plugin emit`。daemon 根据当前 Bot 的 effective plugin IDs 加载贡献，只调用 envelope 指定且已启用的插件。未知/禁用插件 fail closed，不回退内建 notifier。

- [ ] **Step 4: 运行测试并提交**

Run: `pnpm exec vitest run test/plugin-local-event-ingress.test.ts test/plugin-manifest-store.test.ts --maxWorkers=1`

Expected: PASS。

Commit: `feat(plugins): dispatch trusted local lark events`

### Task 3: 接入 CardKit action 与原生 Shared Adopt Host

**Files:**
- Modify: `src/im/lark/card-handler.ts`
- Modify: `src/daemon.ts`
- Modify: `src/features/codex-notifier/adoption.ts`
- Modify: `src/core/command-handler.ts`
- Create: `test/plugin-card-action-dispatch.test.ts`
- Modify: `test/codex-notifier-topic-adoption.test.ts`
- Modify: `test/command-handler.test.ts`

- [ ] **Step 1: 写 action 唯一路由失败测试**

```ts
const result = await handleCardAction(pluginData, {
  ...deps,
  pluginCardAction: async () => ({ card: adoptedCard }),
}, APP_ID);
expect(result).toEqual({ card: adoptedCard });
```

并固定未知 action 继续走内建 handler，插件异常返回明确错误卡而不是创建普通 Session。

- [ ] **Step 2: 写 Native-only 接管失败测试**

```ts
await expect(host.sharedAdopt(requestWithoutEndpoint)).rejects.toThrow('existing_app_server_required');
expect(session.existingAppServerEndpoint).toBe('ws://127.0.0.1:4500');
expect(session.codexAppTransport).toBeUndefined();
```

- [ ] **Step 3: 运行失败测试**

Run: `pnpm exec vitest run test/plugin-card-action-dispatch.test.ts test/codex-notifier-topic-adoption.test.ts test/command-handler.test.ts --maxWorkers=1`

Expected: FAIL，因为 CardHandler 尚无插件委托，接管仍可能走私有 IPC。

- [ ] **Step 4: 实现最小 Host**

```ts
export interface LarkPluginHost {
  sendCard(input: SendCardInput): Promise<{ messageId: string }>;
  replyCard(input: ReplyCardInput): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  getOwnerOpenId(): string | undefined;
  findSharedAdopt(threadId: string): Promise<SharedAdoptRef | undefined>;
  sharedAdopt(input: SharedAdoptRequest): Promise<SharedAdoptRef>;
  openCodexApp(threadId: string): Promise<{ ok: boolean; error?: string }>;
}
```

`sharedAdopt` 只接受本地 existing App Server endpoint；卡片 payload 只传 `event_id`，thread/cwd 从插件账本恢复。成功条件是原生 Session/Worker 已建立；失败不排队、不建替代会话。

- [ ] **Step 5: 运行测试并提交**

Run: `pnpm exec vitest run test/plugin-card-action-dispatch.test.ts test/codex-notifier-topic-adoption.test.ts test/command-handler.test.ts --maxWorkers=1`

Expected: PASS。

Commit: `feat(lark): expose native shared adopt to plugins`

### Task 4: 创建独立 Desktop Handoff 插件

**Files:**
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/package.json`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/tsconfig.json`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/src/event.ts`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/src/codex-context.ts`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/src/store.ts`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/src/card.ts`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/src/lark/index.ts`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/src/cli/index.ts`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/src/cli/commands.json`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/scripts/copy-static.mjs`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/test/event.test.ts`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/test/codex-context.test.ts`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/test/store.test.ts`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/test/lark.test.ts`
- Create: `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/test/cli.test.ts`

- [ ] **Step 1: 写插件纯逻辑失败测试**

覆盖：Desktop/CLI 识别、managed/subagent/internal 过滤、事件 ID、重复 completion、有界账本、同 thread 话题复用、CardKit 按钮只携带 event ID、非管理员拒绝、重复点击幂等、离线错误。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm test`

Expected: FAIL，因为插件实现不存在。

- [ ] **Step 3: 实现最小插件**

```ts
export default {
  schemaVersion: 1,
  actions: ['desktop_handoff.takeover', 'desktop_handoff.open_app'],
  handleLocalEvent,
  handleCardAction,
};
```

`UserPromptSubmit` 只记录确认过的用户问题；`Stop` 只接受 transcript 标记为 `source=vscode, originator=Codex Desktop` 的持久 thread。首次完成发送根 CardKit，后续同 thread 回复到该根话题；活跃 Shared Adopt 不再发送重复接管卡。

构建脚本先运行 `tsc`，再由 `scripts/copy-static.mjs` 把 `src/cli/commands.json` 复制到 `dist/cli/commands.json`；不引入打包器。

- [ ] **Step 4: 构建并运行插件测试**

Run: `pnpm test && pnpm build`

Expected: PASS，`dist/lark/index.js`、`dist/cli/index.js` 和 `dist/cli/commands.json` 存在。

- [ ] **Step 5: 初始化独立 Git 仓库并提交**

Commit: `feat: add desktop handoff control-plane plugin`

### Task 5: 切换运行链路并清理私有 IPC

**Files:**
- Modify: `src/types.ts`
- Modify: `src/core/command-handler.ts`
- Modify: `src/core/session-manager.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/daemon.ts`
- Delete: `src/features/codex-notifier/desktop-ipc-client.ts`
- Delete: `src/features/codex-notifier/desktop-ipc-protocol.ts`
- Modify/Delete: 仅覆盖这些分支的对应测试

- [ ] **Step 1: 安装并启用插件**

Run: `pnpm build && botmux plugin install /Users/bytedance/AiProjects/botmux-plugin-desktop-handoff --link && botmux plugin enable desktop-handoff --bot cli_aa9f099867385ccc`

Expected: Dashboard/CLI 显示插件已安装且只在 Codex Bot 启用。

- [ ] **Step 2: 配置目标 Bot/工作台并替换 Hook**

清空内建 `codexNotifier` 启用配置，插件配置固定目标 `larkAppId`、工作台 `chatId`；沿用 `botmux codex-watch-hook` 命令，由已启用插件 CLI handler 接管。Traex Bot 不启用本插件。

- [ ] **Step 3: 写清理后的失败测试**

```ts
expect('codexAppTransport' in session).toBe(false);
expect(sourceTree).not.toContain('desktop-ipc-client');
expect(nativeSession.existingAppServerEndpoint).toBe(ENDPOINT);
```

- [ ] **Step 4: 删除私有 follower 分支并回归**

Run: `rg -n "codexAppTransport|desktop-ipc-client|probeCodexDesktopThread" src test`

Expected: 0 个业务命中；BotMux Desktop 自身 Electron IPC 文件不在清理范围。

Run: `pnpm exec vitest run test/command-handler.test.ts test/session-adopt.test.ts test/session-lifecycle-start.test.ts test/turn-progress-worker-routing.test.ts test/daemon-ordinary-ingress-failure-notice.test.ts --maxWorkers=1`

Expected: PASS。

Commit: `refactor(codex): remove private desktop follower path`

### Task 6: 双端回归、架构审查与交付

**Files:**
- Modify: `docs/superpowers/specs/2026-08-23-desktop-handoff-plugin-design.md`（仅在实现与批准设计有差异时）
- Create: `docs/operations/2026-08-23-desktop-handoff-plugin.md`

- [ ] **Step 1: 自动化验证**

Run: `pnpm build`

Run: `pnpm exec vitest run test/lark-plugin-runtime.test.ts test/plugin-local-event-ingress.test.ts test/plugin-card-action-dispatch.test.ts test/existing-app-server.test.ts test/command-handler.test.ts test/lark-cardkit-client.test.ts test/turn-progress-plugin-runtime.test.ts --maxWorkers=1`

Run in plugin repo: `pnpm test && pnpm build`

Expected: 全部 PASS、0 TypeScript 错误。

- [ ] **Step 2: 真实链路验收**

1. Codex App 新建任务并完成。
2. 工作台收到唯一根 CardKit。
3. 点击“飞书接管”。
4. 飞书发送唯一标记，确认进入同一 Desktop thread。
5. Desktop 回复唯一标记，确认回到同一飞书话题。
6. 验证审批、停止、Web Terminal、关闭 Session、daemon 重启。
7. 关闭 Codex App 后发送，确认明确离线且不排队。

- [ ] **Step 3: 深度 Review**

逐项检查：插件禁用是否隔离、Core 是否只有通用 SPI、是否存在第二会话真相源、action 是否 fail closed、事件/状态是否有界、是否泄漏 endpoint/凭证、是否仍有 fork 专用高冲突分支。

- [ ] **Step 4: 与上游做冲突预算验证**

Run: `git fetch upstream master && git merge-tree $(git merge-base HEAD upstream/master) HEAD upstream/master`

Expected: Desktop Handoff 业务文件不进入 Worker/Session 冲突；Core 冲突只可能位于通用插件 SPI 接线。

- [ ] **Step 5: 提交运维文档与最终结果**

Commit: `docs: document desktop handoff operations`

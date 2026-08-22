# BotMux Runtime Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留一套 BotMux、两个独立飞书机器人的前提下，修复 Desktop IPC 重连、Hook 假健康和原生标题误覆盖。

**Architecture:** 候选发现使用本地 visualization/rollout 交集做负向过滤；Hook 健康复用现有 Codex app-server stdio probe 调用原生 `hooks/list`；外部 thread 接管在同一会话事务中清除 BotMux 标题状态。所有改动保持现有多 Bot 配置与消息链路不变。

**Tech Stack:** TypeScript 5.x、Node.js ESM、Vitest、Codex App Server JSON-RPC、BotMux PM2 runtime。

---

### Task 1: 排除普通 Codex 任务并停止 IPC 重连风暴

**Files:**
- Modify: `src/features/codex-notifier/side-conversation-monitor.ts`
- Test: `test/codex-notifier-side-conversation.test.ts`

- [ ] **Step 1: 写失败测试**

增加文件系统反例：同一个 UUID 同时存在 visualization 目录和 `sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl` 时不返回候选；仅有 visualization 且超过稳定窗口时仍返回。

- [ ] **Step 2: 运行 RED**

Run: `pnpm vitest run --project unit test/codex-notifier-side-conversation.test.ts`

Expected: 普通 rollout 仍被返回，新增断言失败。

- [ ] **Step 3: 最小实现**

在最近两天的 sessions 日期目录构造普通 rollout ID 集合；visualization 候选先经过稳定窗口，再排除集合成员。扫描循环对已经 follow、但新一轮不再是候选的线程执行 `unfollow` 并忽略。

- [ ] **Step 4: 运行 GREEN**

Run: `pnpm vitest run --project unit test/codex-notifier-side-conversation.test.ts`

Expected: 全部通过，且既有 Side Chat 快速完成测试保持通过。

- [ ] **Step 5: 提交**

```bash
git add src/features/codex-notifier/side-conversation-monitor.ts test/codex-notifier-side-conversation.test.ts
git commit -m "fix(notifier): 排除普通 Codex 任务监听"
```

### Task 2: 用 App Server 原生状态替代 Hook 假健康

**Files:**
- Modify: `src/services/codex-app-threads.ts`
- Create: `src/features/codex-notifier/hook-health.ts`
- Modify: `src/features/codex-notifier/index.ts`
- Modify: `src/cli.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/dashboard/web/settings-page.tsx`
- Test: `test/codex-notifier-hook-health.test.ts`
- Test: `test/codex-notifier-settings-ui.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖两个 Hook 均 trusted、任一 untrusted、disabled、missing 和 app-server unavailable；验证“已安装”与“受信任”是两个独立字段。

- [ ] **Step 2: 运行 RED**

Run: `pnpm vitest run --project unit test/codex-notifier-hook-health.test.ts test/codex-notifier-settings-ui.test.ts`

Expected: 健康归一化函数和设置字段不存在。

- [ ] **Step 3: 最小实现**

给现有 `CodexAppServerProbe` 增加只读 `hooks/list` 包装；新模块仅过滤 BotMux 的 `userPromptSubmit/stop` 两项并归一化状态。CLI 实时 await 探测；Dashboard 启动时探测并用 unref 定时器刷新缓存，不写 trust 配置。

- [ ] **Step 4: 运行 GREEN**

Run: `pnpm vitest run --project unit test/codex-notifier-hook-health.test.ts test/codex-notifier-hook-installer.test.ts test/codex-notifier-settings-ui.test.ts`

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/services/codex-app-threads.ts src/features/codex-notifier/hook-health.ts src/features/codex-notifier/index.ts src/cli.ts src/dashboard.ts src/dashboard/web/settings-page.tsx test/codex-notifier-hook-health.test.ts test/codex-notifier-settings-ui.test.ts
git commit -m "fix(notifier): 展示 Codex Hook 真实信任状态"
```

### Task 3: 保护外部 Codex App thread 标题

**Files:**
- Modify: `src/core/command-handler.ts`
- Test: `test/command-handler.test.ts`

- [ ] **Step 1: 写失败测试**

构造已有 `nativeSessionTitle` 的普通 BotMux 会话，调用 `startCodexAppThreadSession` 接管外部 thread，断言三个 BotMux 标题字段被清除，并保留目标 thread 自身名称。

- [ ] **Step 2: 运行 RED**

Run: `pnpm vitest run --project unit test/command-handler.test.ts`

Expected: `nativeSessionTitle` 仍存在，新增断言失败。

- [ ] **Step 3: 最小实现**

在切换事务写入目标 `cliSessionId` 前删除 `nativeSessionTitle`、`nativeSessionTitleUserDefined` 和 `nativeSessionTitleAwaitingContent`。不修改 runner，也不增加新持久化字段。

- [ ] **Step 4: 运行 GREEN**

Run: `pnpm vitest run --project unit test/command-handler.test.ts test/session-lifecycle-start.test.ts test/codex-app-runner.integration.test.ts`

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/command-handler.ts test/command-handler.test.ts
git commit -m "fix(codex-app): 接管外部任务时保留原生标题"
```

### Task 4: 综合验证与运行验收

**Files:**
- Modify only if verification exposes a real defect: files owned by Tasks 1-3

- [ ] **Step 1: 聚焦回归**

Run: `pnpm vitest run --project unit test/codex-notifier-side-conversation.test.ts test/codex-notifier-hook-health.test.ts test/codex-notifier-hook-installer.test.ts test/codex-notifier-hook.test.ts test/codex-notifier-settings-ui.test.ts test/command-handler.test.ts test/session-lifecycle-start.test.ts test/codex-app-runner.integration.test.ts`

- [ ] **Step 2: 全量单元测试与构建**

Run: `pnpm test && pnpm build && git diff --check`

- [ ] **Step 3: 深度 Review**

确认没有新增凭证存储、第二个 monitor、第二套 daemon、跨 Bot 会话共享或 provider-specific 文案进入共用核心；确认失败只降级通知健康，不影响基础 IM。

- [ ] **Step 4: 部署并真机验收**

自动验证通过后执行 `pnpm switch:here && pnpm daemon:restart`。确认两个 daemon 在线；Codex App 新任务进入 Codex 机器人；普通大型任务不再触发 IPC 帧错误；接管已有 thread 不改标题。TRAE 机器人只验证基础消息，语义插件启用放在独立验收步骤。

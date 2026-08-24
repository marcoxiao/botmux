# Semantic Progress Monorepo Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Semantic Progress 连同原 Git 历史迁入 BotMux workspace，保持插件行为不变，补齐构建/CI 与 Dashboard 能力展示，并安全切换唯一运行时来源。

**Architecture:** `plugins/semantic-progress` 是与 `plugins/desktop-handoff` 同级的私有 workspace package，继续只通过 `turnProgress` contribution 接入 Core。迁移保持插件 ID、入口、reducer、CardKit renderer 和测试源码不变；Core 只增加构建编排与 Dashboard 对既有 contribution 的事实展示。

**Tech Stack:** TypeScript、pnpm workspace、Vitest、React、BotMux plugin registry、Git unrelated-history merge。

---

### Task 1: 建立 workspace 契约并导入原仓历史

**Files:**
- Create: `test/semantic-progress-workspace.test.ts`
- Create: `plugins/semantic-progress/src/**`
- Create: `plugins/semantic-progress/test/**`
- Create: `plugins/semantic-progress/scripts/clean-dist.mjs`
- Create: `plugins/semantic-progress/vitest.config.ts`
- Modify: `plugins/semantic-progress/package.json`
- Modify: `plugins/semantic-progress/README.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 写失败的 workspace 契约测试**

测试必须使用仓库相对路径读取文件，并断言：package 存在且 `private: true`；插件 ID/入口不变；build 先清理 `dist`；独立 Vitest 只匹配本包测试；插件目录没有独立 lock；README 不含旧绝对路径；根脚本含 `semantic-progress:{build,test,check}`；根 build 构建两个插件；CI 显式运行两个插件测试。

- [ ] **Step 2: 验证 RED**

Run: `pnpm vitest run --project unit test/semantic-progress-workspace.test.ts`

Expected: FAIL，因为 `plugins/semantic-progress/package.json` 尚不存在。

- [ ] **Step 3: 以原提交为第二父导入文件树**

保存原仓 SHA `6d591f41c7155b49efebe5a9b4020538cbe1274c`，执行 unrelated-history `ours` merge 进入未提交状态，再把该提交的 `README.md`、`package.json`、`src/`、`test/`、`tsconfig.json` 机械放到 `plugins/semantic-progress/`。不迁入 `.gitignore`、`pnpm-lock.yaml`、`node_modules` 或 `dist`。

- [ ] **Step 4: 写最小 workspace 集成**

`plugins/semantic-progress/package.json` 保持包名、版本、插件 ID 和入口，增加 `private: true`，并把 build 改为 `node scripts/clean-dist.mjs && tsc -p tsconfig.json`。`clean-dist.mjs` 只递归删除本包 `dist`；`vitest.config.ts` 只 include `test/**/*.test.ts`。README 的开发和 link 安装命令改为 monorepo 路径。

根 `package.json` 增加三个 semantic 脚本，并让根 build 在 Core 编译前构建 Semantic Progress 与 Desktop Handoff。CI 在根 build 后显式运行两个插件 test。运行 `pnpm install --lockfile-only` 生成唯一 workspace lock importer。

- [ ] **Step 5: 验证 GREEN 与源码等价**

Run:

```bash
pnpm vitest run --project unit test/semantic-progress-workspace.test.ts
pnpm semantic-progress:check
diff -ru --exclude=README.md --exclude=package.json --exclude=pnpm-lock.yaml --exclude=.gitignore --exclude=dist --exclude=node_modules /Users/bytedance/AiProjects/botmux-plugin-semantic-progress/src plugins/semantic-progress/src
diff -ru /Users/bytedance/AiProjects/botmux-plugin-semantic-progress/test plugins/semantic-progress/test
```

Expected: 契约与 `23/23` 插件测试 PASS，两个 diff 无输出。

- [ ] **Step 6: 提交两父整合提交并验证历史**

提交当前 merge，随后验证：`git rev-parse HEAD^2` 精确为原 SHA；`git merge-base --is-ancestor 6d591f41 HEAD` 成功；原 3 个提交可读；`git fsck --full` 成功。

### Task 2: 修正 Dashboard 插件能力摘要

**Files:**
- Modify: `src/dashboard/web/plugin-page.tsx`
- Create: `test/dashboard-plugin-capability-summary.test.ts`

- [ ] **Step 1: 测试先证明摘要组件可独立验证**

动态导入 `plugin-page.tsx`，断言 `PluginCapabilitySummary` 是函数；不存在时返回，保证当前代码以断言失败而非运行错误结束。

- [ ] **Step 2: 验证 RED，最小导出组件，再验证 GREEN**

Run: `pnpm vitest run --project unit test/dashboard-plugin-capability-summary.test.ts`

Expected: 首次 FAIL 为组件未导出；只增加命名导出后 PASS。

- [ ] **Step 3: 写 contribution 呈现失败测试**

用 `react-test-renderer` 分别渲染 `{ turnProgress: { entry } }`、`{ lark: { entry } }` 与空 contributions，断言前两者分别显示 `进度卡`、`飞书协同` 且不显示“未声明扩展能力”，空 contributions 保留原提示。

- [ ] **Step 4: 验证 RED**

Run: `pnpm vitest run --project unit test/dashboard-plugin-capability-summary.test.ts`

Expected: contribution 两例 FAIL，因为当前类型和摘要数组尚未识别 `turnProgress`/`lark`。

- [ ] **Step 5: 写最小实现并验证 GREEN**

只在 `ManagedPlugin.contributions` 增加两个现有 descriptor 的窄类型，并在 capability 数组中各增加一个布尔计数项；不增加新协议、新文案源或插件特判。

Run: `pnpm vitest run --project unit test/dashboard-plugin-capability-summary.test.ts test/dashboard-plugin-pin-ui.test.ts`

Expected: PASS。

### Task 3: 自动化回归、架构卫生与代码审查

**Files:**
- Verify only; only fix defects exposed by tests/review within Tasks 1–2 scope.

- [ ] **Step 1: 运行两个插件检查、Core Turn Progress 专项、Dashboard 专项、根全量测试与 build**

```bash
pnpm semantic-progress:check
pnpm desktop-handoff:check
pnpm vitest run --project unit test/turn-progress-protocol.test.ts test/turn-progress-plugin-runtime.test.ts test/lark-cardkit-client.test.ts test/turn-progress-host.test.ts test/turn-progress-eligibility.test.ts test/turn-progress-worker-routing.test.ts test/turn-progress-final-delivery.test.ts test/codex-app-runner.integration.test.ts test/worker-codex-app-turn-routing.integration.test.ts test/traex-transcript.test.ts test/worker-traex-progress-routing.test.ts
pnpm test
pnpm build
git diff --check
```

- [ ] **Step 2: 核对产物、依赖与路径卫生**

比较迁移前后 `dist` 文件集合与 hash；确认插件源码不 import `botmux/src`；扫描当前代码、脚本和 README 不再引用旧仓路径；确认 lock 只有预期 workspace importer；确认 Semantic Progress 没有 service contribution 或独立进程。

- [ ] **Step 3: 依次通过规格一致性 Review 和代码质量 Review**

Critical/Important 必须修复并复审通过。审查重点是薄插件边界、源代码等价、TDD 证据、构建卫生、Dashboard 无插件特判和无范围外重构。

### Task 4: 维护窗口内切换、验收与旧仓清理

**Files:**
- Runtime link: `~/.botmux/plugins/semantic-progress/dist`
- Runtime registry/config: existing BotMux files only through supported CLI
- Trash: `/Users/bytedance/AiProjects/botmux-plugin-semantic-progress`

- [ ] **Step 1: 阻塞请求用户确认维护窗口**

用户确认 Codex/TraeX 无运行或等待输入任务、无 Handoff follower，并停止发送正常业务消息后才继续。

- [ ] **Step 2: 停止 daemon 并 fail closed**

执行 `botmux stop`，确认所有 Bot daemon 完全退出；异常则恢复服务并终止切换。

- [ ] **Step 3: 原子切换 link 并启动**

执行 `botmux plugin install ./plugins/semantic-progress --link`，核对 registry、`readlink`、`realpath`、两个 Bot bindings 和 manifest，然后启动 BotMux。

- [ ] **Step 4: 完成受控运行态验收**

两个 Bot 各完成真实普通路由；覆盖 MCP、TraeX 等待/恢复、停止、失败、长 final、重启恢复、特殊通道排除，以及 Codex/TraeX Desktop Handoff 通知和往返。每项完成后再发下一项。

- [ ] **Step 5: 将旧仓移入废纸篓并做旧路径缺失冷启动**

不清空废纸篓。再次冷启动后核对 registry/link/manifest 并做双 Bot smoke；失败时先停 daemon，再恢复旧仓与旧 link。全部通过后结束维护窗口。


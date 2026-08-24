# Desktop Handoff 同群路由与 Hook 恢复实施计划

> 直接在当前分支实施：BotMux `codex-office`、插件 `main`。保留 BotMux 已有的 `CLAUDE.md` 和 `.superpowers/` 用户改动。

**目标：** 删除群级独占路由，恢复 Codex/TraeX canonical Desktop Hook，并清理历史状态与重复部署，使同一飞书群同时支持普通 BotMux 新话题和 Handoff 根话题。

**设计：** Core 只持久化 `(larkAppId, rootMessageId/threadAlias)` 根声明；未命中根声明的消息继续普通路由。插件保持薄层，只处理 Hook、账本、CardKit 与固定 Desktop IPC。Hook 安装由插件仓库中的标准库脚本幂等维护。

**技术栈：** TypeScript、Node.js ESM、Vitest、pnpm、PM2/launchd、Codex/TraeX JSON Hook 配置。

---

## Task 1：用失败测试固定正确的 Core 路由语义

**文件：**

- 修改：`/Users/bytedance/AiProjects/botmux/test/lark-plugin-message-routing.test.ts`
- 修改：`/Users/bytedance/AiProjects/botmux/test/lark-plugin-message-claims.test.ts`

**步骤：**

1. 把“独占群内未解析消息被消费”的两个断言改为：未声明 root/thread 时返回 `false`，插件返回 `false` 后允许普通路由继续。
2. 保留并强化已声明 root/thread alias 在插件禁用、无权限时 fail-closed 的断言。
3. 删除群级 claim store 的行为断言，保留跨 `larkAppId` 隔离和持久化恢复断言。
4. 运行：

   ```bash
   pnpm exec vitest run test/lark-plugin-message-routing.test.ts test/lark-plugin-message-claims.test.ts
   ```

   预期：新语义测试先失败，证明测试能捕获当前吞消息行为。

## Task 2：删除 BotMux Core 群级独占抽象

**文件：**

- 修改：`/Users/bytedance/AiProjects/botmux/src/core/plugins/lark-protocol.ts`
- 修改：`/Users/bytedance/AiProjects/botmux/src/core/plugins/lark-message-claims.ts`
- 修改：`/Users/bytedance/AiProjects/botmux/src/im/lark/event-dispatcher.ts`
- 修改：`/Users/bytedance/AiProjects/botmux/src/daemon.ts`
- 修改：`/Users/bytedance/AiProjects/botmux/test/codex-notifier-topic-adoption.test.ts`

**步骤：**

1. 删除 `claimExclusiveChat` Host 能力、store API、类型、key 和持久字段。
2. `ClaimFile` 只保留版本与根声明；读取时只投影已验证的 `version/claims`，未知历史字段不进入下一次写回。
3. 删除 `dispatchPluginTopicMessage` 的 `hasClaimedChat` 参数和提前消费分支。
4. 删除 daemon 的群 claim 注入和调用参数；同步删掉测试 fixture。
5. 运行 Task 1 测试，预期全部通过。
6. 搜索残留：

   ```bash
   rg -n 'claimExclusiveChat|hasExclusiveChat|exclusiveChats|ExclusiveChatClaim|hasClaimedChat' src test
   ```

   预期：无结果。
7. 提交 Core 原子 commit。

## Task 3：用失败测试固定薄插件边界

**文件：**

- 修改：`/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/test/lark.test.ts`

**步骤：**

1. 从 Host fixture 删除 `claimExclusiveChat`。
2. 首次 Codex/TraeX 根卡测试只断言 `sendCard(..., replyClaim: 'exclusive')`，不允许群级能力。
3. 保留两 Provider 相同 thread ID 不串线、未知根返回 `handled=false`、已接管根写回固定 socket 的覆盖。
4. 运行：

   ```bash
   pnpm exec vitest run test/lark.test.ts
   ```

   预期：类型或运行测试先失败，定位插件仍调用旧 Host 能力。

## Task 4：删除插件群级声明代码

**文件：**

- 修改：`/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/src/lark/index.ts`
- 修改：`/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/src/types.ts`
- 修改：`/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/test/lark.test.ts`

**步骤：**

1. 删除创建根卡前的 `host.claimExclusiveChat(...)`。
2. 删除插件自带 Host 类型中的群级能力。
3. 运行 `pnpm exec vitest run test/lark.test.ts`，预期通过。
4. 搜索插件残留，预期源码和测试均无群级 claim。
5. 提交插件原子 commit。

## Task 5：TDD 实现 canonical Hook 安装器

**文件：**

- 新增：`/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/scripts/install-hooks.mjs`
- 新增：`/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/test/install-hooks.test.ts`
- 修改：`/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/package.json`
- 修改：`/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/README.md`
- 修改：`/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/docs/superpowers/specs/2026-08-23-traex-desktop-handoff-design.md`

**步骤：**

1. 先写临时 HOME fixture 测试，覆盖：首次安装、重复安装、保留其他 Hook、清理旧 TraeX 精确条目、损坏 JSON 拒绝、`0600` 权限。
2. 运行 `pnpm exec vitest run test/install-hooks.test.ts`，预期因脚本不存在而失败。
3. 用 Node 标准库实现单一 CLI：

   ```bash
   node scripts/install-hooks.mjs --codex-bot <id> --traex-bot <id>
   ```

4. canonical 目标固定为 `~/.codex/hooks.json` 与 `~/.trae/cli/hooks.json`；旧 `~/.trae/hooks.json` 只删除精确 Handoff entry。
5. 校验 JSON 结构后，在同目录创建临时文件、写入换行、chmod `0600`、原子 rename；无变化不改 mtime。
6. 更新 package files/script 和 README，只保留 canonical 指引及原生 Hook trust 要求。
7. 运行安装器测试和插件全量 `pnpm check`，预期通过。
8. 提交插件原子 commit。

## Task 6：跨仓自动回归与深层 Review

**文件：**

- Review 所有 Task 1–5 修改文件。

**步骤：**

1. BotMux 运行定向测试：

   ```bash
   pnpm exec vitest run \
     test/lark-plugin-message-routing.test.ts \
     test/lark-plugin-message-claims.test.ts \
     test/plugin-local-event-client.test.ts \
     test/codex-notifier-topic-adoption.test.ts
   ```

2. 执行 BotMux 类型检查/构建及与插件协议相关的回归集合。
3. 插件执行 `pnpm check`。
4. `git diff --check`、`rg` 死代码扫描、依赖和构建产物检查。
5. 按设计文档从飞书入口重新追踪至 IPC 完成回传，检查：身份边界、fail-closed、幂等、原子写入、权限、错误传播和日志脱敏。
6. 检查历史 worktree 的 commit 是否已在当前实现中等价落地；只移除 clean 且已被当前代码取代的 worktree，不删除 dirty/不明工作区。
7. 修复 Review 问题并重新运行完整验证。

## Task 7：备份、清理历史运行状态并部署

**运行文件：**

- `~/.botmux/lark-plugin-message-claims.json`
- `~/.codex/hooks.json`
- `~/.trae/hooks.json`
- `~/.trae/cli/hooks.json`
- `~/.botmux/plugins/desktop-handoff/dist`

**步骤：**

1. 创建带时间戳的发布备份目录，复制上述普通文件并记录 symlink target；校验备份可读。
2. 构建 BotMux 和插件，确认安装 symlink 只指向当前插件 `dist`。
3. 通过受校验的一次性部署操作从 claims JSON 删除 `exclusiveChats`，保留全部 `claims`，权限维持 `0600`。
4. 运行 canonical Hook 安装器，确认：
   - Codex canonical 文件各一条 `UserPromptSubmit/Stop` Handoff。
   - TraeX canonical 文件各一条 `UserPromptSubmit/Stop` Handoff。
   - 旧 TraeX 文件不再含 Handoff，其他 Hook 原样保留。
5. 停止唯一 BotMux 服务，核对不存在第二个 launchd/PM2 supervisor 或孤儿 daemon/dashboard；不误杀独立 Desktop App。
6. 启动唯一 BotMux 服务，确认一个 PM2 supervisor、两个 Bot daemon、一个 dashboard，PID/端口/代码路径一致。
7. 若部署前校验或启动失败，恢复备份和旧构建并重启旧版本。

## Task 8：真实端到端验收

**证据：** 飞书消息 ID、root/thread ID、Desktop session ID、插件账本条目、daemon 日志、进程拓扑。

**步骤：**

1. Codex Desktop 新一轮完成 -> 飞书生成/回复 Handoff 卡。
2. 回复 Codex Handoff 根卡 -> 同一 Codex Desktop 会话 -> 结果回原话题。
3. Codex Bot 普通新话题 -> 创建/继续普通 BotMux Session，不被插件吞掉。
4. TraeX Desktop 新一轮完成 -> 飞书生成/回复 Handoff 卡。
5. 回复 TraeX Handoff 根卡 -> 同一 TraeX Desktop 会话 -> 结果回原话题。
6. TraeX Bot 普通新话题 -> 创建/继续普通 BotMux Session，不被插件吞掉。
7. 重启 BotMux 后复测一个既有 Handoff 根和两个普通新话题。
8. 分别验证一个 Provider 离线不串到另一个 Provider。
9. 汇总每项证据；任一项未通过，不声明完成。

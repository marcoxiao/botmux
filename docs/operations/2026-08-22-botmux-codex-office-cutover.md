# BotMux Codex Office 第一阶段实施记录

## 版本基线

- 日期：2026-08-22
- 仓库：`marcoxiao/botmux`
- 分支：`codex-office`
- 起始 commit：`9684a1aa5971f1fd3655e790c5a38716480dfc3a`
- Node：`v22.22.0`
- pnpm：`9.5.0`
- Codex：由 `codex-cli 0.142.3` 升级到 `0.149.0`
- tmux：基线缺失；通过临时 TUNA API/bottle 环境安装 Homebrew `tmux 3.7c`，未修改全局 Homebrew 镜像配置；独立 socket 的 new-session/kill-server 功能探测通过。

## 旧通道基线

- LaunchAgent：`com.local.codex-feishu-native`
- 基线状态：running
- 飞书应用：`cli_aa9f099867385ccc`
- owner：1
- 群白名单：1
- workspace root：`/Users/bytedance/AiProjects`
- 基线期间旧通道保持在线，尚未启动 BotMux daemon。

## 自动验证

- `pnpm install --frozen-lockfile`：通过；lockfile 未变化。
- `pnpm build`：通过；domain audit、TypeScript、scripts typecheck、Dashboard bundle 与 dist audit 均成功。
- 完整串行测试（使用 macOS 规范化后的 `TMPDIR`）：1040 个测试文件通过、7 个跳过、10 个失败；17525 个测试通过、151 个跳过、29 个失败，耗时 1072.46 秒。
- 构建后 CLI 聚焦测试：4 个文件、76 个测试全部通过。
- `codex-app` 关键路由与恢复集成测试：8 个测试全部通过，覆盖真实 tmux runner 退出、重连、最终结果 replay/ACK 与第二轮继续执行。
- 完整测试的剩余失败已逐项隔离，不涉及本阶段选定的 `codex-app` 飞书链路：
  - macOS preview owner proof 仅实现 Linux `/proc`，因此 7 个 Agent Web Preview 测试按安全策略 fail-closed；该能力不是 BotMux Session Web Terminal，本阶段不启用。
  - Mojo/Riff 适配器的 macOS 隔离与临时目录清理测试失败；本阶段不使用这两个适配器。
  - 全量并行/长时运行中的 `codex-app` timeout 在独立串行复测中 8/8 通过，确认属于测试资源竞争。
  - 构建前 `dist/cli.js` 缺失造成的 CLI 测试失败，在构建后复测为 76/76 通过。
- `cli-runtime-update` 的 5 个初始失败来自 macOS `/var` 与 `/private/var` 路径别名；规范化 `TMPDIR` 后 43/43 通过，产品代码无需修改。
- 最小权限模式聚焦测试：`test/api-only-mode-wiring.test.ts` 45/45 通过；完整构建通过。
- BotMux daemon 与 Dashboard 已启动，均仅监听回环地址；`/healthz` 返回 200。
- `0.142.3` 对 `gpt-5.6-sol` 的请求被后端明确拒绝（要求升级 Codex），BotMux 旧 App Server 将其显示为流断开；升级到 `0.149.0` 后同模型最小请求成功返回 `OK`。

## 最小权限策略

- 已关闭 `application:application:self_manage`、`im:chat.members:read`、`im:chat.members:write_only`、`im:message.group_at_msg.include_bot:readonly`。
- `contact:user.base:readonly` 未开通。
- 保留 `im:message.p2p_msg:readonly` 与 `im:message.group_at_msg:readonly`，分别用于私聊和现有群内人工 `@` 机器人。
- `BOTMUX_MANUAL_SCOPE_MANAGEMENT=1` 禁止启动自检通过开放平台会话自动补回权限；权限由管理员显式管理。
- 飞书控制台提示权限关闭后立即生效，版本页显示“当前修改均已发布”，因此没有创建无意义的新版本。

## 可逆切换

- 旧 `com.local.codex-feishu-native` 已停止，但文件保留，待 BotMux 真机验收完成后再清理。
- BotMux 当前由 PM2 托管；daemon 与 Dashboard 重启后均恢复为 online，未触发权限自动补回。

## 飞书真机验收

- 自动项：WSClient ready、daemon online、Dashboard online、健康检查 200、撤回权限重启后未回弹。
- 群内人工 `@AI马仔` 已验证事件接收、话题映射与会话创建；旧 runner 已挂起，下一条消息将以 `0.149.0` 冷启动并恢复原 Codex 上下文。
- 待人工项：在原话题再发送一条消息，确认升级后的完整回复；私聊再发送一条消息。

## 清理与保留项

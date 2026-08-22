# BotMux Codex Office 第一阶段接入与切换设计

## 1. 目标

第一阶段只完成一件事：让 `marcoxiao/botmux` 的 `codex-office` 分支在当前 macOS 电脑上接管现有飞书机器人，并以 BotMux 原生能力稳定驱动 Codex。

完成标准不是“进程能够启动”，而是私聊、群聊、话题、移动端、Codex 会话、Dashboard、重启和开机自启均通过真实链路验证；通过后彻底删除 `codex-feishu-native` 的代码与运行资产。

## 2. 非目标

本阶段不开发以下能力：

- Codex Office 薄插件；
- 飞书任务、文档、评论和文件发布按钮；
- Obsidian 选择性沉淀；
- 对 BotMux 核心做审批、澄清或最终卡片扩展；
- 导入旧 Bridge 的状态、映射、任务卡或 Git 历史；
- 云端故障转移或电脑离线排队。

这些能力在 BotMux 基础链路验收后单独排序和设计。本阶段不为未来插件预埋抽象。

## 3. 代码与分支模型

唯一长期仓库为：

```text
/Users/bytedance/AiProjects/botmux
origin: https://github.com/marcoxiao/botmux.git
```

分支约定：

- `master`：保持可快进同步 `deepcoldy/botmux`，不承载个人功能；
- `codex-office`：个人长期集成分支，保存部署设计、验收记录及后续薄插件；
- 后续功能通过短期分支或 worktree 开发，验证后合入 `codex-office`；
- 不把旧 `codex-feishu-native` 的提交历史合并进来。

第一阶段原则上不改 BotMux 产品代码。若真实接入发现上游缺陷，先形成可复现测试，再以独立修复提交处理，禁止把部署配置硬编码进源码。

## 4. 运行架构

```text
飞书现有机器人
    │ WebSocket 事件
    ▼
BotMux daemon
    ├── 飞书消息、话题与卡片
    ├── Session 生命周期与持久化
    ├── Dashboard / Web Terminal
    └── Codex Agent CLI / App Server RPC
            │
            ▼
        本机原生 Codex 登录与会话
```

关键约束：

1. 复用现有飞书应用 `cli_aa9f099867385ccc`，不创建第二个机器人。
2. 同一时刻只能有一个事件消费者控制该应用。BotMux 启动前必须停止 `com.local.codex-feishu-native`。
3. BotMux 使用自身的 `~/.botmux` 配置、状态和日志；不读取或迁移旧 Bridge 的状态文件。
4. Codex 继续使用 `~/.codex` 原生登录、配置和会话；不得复制或删除 Codex token。
5. Dashboard 和 Web Terminal 首次上线只允许本机访问，不配置公网暴露。
6. 首次真机任务限定在明确的工作目录内；未通过权限审计前不扩大到整个主目录。

## 5. 身份、凭证与权限

### 5.1 飞书应用

BotMux 需要当前应用的 App ID 与 App Secret。App Secret 只通过本机隐藏输入进入 BotMux，不通过聊天、命令行参数、Git、日志或验收文档传递。

按 BotMux 上游当前契约，`~/.botmux/bots.json` 以 `0600` 保存机器人配置。上线前必须验证：

- `~/.botmux` 不允许组用户或其他用户写入；
- `bots.json` 权限严格为 `0600`；
- 日志、错误信息和进程参数不出现 App Secret；
- Git 状态中没有配置或凭证文件。

当前 `lark-cli` profiles 保留，但不作为 BotMux daemon 的凭证源。后续办公插件若需要用户身份，可单独复用现有用户授权。

### 5.2 操作者

现有飞书应用下的 owner `open_id` 可以继续使用，因为应用没有变化。群聊只开放给明确的群和成员；禁止为了快速上线配置全员操作。

### 5.3 Codex

BotMux 只调用本机现有 Codex 可执行文件和登录态。首轮配置显式指定 `cliId: "codex"`、工作目录和必要的文件隔离，不创建第二套模型凭证。

## 6. 接入流程

### 6.1 离线准备

旧服务继续运行时完成以下工作，不启动 BotMux daemon：

1. 校验仓库远端、目标 commit 和工作树清洁度；
2. 使用锁文件安装依赖；
3. 运行 BotMux 单元测试和 TypeScript 构建；
4. 检查本机 Node、pnpm、Codex、tmux 与 BotMux 必需组件；
5. 生成最小 Bot 配置并执行不占用事件流的凭证、权限和目录检查；
6. 记录旧服务进程、LaunchAgent、配置、状态和日志的精确清单。

任何基线测试或构建失败都先停止接入，不能带病切换。

### 6.2 可逆切换

切换使用短暂离线窗口：

1. 停止并 bootout `com.local.codex-feishu-native`；
2. 验证旧 Node 进程及其 `lark-cli event consume` 子进程全部退出；
3. 启动当前 `codex-office` checkout 构建的 BotMux；
4. 验证 daemon、飞书 WebSocket、Dashboard 和 Codex 运行时均为 ready；
5. 完成真机验收。

此时只停止旧服务，不删除旧文件。若核心链路失败，立即停止 BotMux、确认其消费者退出，再恢复旧 LaunchAgent。不得同时运行两套消费者进行“对比测试”。

### 6.3 不可逆清理

只有全部 P0 真机验收通过后才执行清理。删除目标必须是预先枚举的精确路径，不使用主目录级递归或通配符。

清理目标：

- `~/Library/LaunchAgents/com.local.codex-feishu-native.plist`；
- `~/.config/codex-feishu-native/`；
- `~/.local/state/codex-feishu-native/`；
- `~/.local/share/codex-feishu-native/`；
- `~/Library/Logs/codex-feishu-native/`；
- `/Users/bytedance/Documents/Codex/2026-08-21/wo-m/work/codex-feishu-native/`；
- 本次临时克隆且未承载任何提交的 `/Users/bytedance/Documents/Codex/2026-08-21/wo-m/work/botmux/`。

清理前再次核对各路径真实位置、符号链接状态和 Git 修改；删除后验证 LaunchAgent label、进程、命令、目录和日志均不存在。

明确保留：

- `/Users/bytedance/AiProjects/botmux/`；
- `~/.botmux/`；
- `~/.codex/auth.json`、`~/.codex/config.toml`、`~/.codex/sessions/` 及其它原生 Codex 数据；
- 当前飞书应用和 `lark-cli` profiles；
- Obsidian 知识库；
- 与旧 Bridge 无关的 Codex Skills、Hooks 和项目。

## 7. 验收标准

### 7.1 自动验证

- 依赖按 lockfile 安装成功；
- `pnpm test` 零失败；
- `pnpm build` 零错误；
- BotMux 配置解析、Bot 列表和状态检查成功；
- daemon 重启后恢复到 ready；
- 未发现第二套同 App ID 的飞书事件消费者；
- 配置、状态和日志权限符合上游安全契约；
- Git 工作树不包含凭证或运行状态。

### 7.2 飞书真机 P0

- owner 私聊发送最小只读问题，收到流式卡片和最终回复；
- owner 私聊发起一个限定工作目录的 Codex 任务，产物与本机一致；
- 白名单群中 `@机器人` 能创建 Session，并在原消息或话题内回复；
- 同一话题追问能继续原 Session，而不是重复创建；
- 飞书移动端能够发送、查看流式状态、追问和停止；
- 任务进行中、完成、失败和停止状态不会长期卡在错误阶段；
- BotMux 重启后已有 Session 可继续；
- Dashboard 能查看同一 Session，Web Terminal 仅本机可达；
- Codex App/CLI 原生任务和登录状态未受破坏。

### 7.3 清理后

- BotMux 开机自启并处于 ready；
- 私聊和群聊各复验一次；
- 旧 LaunchAgent、进程、安装、配置、状态、日志和源码仓库全部不存在；
- 原生 Codex 数据、飞书应用、profiles 和 Obsidian 均保留；
- `codex-office` 分支包含设计、实施记录和不含敏感信息的验收结果。

## 8. 故障与运维边界

- 电脑离线或睡眠时 BotMux 即离线，不建立云端替补和排队系统；
- daemon 异常退出由 BotMux 原生自启机制恢复；
- 飞书事件无法被本地服务消费时，不承诺机器人能够主动发送“电脑离线”提示；
- 日常排障优先使用 BotMux 原生 status、logs 和 Dashboard，不建设第二套监控；
- 第一阶段仅记录阻断上线的真实缺陷，不顺手重构 BotMux 公共层。

## 9. 后续阶段入口

第一阶段验收后，再基于真实使用差距排序薄插件能力。候选优先级只包含已确认缺口：

1. Codex 原生审批与 `requestUserInput`；
2. 飞书任务、文档、评论和文件动作；
3. Obsidian 选择性沉淀；
4. 智能最终卡片快捷动作。

每项单独设计、单独测试，不在第一阶段提前实现。

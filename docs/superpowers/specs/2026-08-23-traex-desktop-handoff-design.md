# Codex 与 TraeX Desktop Handoff 双 Provider 设计

> 路由与 Hook 安装部分已被
> `2026-08-24-same-chat-routing-and-hook-recovery-design.md` 取代。本文仅保留双 Provider
> 的历史设计背景；其中 `~/.trae/hooks.json` 和群级独占相关描述不得再用于实施。

## 目标

在现有 `desktop-handoff` 薄插件中增加 TraeX Desktop Provider：

- 「马仔」继续接管 Codex Desktop 原会话。
- 「马仔二号」接管 TraeX Desktop 原会话。
- 两个机器人都在「马仔工作台」使用独立 CardKit 话题。
- 飞书消息写回对应 Desktop 的同一会话，最终结果回到同一话题。
- Provider 离线时明确失败，不排队、不创建 BotMux 替代 Session。
- 不修改 BotMux Worker、Session、Runner 或 Codex/TraeX 专用核心链路。

## 已验证事实

- Codex Desktop 使用 `~/.codex/ipc/ipc.sock`。
- TraeX Desktop 使用 `~/.trae/cli/ipc/ipc.sock`。
- 两端 App Server 的 owner/follower 会话协议同源，可以复用现有 IPC 客户端。
- TraeX Desktop 会话元数据稳定包含 `originator: "Codex Desktop"` 和 `model_provider: "trae"`；本机历史中 `source` 同时存在 `vscode` 与 `cli`，不能把其中一个值当作唯一依据。普通 TraeX TUI 使用不同的 `originator`。
- 当前 BotMux 中「马仔」为 `codex-app`，「马仔二号」为 `traex`；只有「马仔」已启用 `desktop-handoff`。
- 插件配置和默认账本当前是插件级全局文件，不能用现有单 Bot 配置直接安全启用第二个机器人。

## 方案选择

采用同一插件内的双 Provider Adapter。

不复制第二套插件，因为 CardKit、幂等、话题路由、持久化和错误处理完全相同；复制会让修复和升级长期分叉。不使用 BotMux 原生 TraeX CLI Session 代替 Desktop 接管，因为它不能保证写回用户正在使用的 TraeX Desktop 原会话。

```text
马仔 / Codex Bot
  -> desktop-handoff(provider=codex)
  -> ~/.codex/ipc/ipc.sock
  -> Codex Desktop thread

马仔二号 / TraeX Bot
  -> desktop-handoff(provider=traex)
  -> ~/.trae/cli/ipc/ipc.sock
  -> TraeX Desktop thread
```

## 配置模型

插件配置由单 Bot 字段升级为按飞书应用 ID 索引：

```json
{
  "bots": {
    "cli_aa9f099867385ccc": {
      "provider": "codex",
      "workbenchChatId": "oc_xxx"
    },
    "cli_aa033b41d0f8dd1c": {
      "provider": "traex",
      "workbenchChatId": "oc_xxx"
    }
  }
}
```

`provider` 只允许 `codex` 或 `traex`。socket、会话识别规则、产品名称和 App 打开方式由内置 Provider 决定，不能从卡片、飞书消息或任意路径配置中注入。

插件仍由 BotMux 按 Bot 启用。收到 Hook、卡片回调或话题消息时，必须先用 `context.larkAppId` 找到唯一配置；找不到时失败关闭。

## Provider 边界

Provider 只提供以下能力：

- `id` 和对客产品名称。
- 固定 IPC socket 路径。
- 判断 Hook transcript 是否属于该 Desktop 产品。
- 探测线程、启动 turn 和跟踪完成状态所需的 IPC 连接参数。
- 打开对应 Desktop App。

实现使用两个不可变的 Provider 描述对象和共享函数，不引入基类、依赖注入容器、动态注册中心或第三方 Provider 扩展协议。

公共层继续负责：

- Hook 接收与事件规范化。
- CardKit 构造、发送、回复和更新。
- 所有者校验与话题独占路由。
- 接管状态、幂等、账本和错误提示。
- turn 级完成结果回传。

Codex Provider 仅包装当前已验证实现，不改协议行为。TraeX Provider 复用同一 IPC 客户端，仅使用独立 socket 和元数据判定；它接受 `source: "vscode"` 或 `source: "cli"`，但必须同时满足 `originator: "Codex Desktop"`、`model_provider: "trae"` 和用户主线程约束。TraeX 的“打开 App”只负责启动 `/Applications/Traex.app`，本期不宣称能深链到指定任务。

## 身份与持久化

账本升级为版本 2，所有会话状态使用复合身份：

```text
larkAppId + provider + threadId
```

该身份用于：

- 已确认的 Desktop turn。
- 完成事件及其幂等 ID。
- CardKit 根消息和接管状态。
- 话题反向路由。

`routeByRoot` 同时校验 `larkAppId` 和根消息 ID。即使 Codex 与 TraeX 出现相同 `threadId`，也不能读取、更新或投递到对方的事件与话题。

当前版本 1 账本在部署前通过一次性迁移程序转换：所有既有记录归入 Codex Bot 和 `codex` Provider，完整保留 `rootMessageId`、`rootEventId`、`latestEventId` 与 `adoptedAt`。迁移先校验、再原子替换；失败时旧账本保持不变。运行时代码只读取版本 2，不保留永久兼容分支。

## 双端数据流

### Desktop 主动完成

1. Codex 或 TraeX 的 `UserPromptSubmit` Hook 发送本地插件事件，并明确目标 Bot ID。
2. 插件用 Bot ID 选择 Provider，校验 transcript 的 Desktop 来源，记录复合 turn 身份。
3. `Stop` Hook 到达后生成完成事件。
4. 已有绑定时回复同一 CardKit 话题；没有绑定时，由对应机器人在工作台创建根卡。

Hook 安装分别写入 `~/.codex/hooks.json` 与 `~/.trae/cli/hooks.json`，只追加插件自己的幂等条目，不覆盖已有 Hook。旧 `~/.trae/hooks.json` 中的 Handoff 条目必须清理。安装前已经打开的任务需要重启对应 App 后重新打开一次，并通过产品原生 Hook trust 流程，以加载新 Hook。

### 飞书接管

1. 所有者点击对应机器人根卡的“在飞书中接管”。
2. 插件根据事件复合身份选择 Provider，只探测该 Provider 的 socket 和线程。
3. 探测成功后写入 `adoptedAt` 并更新 CardKit；失败时不写入接管状态。

### 飞书继续处理

1. BotMux 将话题消息交给插件。
2. 插件按 `larkAppId + rootMessageId` 找到已接管路由。
3. Provider 将非空文本写入对应 Desktop thread。
4. follower stream 只跟踪该次 `clientUserMessageId + turnId`。
5. 最终结果由同一机器人回复同一个 CardKit 话题，随后取消本轮订阅并关闭 IPC。

同一 Desktop thread 同时只允许一个活动 turn。两个端都可以持续交替发送，但插件不建立并发队列；Desktop 返回 busy 时，CardKit 明确提示等待当前轮次结束后重发，不把消息转交给其他 Session。

## CardKit 体验

公共卡片布局保持一致，只替换产品文案：

- `Codex Desktop 任务完成 / 新进展`
- `TraeX Desktop 任务完成 / 新进展`
- `打开 Codex App / 打开 TraeX App`

状态仍为：完成通知、已接管、离线、送达不确定、结果回传中断和不支持的消息。TraeX 不新增另一套卡片组件。

## 错误与安全边界

- Bot 未配置、Provider 不匹配、非所有者、跨机器人卡片和跨话题消息均失败关闭。
- 仅允许固定 socket 路径；外部输入不能指定本地路径或可执行程序。
- 一个 Provider 离线或协议失败不得探测另一个 Provider，也不得回退到普通 BotMux Session。
- Desktop 离线时不排队；用户恢复 App 后显式重发。
- Desktop thread 正在执行时不排队；明确提示等待后重发。
- turn 启动超时且送达不确定时禁止自动重放，避免重复执行。
- follower 中断时提示到 Desktop 查看，不自动重发。
- 日志不写飞书凭证、完整提示词、完整会话快照或 App Server 帧。
- 账本继续使用 `0600` 文件权限和原子写入。

## 非目标

本期不实现：

- 图片、文件、语音写入 Desktop。
- token 级流式镜像。
- Desktop 审批和澄清同步。
- TraeX 精确任务深链。
- 第三个通用 Provider 或动态 Provider 插件系统。
- 全量历史会话镜像。

## 验证与发布门槛

### 自动测试

- Codex Provider 保持现有 IPC、Hook 和 CardKit 行为。
- TraeX Provider 选择独立 socket，接受 Desktop 的两种已观察 `source`，并通过 `originator + model_provider + thread_source` 拒绝普通 TraeX CLI。
- 两个 Provider 使用相同 `threadId` 时仍生成不同事件、账本路由和消息目的地。
- 版本 1 账本原子迁移后，Codex 根话题和接管状态不变。
- 两个 Bot 的 Hook、卡片回调和话题消息只能命中自己的 Provider。
- 单独模拟 Codex/TraeX 离线、送达不确定和 follower 中断。
- 插件全量单元与构建检查通过；BotMux 插件协议与消息分发相关回归通过。

### 本机真实回归

1. 先回归现有 Codex：飞书发送进入同一 Desktop thread，最终回复回到同一话题。
2. 从 Codex Desktop 主动发送一轮，完成结果进入已绑定话题。
3. TraeX Desktop 完成一轮，由「马仔二号」在工作台生成根卡。
4. 点击接管并从话题发送，确认消息进入同一 TraeX Desktop thread，回复回到同一话题。
5. 从 TraeX Desktop 主动发送下一轮，确认继续回到同一话题。
6. 分别关闭一个 App，确认只影响对应机器人且不排队。
7. 重启 BotMux，确认两个绑定继续有效。

### 发布顺序

1. 完成代码和自动测试，不修改运行配置。
2. 构建新插件产物并校验迁移输入；此时旧 BotMux 仍使用旧代码和旧账本。
3. 短暂停止 BotMux，避免旧进程在迁移窗口读取新版账本。
4. 一次性迁移账本、更新双 Bot 配置并安装 TraeX Hook。所有新内容先写入临时文件并校验；替换前保留原文件快照，任一步失败都在 BotMux 重启前恢复整组旧文件。
5. 启动 BotMux，先执行 Codex 真实回归；失败则立即停止发布，不启用「马仔二号」。
6. Codex 通过后为「马仔二号」启用插件并执行 TraeX 真实回归。

只有两个真实闭环均通过，才声明双 Provider 功能完成。

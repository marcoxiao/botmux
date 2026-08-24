# Desktop Handoff 同群路由与 Hook 恢复设计

**状态：** 已确认，待实施
**日期：** 2026-08-24
**涉及仓库：** `botmux`、`botmux-plugin-desktop-handoff`

## 背景与已实锤根因

当前故障不是一处偶发错误，而是两条独立链路同时失效：

1. 飞书到 Codex Desktop：插件预先把整个工作台群注册成 `exclusive chat`。当普通新话题的 `root_id/thread_id` 没有命中 Handoff 根消息映射时，BotMux 仍直接消费消息，不再交给普通 Session 路由，因此消息被静默吞掉。
2. Codex Desktop 到飞书：Handoff Hook 虽然存在于 `~/.codex/hooks.json`，但没有对应的原生 Hook 信任记录；目标任务产生了完成事件，插件账本却没有收到本地事件。
3. TraeX Desktop 到飞书：Handoff Hook 安装在已废弃的 `~/.trae/hooks.json`，而 TraeX App 实际读取 `~/.trae/cli/hooks.json`。目标任务产生了完成事件，插件账本同样没有收到本地事件。
4. 截图中 TraeX 的飞书回复来自 BotMux 新建的 TraeX CLI Session，不是写回 TraeX Desktop 的 IPC 闭环；这不能证明 Desktop Handoff 正常。

根本设计错误是使用 `chat_id` 表达消息所有权。同一个群既承载普通 BotMux 新话题，又承载 Handoff 卡片回复，`chat_id` 不具备区分两者的信息量；正确路由身份只能是 Bot 对应的飞书应用 ID 加卡片根消息 ID/真实 thread ID。

## 目标与不变量

同一个工作台群必须同时满足：

- 普通新话题 `@机器人` 进入对应机器人的普通 BotMux 会话。
- 仅回复已登记的 Handoff 卡片根消息时，消息写回对应 Desktop 原会话。
- Codex 与 TraeX 使用同一群、独立飞书应用 ID 和独立 Desktop Provider，不能串线。
- 已登记根消息即使插件暂时禁用，也继续 fail-closed，不能误建普通 Session。
- 未登记根消息永远不能因为群级状态被插件吞掉。
- Desktop Hook 只安装在产品当前实际读取的 canonical 配置文件中；安装必须幂等且不得覆盖其他 Hook。
- 运行环境只保留一套 BotMux 安装和一个 supervisor；每个已启用 Bot 一个 daemon、整套服务一个 dashboard 属于预期拓扑，不把正常子进程误判成重复服务。

## 路由设计

### Desktop 到飞书

```text
canonical + trusted Desktop Hook
  -> botmux plugin emit desktop-handoff --bot <larkAppId>
  -> desktop-handoff 本地事件校验
  -> 发送或回复 CardKit
  -> BotMux 记录 (larkAppId, rootMessageId, threadId alias) 的持久根声明
```

插件发送新根卡时继续使用 `replyClaim: "exclusive"`。这里的 `exclusive` 只表示“这个根及其 thread alias 归插件所有”，不表示整个 chat 归插件所有。

### 飞书到 Desktop 或普通 BotMux

```text
飞书话题消息
  -> 用 (larkAppId, root_id/thread_id) 查询持久根声明
     -> 命中：只调用声明所属插件；插件不可用或拒绝时 fail-closed
     -> 未命中：插件可观察并返回 handled=false，随后进入普通 BotMux 路由
```

插件内部仍以 `larkAppId + provider + threadId` 查账本并校验所有者、接管状态和固定 socket。根声明负责“由谁处理”，插件账本负责“写回哪个 Desktop 会话”，两者职责不混合。

## 代码收敛与历史实现清理

### BotMux Core

彻底删除群级独占抽象，不保留兼容分支：

- 删除 `LarkPluginHost.claimExclusiveChat`。
- 删除 `ExclusiveChatClaim`、`exclusiveChats`、`claimExclusiveChat`、`hasExclusiveChat` 和 `chatKey`。
- 删除消息分发器的 `hasClaimedChat` 参数及“未解析话题在独占群中直接消费”分支。
- 删除 daemon 中对应 Host 能力和分发注入。
- 删除只为该错误抽象存在的测试夹具与断言。

持久根声明、真实 thread alias 查询和已声明根的 fail-closed 语义保持不变。这样修复是删除错误状态维度，不引入新的兜底分叉。

### Desktop Handoff 插件

- 删除创建根卡前的 `host.claimExclusiveChat(...)` 调用。
- 删除插件侧 Host 类型和测试 mock 中的同名能力。
- 不把普通 Session、飞书鉴权或消息分发逻辑搬进插件。
- 不增加 Provider 基类、注册中心、队列或第三套 transport；插件继续只负责事件校验、账本、CardKit 和 Desktop IPC。

### Hook 安装与清理

提供一个受测试的幂等安装脚本，使用标准库完成 JSON 解析、结构校验、临时文件写入和原子替换：

- Codex canonical 文件：`~/.codex/hooks.json`。
- TraeX canonical 文件：`~/.trae/cli/hooks.json`。
- 只识别并增删 `botmux plugin emit desktop-handoff --bot <id> --best-effort` 这一精确命令。
- 保留所有非 Handoff Hook 及其顺序。
- 从旧 `~/.trae/hooks.json` 删除精确匹配的 Handoff 条目；如果文件还有其他 Hook，则保留文件。
- 重复执行结果不变；损坏或未知结构直接失败，不猜测、不覆盖。
- 不生成、复制或伪造 Codex/TraeX 的原生 Hook trust 哈希。安装后必须通过产品原生信任流程，并用真实 Hook 事件验收。

README 和旧设计文档中的 TraeX 路径、群独占描述同步更正，避免文档再次引导出双轨配置。

### 运行态历史数据与进程

发布时先备份再清理，不在运行时代码中永久携带迁移分支：

- 从 `~/.botmux/lark-plugin-message-claims.json` 删除遗留 `exclusiveChats`，完整保留 `claims` 根声明。
- 确认 `~/.botmux/plugins/desktop-handoff/dist` 只指向当前插件仓库唯一构建产物，不保留第二份 materialized 代码。
- 清理旧 TraeX Handoff Hook；Codex/TraeX 最终各只有 canonical 文件中的一组 Handoff Hook。
- 停止 BotMux 后核对 PID 所属关系，只清理由旧发布遗留且不受当前 supervisor 管理的 daemon/dashboard/worker；不删除用户正在使用的独立 Codex/TraeX App 进程。
- 最终只保留一个 launchd 服务 `com.botmux.daemon`、一个 PM2 supervisor、两个 Bot daemon 和一个 dashboard。BotMux Session 的 worker/TUI 子进程按活动 Session 数量存在，不作为重复服务强杀。
- 仅移除已合并且 clean 的临时 Git worktree；dirty 或来源不明的工作区不自动删除。

当前审计已确认 BotMux 主服务本身是单 supervisor 拓扑：一个 PM2 父进程管理两个 Bot daemon 与一个 dashboard。后续清理的重点是旧路由状态、旧 Hook 位置和发布后可能残留的孤儿进程，而不是把双 Bot 的两个 daemon 错删成一个。

## 错误、安全与一致性边界

- 根声明写入必须在 CardKit 根消息发送成功且取得真实 thread ID 后完成；取不到 thread ID 时发送视为失败。
- 已声明根在插件禁用、所有者不匹配、未接管或 Provider 不匹配时保持 fail-closed。
- 未声明根只走普通路由，不探测 Desktop socket。
- Desktop 离线、busy、送达不确定和 follower 中断继续明确返回，不排队、不自动重放。
- socket 路径固定在 Provider 内部，飞书输入不能指定本地路径或可执行程序。
- 清理配置和账本前创建带时间戳备份；写入使用同目录临时文件、权限 `0600` 和原子替换。验证失败时在重启服务前恢复。
- 不记录飞书凭证、完整提示词、完整 transcript 或 IPC 帧。

## TDD 与自动验证

### BotMux Core

先写失败测试，再删除实现：

- 未声明 root/thread 的话题返回 `false`，即使历史 claims 文件仍含未知的 `exclusiveChats` 字段。
- 已声明 root 和 thread alias 都只交给声明插件。
- 已声明根在插件未启用、无发送者或无权限时仍返回 `true`。
- 不同 `larkAppId` 下相同 root/thread 不串线。
- claim store 重启后只恢复根声明，不再暴露群级 API。

### 插件与安装器

- Codex/TraeX 首次根卡投递不调用任何群级声明能力，只请求根级 `replyClaim`。
- 两个 Provider 相同 thread ID 时仍映射到各自 Bot 和 socket。
- 未登记根返回 `handled=false`；登记根的所有者、接管、busy、离线和最终回复行为完整覆盖。
- 安装器覆盖首次安装、重复安装、保留其他 Hook、旧 TraeX 条目迁移、损坏 JSON 拒绝、文件权限和原子写入。
- 插件 `build + test`、BotMux 插件协议/消息路由测试、类型检查和相关全量回归全部通过。

## 真实端到端验收矩阵

发布后必须保留消息 ID、线程 ID、插件账本记录和 daemon 日志作为证据，覆盖以下矩阵：

| 方向 | Codex | TraeX |
|---|---|---|
| Desktop 完成 -> 飞书根卡/同话题回复 | 必须通过 | 必须通过 |
| 飞书回复 Handoff 根卡 -> 同一 Desktop 会话 -> 结果回原话题 | 必须通过 | 必须通过 |
| 飞书普通新话题 -> 普通 BotMux Session | 必须通过 | 必须通过 |

还需验证：

- Codex/TraeX 使用同一工作台群时互不串线。
- 重启 BotMux 后既有根声明仍有效，普通新话题仍可创建 Session。
- 分别关闭 Codex 或 TraeX，只影响对应 Handoff，不回退到另一 Provider。
- 两个 canonical Hook 配置各只有一组命令，旧 TraeX 文件不再含 Handoff。
- 服务重启后 supervisor、daemon、dashboard 数量符合预期，端口和 PID 文件均指向同一套安装。

任一真实闭环未通过，都不能声明修复完成。

## 深层 Review 门槛

实现完成后单独进行一轮跨仓 Review：

1. 从消息进入点重新追踪到 Desktop IPC 和结果回传，确认每个分支与本设计一致。
2. 检查删除量是否真正消除了群级抽象，禁止用改名或新兜底保留旧语义。
3. 检查插件边界：Core 只提供通用根声明与 transport，插件不侵入 Session/Worker；插件也不复制 Core 路由。
4. 检查状态身份、幂等、原子写入、权限、错误传播和日志脱敏。
5. 检查死代码、重复类型、过时文档、旧脚本、临时 worktree、构建产物和运行进程。
6. 重新运行自动测试与真实验收，不以静态 Review 替代运行证据。

## 非目标

- 不支持图片、文件、语音、审批或 token 级流式镜像。
- 不实现离线队列、自动重放或普通 Session 到 Desktop 的兜底。
- 不增加第三 Provider 或动态 Provider 框架。
- 不改变 BotMux 每 Bot 一个 daemon 的既有进程模型。
- 不删除正常 Git 历史、用户 dirty 工作区或正在使用的独立 Desktop App。

## 发布与回滚顺序

1. 在隔离 worktree 中按 TDD 完成 Core 与插件变更，执行深层 Review。
2. 构建两边产物并记录校验结果；此时不动运行配置。
3. 创建 claims、Hook 和插件配置备份，校验可恢复。
4. 停止唯一 BotMux supervisor，确认不存在旧 supervisor 或孤儿 daemon/dashboard。
5. 清理遗留 `exclusiveChats`、迁移 TraeX Hook、安装 Codex/TraeX canonical Hook，部署唯一插件产物。
6. 启动唯一 supervisor，核对进程拓扑和健康日志。
7. 完成自动验证与全部真实验收矩阵。
8. 若任一关键链路失败，停止服务，恢复配置/账本/产物备份，再启动旧版本；不在半迁移状态继续运行。

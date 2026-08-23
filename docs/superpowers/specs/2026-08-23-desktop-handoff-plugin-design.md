# Desktop Handoff Plugin Design

**状态：** 已确认

**日期：** 2026-08-23

**取代：** `docs/design/codex-notifier.md` 中的内建 Desktop 接管设计

## 1. 决策

把 Codex/Traex Desktop 与飞书同会话协作实现为独立的 `desktop-handoff` BotMux 插件。BotMux 核心只增加与具体 Agent 无关的飞书插件分发协议和持久路由占用，不再理解 Desktop thread、Codex/Traex IPC、完成 Hook 或接管状态。

用户必须在任务通知卡上显式点击“飞书接管”。接管成功后，该飞书话题的后续消息只能进入被绑定的同一个 Desktop thread；Desktop 离线或插件异常时明确失败，不排队、不启动第二个 App Server，也不退回普通 BotMux Session。

## 2. 背景与根因

BotMux 原生跨端能力适用于 BotMux 自己创建的 App Server/CLI 会话，`/adopt` 适用于可观察和写入的终端复用器会话。已经由 Codex Desktop GUI 打开的 thread 有自己的权威 writer，不能通过启动第二个 App Server 安全接管。

现有实现把 Desktop thread 改写成特殊 BotMux Session，并在 daemon、command handler、message parser、worker、Dashboard 和 Session schema 中增加了 Desktop 专属分支。这使一次飞书回复同时依赖 BotMux Session 生命周期、Worker 恢复、prepared dispatch、飞书话题路由和 Desktop 私有 follower IPC，产生了错误恢复、假在线、错误回退和上游合并冲突。

已经确认的正确输入通道是 Desktop owner/follower IPC。Codex Desktop 使用 `~/.codex/ipc/ipc.sock`；当前 Traex.app 复用相同 Desktop 运行时和协议，使用独立的 `~/.trae/cli/ipc/ipc.sock`。因此二者应共享一个协议客户端，仅由 Provider 提供固定配置。

## 3. 目标与非目标

### 目标

- Codex/Traex Desktop 完成任务后，在指定飞书机器人和话题中发送统一 CardKit 通知。
- 点击“飞书接管”后持久绑定 `飞书话题 -> Provider + Desktop threadId`。
- 飞书回复进入同一个 Desktop thread，Desktop 侧结果回到同一个飞书话题。
- 插件、Desktop 或 BotMux 重启后绑定仍然有效。
- 离线、忙碌、超时和协议失败均 fail closed，不产生隐式排队或替代会话。
- 自定义代码集中在独立插件；上游冲突仅限小型、通用的插件协议接线。
- Codex 和 Traex 共用实现但严格隔离身份、配置、socket 和目标机器人。

### 非目标

- 不通过第二个 App Server 恢复正在 Desktop 中打开的 thread。
- 不把 Desktop 接管伪装为 BotMux Worker、普通 Session 或 `/adopt` 会话。
- 不实现离线消息队列、自动切换 Provider、跨机器人猜测 thread 所属关系。
- 不保证私有 Desktop IPC 在未来版本永久兼容；协议不兼容时明确停用该 Provider。
- 不保留旧内建实现的运行时兼容分支。

## 4. 方案比较

### A. 插件拥有 Desktop 绑定，核心提供通用分发（采用）

核心只负责安全地把飞书事件交给已声明并占用路由的插件。插件拥有完成事件、CardKit、Desktop IPC、绑定和幂等。这满足最小核心改动和同会话写回。

### B. 特殊 BotMux Session（拒绝）

复用 Session/Worker 的表面成本较低，但会继续混合两个所有权模型，保留当前 prepared dispatch、恢复和错误回退问题。

### C. 独立伴随进程重新连接飞书（拒绝）

可以做到核心零改动，但会重复消费飞书事件、重复管理凭证和进程，并可能与 BotMux 的长连接竞争，运维与一致性更差。

## 5. 总体架构

```text
Codex / Traex 完成 Hook
        │
        ▼
botmux plugin emit desktop-handoff
        │  通用鉴权插件事件
        ▼
desktop-handoff plugin
        │
        ├── CardKit 通知/更新 ─────────────► 飞书话题
        │                                      │
        │                         点击“飞书接管”│
        │                                      ▼
        │                         通用卡片插件分发
        │                                      │
        └──────── Desktop owner 探测 ◄─────────┘
                       │
                       ▼
          核心占用话题路由 + 插件保存 binding

飞书话题回复
        │
        ▼
核心插件路由占用表
        │
        ▼
desktop-handoff.handleMessage
        │
        ▼
Codex 或 Traex Desktop follower IPC
        │
        ▼
同一个 Desktop thread
```

插件不创建 BotMux Session 或 Worker。已接管话题在普通会话查找和创建之前被通用插件路由消费。

## 6. BotMux 通用插件扩展

### 6.1 静态贡献

插件增加一个飞书贡献入口，静态声明 schema 版本、入口文件和 Action ID。安装和 daemon 启动时校验重复 Action ID；冲突直接失败，不按安装顺序抢占。

`desktop-handoff` 声明：

- `desktop_handoff.takeover`
- `desktop_handoff.open_app`

核心不知道这些 Action 的业务语义。

### 6.2 运行时契约

飞书插件运行时只支持三个入口：

- `handleMessage(context, api)`：处理核心已路由给该插件的消息。
- `handleCardAction(context, api)`：处理插件声明的卡片 Action。
- `handleLocalEvent(event, api)`：处理通过通用本地事件入口投递的 Hook 事件。

核心 Host API 只提供：

- 发送、回复、更新 CardKit 消息；
- 查询当前机器人管理员身份；
- 占用、查询、释放插件话题路由；
- 插件私有配置和数据目录；
- 结构化日志与请求截止时间。

Host API 不暴露 `DaemonSession`、Worker、App Server、Session Store 或 BotMux 内部消息队列。

### 6.3 持久路由占用

核心保存最小记录：

```text
larkAppId + chatId + scope + anchor -> pluginId + opaqueClaimId
```

`opaqueClaimId` 由插件提供，核心只做长度和字符校验，不解释其业务含义。插件用它在崩溃恢复时关联自己的事件记录。核心不保存 Provider、threadId、消息正文或 Desktop 信息。消息命中路由后只调用对应插件；插件缺失、加载失败或超时时，核心明确回复“接管插件当前不可用”并停止处理，绝不回退到普通 Session。

插件升级或 daemon 重启期间，持久路由仍保持 fail closed。只有插件显式释放路由后，话题才恢复 BotMux 原生处理。

### 6.4 本地插件事件

`botmux plugin emit <plugin-id>` 从标准输入读取有大小上限的 JSON，经现有本机 daemon 身份与目标 Bot 鉴权后调用 `handleLocalEvent`。核心只校验 envelope、目标插件和目标机器人，不解释事件正文。

Hook 只进行有界采集和本地可靠入队，不直接持有飞书凭证。插件自己的 outbox 负责重试，目标机器人在入队时固定。

## 7. desktop-handoff 插件

```text
plugins/desktop-handoff/
├── lark/                 # 消息、卡片和本地事件入口
├── providers/
│   ├── codex.ts          # Codex 固定配置
│   └── traex.ts          # Traex 固定配置
├── desktop-ipc.ts        # 共用 owner/follower 协议客户端
├── binding-store.ts      # 话题到 Desktop thread 的绑定
├── event-store.ts        # 完成事件和投递收据
├── outbox.ts             # Hook 可靠投递
├── cards.ts              # 统一 CardKit 状态卡
├── hook/                 # Provider Hook 安装与采集
└── dashboard/            # 插件配置页
```

### 7.1 Provider 契约

Provider 是静态注册项，提供：

- `id` 与展示名称；
- 固定 IPC socket；
- Hook 根目录；
- Desktop App 打开方式；
- 允许的事件来源标识。

Codex 和 Traex 共用 `desktop-ipc.ts`，不复制帧解析、owner 发现或 follower turn 发送逻辑。事件必须显式携带 Provider，不能根据 threadId、cwd 或当前在线 App 猜测。

### 7.2 接管状态

只持久化三种状态：

- `notified`：有完成事件但话题尚未接管；
- `adopting`：接管事务执行中；
- `bound`：路由和插件 binding 均已提交。

Desktop 离线不是新的持久状态。`bound` 保留，单次消息投递失败并提示用户打开原任务后重发。

### 7.3 接管事务

1. 校验 Action、事件 ID、卡片消息 ID、操作者和目标机器人。
2. 从本地账本恢复 Provider 和 threadId，不信任卡片携带的业务字段。
3. 对固定 Provider socket 执行 owner 探测。
4. 核心以当前事件 ID 作为 opaque claim ID，原子占用话题路由；此后任何消息都不会落入原生路由。
5. 插件持久化 binding；失败时释放核心路由。
6. 更新原 CardKit 为“已接管”。

只有步骤 5 成功后才能展示绿色成功。步骤 4 到 5 的短窗口内若收到消息，插件返回“正在接管”，仍然 fail closed。

重复点击同一事件返回当前成功状态。用另一个有效事件接管同一话题时，先验证新 Desktop owner，再原子替换 binding；验证失败不影响旧绑定。

### 7.4 飞书消息投递

- 使用飞书 `message_id` 作为 Desktop `clientUserMessageId` 和幂等键。
- 每个话题串行跨越“查 binding、发送 follower turn、写收据”的接纳边界。
- owner 探测只对明确的 `no-client-found` 做最多三次限界重试，以覆盖 Desktop 的短暂发现窗口。
- `startTurn` 永不自动重放；连接断开后的结果可能不确定，自动重放会重复执行。
- Desktop 明确接受后，插件把任务卡更新为“处理中”；失败时更新为统一错误卡。
- Desktop 离线、thread 未打开、忙碌或协议错误时不排队、不启动 App Server、不创建 BotMux Session。

### 7.5 完成事件与 CardKit

完成 Hook 以稳定 `event_id` 去重。插件按 Provider、threadId 和未结算飞书消息定位同一任务卡并更新为完成、失败或取消；重复 Hook 只重放幂等更新，不发送第二张卡。

Desktop 直接发起且尚无飞书话题的任务产生一张新的根卡；同一 thread 后续完成事件回复或更新该话题。接管后的飞书回合始终更新该话题中的任务卡。

## 8. 数据与一致性

核心路由占用表和插件 binding store 都采用原子写入、`0700` 目录和 `0600` 文件，并设置明确容量上限。核心记录只负责阻止错误回退；插件记录是 Desktop 路由事实源。

顺序选择“核心先占用、插件后落 binding”：

- 核心占用失败：不改变插件状态；
- binding 写入失败：释放核心占用；
- 两步之间崩溃：核心仍 fail closed，插件启动时用 opaque claim ID 查找自己的事件记录，完成 binding；对应事件不存在或已失效时释放孤儿占用；
- CardKit 更新失败：binding 已成功，不回滚接管；插件通过 outbox 重试界面更新。

消息收据和事件收据均有上限并按时间淘汰。收据只保存幂等身份和状态，不保存完整消息正文或 Desktop 会话快照。

## 9. 安全边界

- 只有目标机器人的管理员可以接管或打开 Desktop App。
- 回调只携带事件 ID；Provider 和 threadId 从本地事件账本恢复。
- 卡片消息 ID 必须与已送达事件收据一致，拒绝复制或伪造卡片。
- Provider socket 和 Hook 路径是代码中的固定配置，不能由飞书载荷覆盖。
- 插件事件入口限制大小、拒绝额外危险字段，并绑定目标 Bot 和插件 ID。
- 日志不记录凭证、完整用户消息、完整 AI 回复或 Desktop snapshot。
- 插件异常时已占用路由 fail closed；安全性优先于自动降级可用性。

## 10. 旧实现清理与一次性迁移

实施完成后删除：

- `src/features/codex-notifier` 内建目录；
- `daemon.ts` 的 notifier、Desktop 接管和 follower 路由分支；
- `command-handler.ts` 的 Desktop thread 接管逻辑；
- `card-handler.ts`、`message-parser.ts` 的 Codex 专属 Action 分支；
- Session schema 的 `codexAppTransport` 和相关专属字段；
- Worker、Dashboard 和设置页的 Desktop notifier 特判；
- 只验证旧内建分支的测试与文档；
- 当前旧实现上的未提交重试补丁。

保留 BotMux 原生 `codex-app`、Traex CLI/App Server、通用 CardKit、通用 TurnProgress 和普通 Session/Worker 能力。

本机切换前执行一次离线迁移：

1. 停止 BotMux，冻结事件写入；
2. 把仍有效的话题路由和事件收据转换到插件存储；
3. 把旧 `desktop-ipc` BotMux Session 标记关闭；
4. 保存只读备份并校验条目数和 threadId；
5. 安装插件、启动 BotMux 并进行双端验收；
6. 验收后删除一次性迁移脚本和旧运行状态，不保留兼容读取分支。

迁移不删除 Codex/Traex 原生历史、rollout 或 Desktop thread。

## 11. 测试策略

### 核心插件契约

- 静态 Action 注册、重复 Action 冲突和 schema 校验；
- 路由占用、释放、重启恢复和容量边界；
- 已占用路由只进入对应插件；
- 插件缺失、崩溃或超时时 fail closed；
- 未占用话题保持 BotMux 原生行为；
- 本地插件事件的鉴权、大小限制和目标绑定。

### 插件单元与集成测试

- Codex/Traex Provider 固定 socket 与来源隔离；
- Desktop IPC 分帧、帧上限、owner 发现和 follower turn；
- `no-client-found` 限界重试，`startTurn` 不重放；
- 接管鉴权、卡片来源校验和原子状态转换；
- 飞书 message ID、Hook event ID 和 CardKit 更新幂等；
- 接管中并发消息不穿透；
- 同话题替换 binding 成功和验证失败保留旧 binding；
- 重启恢复、孤儿核心占用恢复和损坏存储 fail closed。

### 端到端验收

- Codex：Desktop 完成通知、点击接管、飞书写入原 thread、Desktop 结果回原话题；
- Traex：执行相同完整链路，并证明只访问 Traex socket；
- Codex/Traex 即使出现相同 threadId 也不串机器人；
- Desktop 离线时不排队、不创建 BotMux Session，恢复后用户重发成功；
- 重复点击、重复飞书事件和重复 Hook 不产生第二个 turn 或第二张卡；
- BotMux/插件重启后原绑定继续工作；
- 飞书桌面端和手机端 CardKit 点击、话题回复均可用；
- BotMux 原生 Codex App、Traex CLI、普通群聊和 `/adopt` 不受影响。

变更前记录全量测试基线。完成时要求新增专项测试全部通过、全量测试没有新增失败，并模拟合并最新上游，确认自定义冲突集中在通用插件扩展点。

## 12. 验收标准

- 用户能从 Codex 和 Traex 完成卡显式接管。
- 接管成功后，飞书消息可在 Desktop 原 thread 中看到，Desktop 回复回到同一话题。
- 任一故障场景都不会创建替代 BotMux 会话或静默排队。
- BotMux 核心不含 Codex/Traex Desktop 专属 import、字段、Action ID 或路由分支。
- `desktop-handoff` 可独立安装、升级和卸载；卸载前必须显式释放或迁移其路由占用。
- 旧内建代码、测试、配置 UI 和永久兼容分支全部清理。

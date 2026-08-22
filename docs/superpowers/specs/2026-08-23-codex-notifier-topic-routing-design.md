# Codex 完成通知按会话收敛到飞书话题设计

日期：2026-08-23
状态：方案 A 已确认，Review 订正完成，待书面确认

## 1. 背景与问题

当前 Codex Notifier 在每个符合条件的 Codex 原生 turn 完成后，向所选机器人的管理员私聊发送一张完成卡。`notifyWhen = always` 表示每次符合条件的 turn 都通知，并不表示每个 Codex 会话只通知一次。内部任务、子代理、BotMux 自己托管的会话会被过滤，同一个原生 turn 会去重。

这条链路已能从完成卡接管原 Codex App 会话，但所有通知平铺在机器人私聊里，多个 Codex 会话混在一起。用户希望把通知统一投到“马仔工作台”，并以 Codex 会话为单位形成飞书话题：一个 Codex 会话一个话题，同一会话的后续完成通知和飞书续聊都留在该话题中。

## 2. 目标

1. 在正常运行、并发投递及飞书 UUID 幂等窗口内，一个 Codex `threadId` 在同一冻结投递目的地中只对应一个飞书话题根消息；跨窗口崩溃恢复的边界见第 8 节。
2. 在同一冻结投递目的地内，同一 Codex 会话的后续完成卡回复到同一话题；不同会话进入不同话题。
3. 点击任意一张可接管的普通 Codex App 完成卡后，在话题内继续发送消息会进入原 Codex App 会话。
4. 保持现有 `always` 语义、事件去重、管理员鉴权、打开 Codex App、可靠 outbox 和电脑离线不排队的行为。
5. 目标群通过 Dashboard 配置，不在代码中硬编码“马仔工作台”或具体 `chatId`。
6. 设计只增加通知目的地与话题路由，不建立新的消息总线、数据库或通用 Agent 框架。

## 3. 非目标

- 不把每个 turn 拆成独立话题。
- 不把多个 Codex 会话合并进一个公共话题。
- 不同步 Codex App 中的逐字流式输出；仍以 turn 完成通知为稳定边界。
- 不在电脑或 Codex App 离线时排队执行飞书输入；明确提示离线即可。
- 不改变 BotMux 管理的 Codex/TRAE 会话的既有飞书话题能力。
- 本期不实现独立 Trae App/CLI 的全局完成监听，也不宣称能接管回原 Trae App 会话。
- 不新增旧配置兼容框架：事件入队时 `targetChatId` 缺省即冻结为当前管理员私聊行为。

## 4. 方案选择

评估过三种形态：

1. **一个 Codex 会话一个飞书话题（采用）**：上下文边界与 Codex `threadId` 一致，通知和续聊自然收敛，适合跨端办公。
2. 每个完成 turn 一个话题：实现最简单，但同一任务会产生大量碎片话题，无法连续协作。
3. 所有完成通知进入一个话题：表面整洁，实际混合多个任务上下文，容易误接管和误回复。

采用方案 1。第一条完成卡就是话题根消息，不额外发送“已创建话题”占位消息。

## 5. 产品行为

### 5.1 通知频率

保持 `notifyWhen = always`：每个通过现有过滤与去重规则的原生 turn 完成后生成一张完成卡。变化只在投递位置：同一 `threadId` 的卡片按时间进入同一个飞书话题。

### 5.2 首次与后续通知

- 事件冻结的目标群中尚无该 `threadId` 路由时，发送完成卡；返回的消息 ID 成为话题根消息 ID，并持久化路由。
- 已有路由时，通过飞书原生 `replyMessage(..., replyInThread = true)` 回复根消息。
- 普通 Codex App 完成卡继续保留“在飞书中继续处理”；只有现有 `canOpenApp` 判断支持时才展示“打开 Codex App”。
- Side Chat 完成事件也可按自身 `threadId` 收敛到话题，但沿用现状，仅作为结果通知，不展示接管或打开 App 动作。
- 飞书话题标题由首张卡自然展示的 Codex 会话标题承载，不再创建单独标题消息。

### 5.3 接管与续聊

点击任意一张可接管的非 Side Chat 完成卡时，回调仍用事件账本校验卡片来源、事件 ID 和操作者。只有目标机器人的管理员可以接管。Side Chat 卡片没有接管入口。

群话题接管时，实际被点击的卡片 ID 只作为来源凭证；BotMux 必须确认该卡片所在群与持久化路由一致，然后以路由根消息建立可信目的地 `{ chatId, rootMessageId, chatType: 'group', scope: 'thread' }`。不能使用被点击的后续卡片 ID 作为新锚点，也不能使用当前 Dashboard 配置猜测锚点。私聊接管继续沿用现有目的地推导。现有 Desktop owner/follower IPC 继续负责把输入交给唯一的 Codex App Server 写入者。

为使接管后的话题可以不重复 `@机器人`，Codex 目标 Bot 使用 BotMux 已有的 `regularGroupMentionMode = 'topic'`：已归属该 Bot 的话题内允许管理员直接续聊；用户 `@` 其他成员或马仔二号时，Codex Bot 让出处理权；群主时间线中的新对话仍需 `@Codex Bot`。Dashboard 只检查并提示该配置是否就绪，不静默修改全局群消息策略，也不增加 Notifier 专用分发旁路。

电脑、Codex App 或目标 daemon 离线时，返回明确的离线错误，不创建待执行队列。

### 5.4 私聊模式

事件入队时若未配置 `targetChatId`，该事件就冻结为管理员私聊投递和接管语义。之后即使 Dashboard 改为群聊，已经入队的旧事件也不会改变目的地。这是配置缺省值，不是额外运行时兼容分支。

## 6. 配置与 Dashboard

在现有 `CodexNotifierGlobalConfig` 增加一个可选字段：

```ts
targetChatId?: string;
```

- 缺省：通知管理员私聊。
- 有值：通知指定群，并按 Codex 会话创建/复用话题。

Dashboard 的 Codex 通知设置增加“通知位置”：

- 管理员私聊；
- 目标通知 Bot 当前实际加入的群。

群选择器不复用 `allowedChatGroups`：后者是群聊入站授权，不代表 Bot 的实时群成员关系。设置进程通过现有带认证/HMAC 的 daemon IPC 向目标 Bot daemon 请求实时 `listChats` 结果；保存时再由该 daemon 执行 `isInChat` 校验。设置进程不复制目标 Bot 凭证，也不额外实例化另一个 Bot 客户端。

只允许从实时成员列表选择，不提供任意 `chatId` 输入。目标 daemon 离线时，可以显示当前配置及“暂不可验证”，但不能加载新候选或保存新的群目的地。切换通知 Bot 后，如果新 Bot 不是原目标群的成员，保存必须失败并要求重新选择，不能静默改投其他位置。界面同时显示目标 Bot 的 `regularGroupMentionMode` 是否为 `topic`；未就绪时给出明确警告，不自动修改。

### 6.1 入队时冻结目的地

现有 outbox 已在入队时冻结 `targetBotAppId`；本期把可选 `targetChatId` 一并写入每个 outbox item：

```ts
interface CodexNotifierOutboxTarget {
  targetBotAppId: string;
  targetChatId?: string;
}
```

daemon 投递时只使用事件携带的冻结目标，不读取当前 Dashboard 的 `targetChatId`。`targetChatId` 缺省明确表示该事件投管理员私聊，而不是“投递时再看当前配置”。配置变化只影响之后入队的新事件，避免排队期间切换群导致旧内容泄露到新群。

## 7. 组件与数据边界

### 7.1 现有组件保持职责

- Hook/Side Chat monitor：只负责产生完成事件。
- outbox worker：只负责把事件可靠交给入队时选定的 daemon。
- `CodexNotifierEventStore`：继续负责事件去重、投递状态和卡片来源凭证。
- Codex Desktop IPC：继续负责原生任务唯一写入者与输入转发。

新增 notifier 专用 `delivery.ts` 协调器：只负责根据事件的冻结目的地选择私聊、群根卡、群话题回复或告警降级，并在同一路由内串行发送。`daemon.ts` 只做依赖装配和接管胶水，不吸收路由、并发与降级状态机。

### 7.2 新增 `CodexNotifierTopicRouteStore`

新增一个小型、单一职责的本地投影，不把话题路由塞进事件账本：

```ts
interface CodexNotifierTopicRoute {
  threadId: string;
  chatId: string;
  rootMessageId: string;
  updatedAt: string;
}
```

能力仅包括：按 `threadId + chatId` 查询、绑定、在权威“根消息不存在/已撤回”错误时失效。每个目标 Bot 独立保存，文件权限 `0600`，原子写入，按最近更新时间最多保留 1000 条。淘汰只影响之后创建新话题，不影响 Codex 原生会话数据。

被淘汰路由对应的历史卡片不再允许接管，点击时明确提示“话题路由已过期，请等待该 Codex 会话的下一次完成通知创建新话题”，不能猜测锚点或退化为私聊接管。

路由文件与事件账本同处 `session.dataDir/plugin-events`，文件名包含目标 Bot App ID 的哈希，不保存机器人密钥、消息正文或 Codex 输出。

该 Store 保持 notifier 专用。事件账本按 event/turn 管生命周期，路由投影按 thread 管生命周期，不能混合；现有会议话题 Store 的键、失效和容量边界不同，本期不做无关的公共抽象或重构。

### 7.3 同会话串行化

`delivery.ts` 使用一个按 `${larkAppId}:${chatId}:${threadId}` 分组的轻量 Promise 门闩，串行执行“查询路由 → 发送根/回复 → 写入路由”。不同目的地或不同 Codex 会话并行投递。

不引入锁依赖或跨进程分布式锁，因为每个 Lark App ID 已由单 daemon 持有；跨进程事件仍先经过现有 daemon 单入口。

## 8. 完整数据流

```text
Codex 原生 turn 完成
  → 现有过滤、确认与 eventId 去重
  → outbox 同时冻结 targetBotAppId + targetChatId? 并交给目标 Bot daemon
  → daemon 只读取事件的冻结目的地
      ├─ targetChatId 缺省：沿用管理员私聊
      └─ targetChatId 有值：进入 chatId + threadId 串行门闩
          ├─ 无路由：向群发送首张完成卡 → 保存 rootMessageId
          └─ 有路由：回复 rootMessageId，replyInThread=true
  → EventStore 记录实际完成卡 messageId

点击任意可接管的非 Side Chat 完成卡
  → 校验管理员、eventId、实际 messageId
  → 由实际卡片群 + event.threadId 查询话题根路由并校验一致
  → 以可信 group/thread 目的地创建或复用 thread scope 绑定
  → Desktop owner/follower IPC 接管原 Codex App thread
  → 话题后续消息进入同一个 Codex thread
```

飞书发送继续使用 event UUID 作为幂等键。在正常运行、并发投递以及飞书当前 1 小时 UUID 幂等窗口内，首张根卡只创建一次；若首张卡已在飞书成功但进程在路由落盘前退出，窗口内重试可复用发送结果并补写路由。

飞书发送与本地路由落盘无法组成原子事务。极端情况下，如果上述崩溃后的恢复超过 1 小时，重试可能创建一个新的根卡；最新成功落盘的路由成为之后通知的唯一权威路由，旧孤儿话题只保留历史，不再接收通知。为这一低频窗口引入消息历史扫描、WAL、分布式事务或通用事务 outbox 不符合本期最小原则。若生产确实观察到该问题，再按 event ID 增加定向消息对账，这是明确的升级路径，而不是当前的虚假“恰好一次”承诺。

## 9. 失败语义

### 9.1 目标群投递失败

若向事件冻结的目标群发送或回复失败，给目标 Bot 管理员私聊发送一张**告警型降级卡**：只说明目标群投递失败；仅在现有能力支持时提供“打开 Codex App”，不提供“在飞书中继续处理”，避免形成第二条可写会话路径。

降级卡成功送达后，该事件视为已通知，避免 outbox 重试刷屏；群投递错误写日志与 Dashboard 健康摘要。下一次该 Codex 会话完成事件仍按它入队时冻结的目的地投递。

### 9.2 根消息失效

只有飞书明确返回“根消息不存在或已撤回”时才使该路由失效。本事件降级到管理员私聊，不在同一次处理里自动再建一个话题，以避免不确定发送结果造成重复。下一次完成事件会在目标群创建新的话题根。

网络超时、限流或未知错误不删除路由。

### 9.3 配置变化

切换 `targetChatId` 后，新入队事件使用新目的地，已经入队的事件仍投向各自冻结的旧目的地。路由查询同时匹配事件的 `chatId`，不会跨群复用。同一 Codex 会话在新目标群的首个新事件会创建新话题；旧话题保留历史，只有切换前已经冻结的在途事件仍可能进入其中。

## 10. 安全与隐私

- 选择群聊意味着完成卡内容对该群成员可见；Dashboard 保存前明确提示这一点。
- 只能选择目标 Bot 实时确认自己已加入的群，保存时再次校验成员关系；不能输入任意未知群 ID。`allowedChatGroups` 继续只控制入站群聊授权，不作为投递成员关系的替代证据。
- 卡片回调继续校验目标 Bot、事件账本中的精确 `messageId` 和管理员 `open_id`。
- 后续完成卡的来源校验使用事件账本中的实际卡片 ID；群接管还必须校验实际卡片群与路由群一致；接管锚点使用独立路由中的根消息 ID，三者不能混用。
- 路由文件不保存完成内容、用户输入、访问令牌或 App Secret。

## 11. Trae / 马仔二号边界

可以复用的是**飞书目的地与话题路由层**，不是当前整条 Codex 原生接管链。

- BotMux 已托管的 Trae 会话本来就具备飞书话题、续聊和稳定终态，不需要再经过本通知器。
- Trae CLI 与 Codex 同属相近协议族，但当前实现依赖 `~/.trae/cli` 的 SQLite、rollout 和受管 worker 终态；仓库里没有已验证的 Trae 全局完成 Hook，也没有与 Codex Desktop owner/follower IPC 等价的原生 App 控制协议。
- 因此本期不监听所有独立 Trae App/CLI 会话，不承诺“从飞书回到同一个 Trae App 会话”。强行共用会制造不可验证的兼容分支。
- 新话题路由组件不引用 Codex App Server 类型，只接收稳定的 `threadId/chatId/messageId`。以后 Trae 若提供可靠的完成事件和续聊原语，再基于真实需求复用其数据形态或提炼公共层；本期不为这个可能性增加空适配器、公共接口或配置项。

结论：优先完整交付 Codex 模式；马仔二号现有 BotMux 托管能力保持不变。

## 12. 测试与验收

### 12.1 单元/集成测试

1. 无 `targetChatId` 时仍向管理员私聊发送。
2. 首个事件向目标群发送根卡并持久化路由。
3. 同一 `threadId` 的后续事件回复同一根消息。
4. 不同 `threadId` 创建不同根消息。
5. 同一会话两个并发完成事件只创建一个根消息。
6. 在飞书 UUID 幂等窗口内，首卡发送成功但路由写入前重启可复用发送结果并补写路由；测试不宣称跨幂等窗口恰好一次。
7. daemon 重启后仍能从路由文件恢复并回复原话题。
8. 事件入队后切换目标群，旧事件仍投旧目的地，新事件投新目的地，且两组路由互不复用。
9. 点击首卡或后续普通卡都以同一根消息建立 group/thread scope 绑定，同时校验精确卡片来源与实际群；Side Chat 卡片仅展示结果且不能接管。
10. 非管理员、伪造事件、伪造卡片消息 ID 或卡片群与路由群不一致均拒绝。
11. 群投递失败时只发送无接管按钮的管理员私聊降级卡。
12. 权威根消息失效时删除路由；普通网络错误不删除。
13. 电脑/Codex App 离线时明确失败且不排队。
14. Dashboard 候选来自目标 daemon 的实时群成员列表，保存时再次验证；目标 daemon 离线或切换 Bot 后不满足成员关系时不能保存。
15. `regularGroupMentionMode = 'topic'` 时，已接管话题可不 `@` 续聊；群主时间线仍需 `@`，`@马仔二号` 时 Codex Bot 不抢答。

### 12.2 真机验收

1. 在 Codex App 新建会话并完成两轮 turn：马仔工作台只出现一个话题，两张卡按顺序位于其中。
2. 再建一个 Codex 会话：出现第二个独立话题。
3. 在第一话题点击任意普通完成卡并直接回复（无需再次 `@`）：消息进入第一 Codex App 会话，第二会话不受影响；Side Chat 卡片没有接管按钮。
4. 重启 BotMux 后再次完成第一会话：仍回复原话题。
5. 关闭 Codex App 后从话题发送消息：飞书明确提示离线，不排队；重新打开后由用户重发。
6. 暂时把目标 Bot 移出目标群：管理员私聊收到告警型降级卡，不能从该卡开启第二条飞书续聊路径。
7. 马仔二号的现有 Trae 托管会话收发不受影响。

## 13. 完成定义

- 上述聚焦测试、完整测试、类型检查、构建和 `git diff --check` 全部通过。
- Dashboard 可完成通知 Bot 与通知群的选择，无需用户记忆命令或 `chatId`。
- 真机验收至少覆盖两个 Codex 会话、同会话两轮通知、BotMux 重启、一次飞书接管和一次离线提示。
- `daemon.ts` 只保留装配和接管胶水；路由 Store 与投递协调器各自职责单一。
- 实现不新增第二套 daemon、消息总线、数据库、通用 Agent 通知框架、Trae 假适配器或与目标无关的重构。

# BotMux 语义进度卡插件设计

日期：2026-08-22
状态：最小插件 v2 已确认，进入实施计划

## 1. 背景与问题

BotMux 当前的 streaming card 本质上是远程终端控制卡：它围绕终端截图、显示切换、快捷键和整卡 `message.patch` 组织。对使用者而言，它只能说明 CLI 仍在运行，不能稳定回答“正在做什么、完成了哪些步骤、是否等待我输入”。这也是现有卡片比飞书原生任务体验更重、更像终端的根因。

本次目标机器人为：

- AI马仔：`cliId = codex-app`；
- 马仔二号：`cliId = traex`。

两条运行链路已经具备足够事实来源：

- Codex App Server 会产生 turn、command、file change、MCP、request user input 和 final 等结构化通知；其中当前 Runner 会自动用空答案结束 `requestUserInput`，首版不把它扩展为新的双向提问协议；
- TRAE 即使保持当前 tmux 模式、不启用实验性 RPC，其 rollout 也已实测包含 `task_started`、commentary、`exec_command_end`、`patch_apply_end`、`mcp_tool_call_end` 和 `task_complete`。

问题不在于飞书缺少一个百分比控件，而在于 BotMux 没有把 CLI 事实转换成统一的语义进度。CardKit 只是交付载体，不能代替事件建模。

## 2. 目标

1. Codex App 与 TRAE 使用同一套 A 款“语义时间线”卡片。
2. 每个实际执行单元只创建一张进度卡；排队后独立执行的 turn 各有一张卡，被 Codex App ordered steer 合并的补充消息继续更新同一张卡。
3. 完成时给原用户消息添加 `✅`，不额外发送“已完成”占位消息。
4. 进度卡失败不能影响 CLI；被插件接管的普通飞书 IM canonical final 必须可靠交付且不能重复。
5. 定制逻辑放在独立 BotMux 插件中，核心只增加窄、通用、可上游化的扩展点。
6. 组件与实现保持最小：优先复用现有插件、最终答复、reaction、去重和 latest-wins 机制，不建立第二套框架。

## 3. 非目标

- 不启用 TRAE 的实验性 `codexRpcInput`。
- 不接飞书任务智能体，不为普通聊天 turn 创建飞书任务。
- 不显示模型臆造的百分比或预计剩余时间。
- 不把 raw reasoning、stdout、stderr、工具 invocation/result 放进飞书卡片。
- 不重构 Workflow v3、设置卡、会话卡等其他业务卡片。
- 不让插件直接读取 BotMux App Secret，也不让插件绕开现有最终交付链路。
- 不增加旧版飞书客户端兼容分支；CardKit 2.0 是该插件的明确运行要求。
- 不新建独立 service、数据库、消息总线、通用 UI 框架或插件 SDK 包。
- 不在首版实现 Codex App `requestUserInput` 的 Runner→Worker→飞书→Runner 双向桥；该能力作为独立二期任务设计。
- 不接管 HTTP wait/async、文档评论、会议 receiver/listener、substitute turn 等特殊交付通道。
- 不拦截显式 `botmux send` 并改写其既有消息；严格“一张卡原地收尾”只适用于 canonical `final_output` 的普通飞书 IM turn。

## 4. 已确认的产品体验

### 4.1 运行态

卡片最多展示四个主要语义步骤：

- 已完成步骤使用完成态；
- 当前步骤突出显示，并允许一行经过清理的说明；
- 后续步骤只在有真实事件证据时出现；
- 低层操作折叠为“执行细节 N 条”，不直接展开终端日志。

进度卡在执行单元真正开始时创建，而不是在消息刚进入队列时抢先创建。普通进度按最新状态合并，最多每两秒更新一次；开始、已有 TUI prompt 的等待/恢复、完成、失败和取消属于状态边界，立即更新。

### 4.2 等待输入

当 Core 已经收到现有 `tui_prompt` 时，原进度卡切换为“等待你的输入”；具体问题和选项继续复用现有 TUI prompt 交互卡，`tui_prompt_resolved` 后原进度卡恢复执行中。

TRAE 现有 TUI prompt 路径属于首版范围。Codex App 当前对 `item/tool/requestUserInput` 直接返回空答案，没有可复用的飞书交互闭环，因此首版不宣称支持该场景；以后若实现双向桥，只新增 Core 事实来源，不改插件 reducer 与卡片结构。

### 4.3 终态

普通飞书 IM turn 成功时，原卡切换为 BotMux 现有 canonical final card 内容。最终 Markdown、反馈按钮、usage/footer 和安全清理继续由 Core 的现有构建链负责，插件不复制 Markdown 渲染器。失败或取消但没有 canonical final 时，插件只渲染对应终态摘要。

原卡最终写入成功后，Core 给该执行单元的 card-owning 用户消息添加 `✅`。卡片更新本身不被当作未读通知，因此 reaction 是无额外消息的完成提示。

## 5. 架构选择

### 5.1 为什么不能做成零 Core 修改

BotMux 现有插件贡献类型只有 Skill、MCP、CLI、Dashboard 和独立 service，没有“观察 turn 进度、接管同一张卡的开始/更新/终态”能力。若完全旁路 Core，插件只能重复扫描 transcript、自行持有机器人凭证、重新实现消息路由和最终去重。这会制造第二个不一致的 BotMux，而不是降低维护成本。

因此采用两层结构：

```text
BotMux Core（薄 SPI）
  ├── TurnProgressFact v1（只新增缺失事实）
  ├── turn-progress 插件贡献点
  ├── 极小 CardKit adapter + delivery host
  └── execution start / progress / final 短调用点
                │
                ▼
botmux-plugin-semantic-progress（独立仓库）
  ├── reducer.ts
  ├── card.ts
  └── turn-progress/index.ts
```

Core 只描述通用事实和交付能力，不包含 A 款布局、“AI马仔/马仔二号”名称或 Codex/TRAE 专属卡片分支。Codex/TRAE 的 provider 事件只在各自现有 reader/runner 中归一化一次；插件只消费统一事件并投影为具体产品体验，不再设置第二层 source mapper。

### 5.2 仓库与提交边界

Core 仍位于：

```text
/Users/bytedance/AiProjects/botmux
```

插件使用独立同级仓库：

```text
/Users/bytedance/AiProjects/botmux-plugin-semantic-progress
```

开发态安装方式：

```text
botmux plugin install ../botmux-plugin-semantic-progress --link
```

实现时至少拆为两个独立提交边界：

1. BotMux Core：只包含通用 turn-progress SPI、CardKit delivery host 与必要事件 tap，可单独评审并回馈上游；
2. 独立插件：包含所有语义投影、卡片组件和产品策略，不进入 BotMux 上游源码树。

插件通过现有按 Bot 绑定启用。AI马仔与马仔二号分别配置：

```json
{
  "plugins": ["semantic-progress"]
}
```

其他机器人不启用该插件，继续使用现有卡片链路。

## 6. Core 最小扩展

### 6.1 新贡献类型

沿用现有 convention scanner，新增一个固定贡献目录：

```text
turn-progress/index.js
```

`PluginContributions` 增加单数 `turnProgress`。

插件入口为受信任的进程内模块。入口导出 `schemaVersion: 1` 以及 `initialState`、`reduce`、`render` 三个函数，Core 在激活时做运行时校验。插件不 import `src/` 私有模块；协议采用小型结构化对象，插件内部自行声明对应 TypeScript 类型，不额外创建 SDK 包。

插件集合从现有 session plugin manifest 读取并冻结到当前 Worker generation，不能在同一执行单元中因 Dashboard 热切换而更换实现。同一个 Bot 同时只能启用一个 turn-progress 贡献；出现多个时明确报配置冲突，不定义插件优先级或组合规则。冲突或入口校验失败时 fail closed：记录可诊断错误并保留现有 streaming/final 链路，不能先压制旧卡再把本轮留成无卡状态。

### 6.2 Worker 新增事实与插件事件

Worker 新增的 IPC 只发送现有协议尚未表达的白名单事实：

```ts
type TurnProgressFactV1 = {
  schemaVersion: 1;
  seq: number;
  atMs: number;
  kind: 'turn_started' | 'narrative' | 'operation';
  text?: string;
  operation?: {
    id?: string;
    type: 'command' | 'file_change' | 'mcp' | 'other';
    phase: 'started' | 'completed';
    subjects?: string[];
    outcome?: 'succeeded' | 'failed' | 'cancelled';
  };
};
```

Daemon 在进入插件前补充并验证 session、turn、dispatch attempt、worker generation、CLI ID 和 locale 等权威上下文。插件不能通过事件 payload 改写路由身份。

Core 交给插件的 `TurnProgressEventV1` 由 `TurnProgressFactV1` 与现有事件共同组成：

- `turn_progress` IPC 提供 started、narrative、operation；
- `tui_prompt` / `tui_prompt_resolved` 提供 waiting/resumed；
- `steer_accepted` 不进入 reducer，只把该补充消息的 turn ID 绑定为当前执行单元的成员别名；
- `turn_terminal` 提供 completed/failed/cancelled/ambiguous 生命周期证据；failed/cancelled/ambiguous 在没有已开始的 final intent 时可冻结对应终态，completed 只有带 `outputDisposition = nothing_to_send` 或已有 `explicit_reply_observed` 时才证明“不会再有 canonical final”。裸 completed 可能只是 transcript hydration 先到，不能抢先清 binding；
- `final_output` 提供 canonical final delivery，不重新包装一份 terminal IPC。

因此 Worker 不重复发送 waiting 或 terminal，插件协议也不要求 provider reader 复制已有生命周期。

事件来源规则：

- Codex App：Runner 从 App Server 通知中发出事实 marker，Worker 转成同一 IPC 事件；
- TRAE：现有 rollout 增量读取在同一次 JSONL 扫描中额外产出事实，禁止建立第二个 reader/cursor；
- `agent_reasoning_raw_content` 永远忽略；
- command 不传原始命令与输出，只报告“执行命令”及成功/失败；
- file change 只允许工作目录内的相对路径，最多三个，其余折叠为数量；
- MCP 只允许稳定的工具名，不传 invocation/result；
- commentary 作为用户可见 narration，规范空白、移除控制字符、禁止原生 `<at>`，上限 240 个 Unicode 字符。

### 6.3 极小 CardKit adapter 与 delivery host

Lark client 只新增当前 SDK 已直接支持的两个薄适配器：

- `createCardEntity(cardJson) -> cardId`；
- `updateCardEntity(cardId, cardJson, sequence, uuid)`。

以 `card_id` 发送 interactive reply 复用现有 `sessionReply` 路由和稳定 IM UUID；完成 reaction 复用现有 `addReaction`。首版不封装 element update、batch update、CardKit DSL 或不存在的 card-content read。

Core 的 delivery host 只负责：单在途、latest pending snapshot、两秒普通节流、边界立即入队、单调 `sequence`、稳定 update UUID、callback marker 处理和最小 binding 持久化。插件只返回完整 CardKit 2.0 card JSON，不接触 Lark SDK client、tenant token、App Secret、计时器或磁盘。

Card binding 只保存以下交付元数据，不保存推理或终端内容：

- plugin ID；
- primary card-owning turn/attempt 身份，以及有界的 ordered-steer member turn ID 别名；
- card entity ID；
- Lark message ID；
- 最新成功 sequence；
- delivery state；
- 当前 update intent 的稳定 UUID、sequence 和 card hash。

持久化复用 BotMux 现有原子写、owner-only 权限和 session 生命周期设施，不在插件里复制一套 sidecar 安全库。

Binding 作为 Session 的一个可选字段保存，不新建 sidecar store。一个 session 同时只恢复一个实际执行单元的 active binding；完成后的卡片留在飞书，但清除本地 active binding。现有 `V3ProgressCardManager` 保持不动：这里只复用它验证过的不变量，不共享其 Workflow journal、run sidecar、文件锁或实现类。

### 6.4 Core 调用点

现有大文件只允许出现短调用点，复杂逻辑进入新模块：

1. 实际执行单元的 `turn_started` 到达后，若资格判断通过，创建进度卡；
2. Worker 的 `turn_progress` IPC 到达后，先做身份/序号校验，再调用插件纯 reducer/render；
3. 现有 `tui_prompt` / `tui_prompt_resolved` 分支向同一 reducer 投递 waiting/resumed；
4. 普通飞书 IM `final_output` 构建 canonical final card 后，请求 host 在原 card entity 完成交付；
5. 明确成功后才沿用现有 dedupe、feedback persistence、turn settlement 与 `✅` reaction；明确永久失败才走现有 stable-UUID fresh-message 路径；
6. `turn_terminal` 没有 canonical final 时，把 active 卡冻结为失败、取消或不明确终态；completed 仅在有 `nothing_to_send` 正证据时冻结为完成，已有 `explicit_reply_observed` 时显示“答复已通过独立消息发送”；裸 completed 保持“正在确认结果”，等待 final/recovery；
7. 被插件接管后不再创建或 patch 旧 streaming card；CardKit entity 创建明确失败时，本轮立即退回现有 `postTurnStartingCard`/最终答复链路，避免双卡或悬空卡。

统一的基础资格判断必须同时用于 start、progress 和 final：插件已在当前 session manifest 启用、普通飞书 IM、非 HTTP wait/async、非 doc comment、非 VC receiver/listener、非 substitute、非 managed/silent turn。Final 接管还要求不是 `suppressDelivery` 或 `steer_superseded`；前者由 `explicit_reply_observed`/terminal 将进度卡安全收口，后者继续等待同一 ordered-steer 执行单元的真实 final。特殊通道完全沿用旧链路。

不修改其他卡片 builder，不让插件分支散落到 `buildStreamingCard`。

## 7. 插件组件设计

插件 ID 为 `semantic-progress`。它只有一个具体产品，不建设可继承组件基类、依赖注入容器或通用渲染框架。

首版目录固定为：

```text
botmux-plugin-semantic-progress/
  package.json
  src/
    card.ts
    reducer.ts
    turn-progress/
      index.ts
  test/
    card.test.ts
    reducer.test.ts
```

构建产物为 `dist/turn-progress/index.js`，符合现有插件安装器只安装 `dist/` 的约束。`reducer.ts` 只实现纯状态转换，`card.ts` 内部使用小型纯函数组装 header、timeline、details 与 action。只有某个组件形成独立规则并需要独立测试时才拆文件；首版不创建 `sources/`、`components/`、`controller.ts` 或 `types.ts` 空壳。

插件入口只导出 `initialState`、`reduce` 和 `render`。两秒合并、CardKit sequence、持久化与 final 接管全部属于 Core delivery host，避免插件同时成为 UI 投影器和传输控制器。

## 8. 状态模型与数据流

插件内部 snapshot 状态为：

```text
starting → running ↔ waiting_input → succeeded
                         ├──────────→ failed
                         └──────────→ cancelled / ambiguous
```

规则：

- Reducer 是纯函数；小于等于当前 seq 的旧事件丢弃，同一 provider sequence 天然幂等；
- Core 在 reducer 前丢弃旧 worker generation、旧 turn 和错误 attempt；
- operation 以稳定 ID 合并 started/completed；没有 started 的 completed 可以生成一条已完成事实，兼容 TRAE 当前主要提供 end 事件的情况；
- 相邻同类操作折叠，时间线只保留四项，完整计数进入 details；
- narrative 只更新当前步骤说明，不覆盖 terminal；
- terminal 一旦成立即冻结，迟到 progress 不得把卡片退回 running；
- 不根据 operation 数量计算百分比，因为总步骤在执行前未知。

完整数据流：

```text
Codex App notifications / TRAE rollout
  → 各自现有 reader/runner 一次性白名单归一化
  → TurnProgressFact IPC
  → Core 权威身份校验
  → 现有 waiting/terminal 事件合流
  → semantic-progress pure reducer + card render
  → Core delivery host full-card latest-wins update
```

Codex App ordered steer 不创建第二张卡：现有 `steer_accepted` 将补充消息的 turn ID 加入当前 binding 的有界成员别名，后续 progress/terminal/final 命中任一成员都归入同一执行单元；`steer_superseded` 只结算成员，不冻结卡片。最终 `✅` 始终加在 primary card-owning 用户消息上。若消息排队后成为新的独立执行单元，则在其 `turn_started` 时创建下一张卡。

## 9. 最终交付与幂等

最终答案仍由现有 `final_output` 负责。插件不成为答案的唯一所有者。

交付顺序：

1. Core 按现有逻辑构建 canonical final card；
2. Core 将该卡和权威 turn 身份交给 turn-progress host；
3. Host 使用稳定 update UUID 与下一个 sequence 将原 card entity 全量更新为最终内容，并把 binding 保持为 `finalizing`；
4. 明确成功后返回现有 message ID，但此时不能抢先清 binding；
5. Core 记录 feedback delivery、提交 Codex App settlement/bridge dedupe，并给原用户消息添加 `✅`；这些既有权威步骤确认后才 ACK host 清除 active binding；
6. 若 CardKit 明确返回永久失败，则 Core 使用现有稳定 UUID 的 fresh-message 路径交付最终答案。

初始交付分为 CardKit entity create 与现有 IM reply 两步：Core 在 reply 前先持久化 `cardId` 与稳定 IM UUID。Create 响应不明确且拿不到 `cardId` 时不重试 create；该 entity 即使已在服务端产生也尚未挂到消息上，可以安全退回旧开始卡。Reply 结果不明确时只用同一 UUID 重试，不能重新 create entity；明确永久失败则放弃未挂载 entity 并回到现有开始卡/最终答复链路。这样即使网络在两步之间中断，也不会向用户发送两张进度卡。

遇到“服务端可能已接受、客户端未收到响应”时，Host 不立即 fresh-message fallback，而是保留同一 update intent，并用相同 `uuid + sequence` 重试原卡。只有明确永久失败才切换交付介质；这是在 CardKit 没有 card-content read 的前提下同时避免丢失与重复的必要约束。进程内重试保留 canonical card JSON；Daemon 重启后不从 hash 反推内容，而是依赖现有 `final_output` settlement/transcript replay 重新构建同一 canonical card，并复用已持久化的 intent 身份。

若 CardKit 进度卡从未创建成功，`final_output` 直接走现有路径。进度能力是可降级 UI，最终答复不是。

## 10. 错误处理与恢复

### 10.1 更新调度

- 每张卡同时最多一个更新请求；
- 在途期间只保留一个 latest pending snapshot；
- 普通进度两秒合并一次；
- 状态边界绕过普通节流，但仍进入同一串行队列；
- 中间进度更新失败只记录并等待下一次最新快照，不做无界重试；
- 终态暂时错误或响应不明确时持续保留同一 durable intent，以封顶退避间隔重试，直到明确成功、明确永久失败或 turn 失去权威；不更换 UUID/sequence，也不并行双发；明确永久失败后才回到 fresh final。
- 插件在首次 `initialState`/`render` 失败时回到旧开始卡；卡片已挂载后的 `reduce`/`render` 异常只隔离后续语义投影并记录诊断，不影响 CLI，也不丢掉由 Core 直接更新 canonical final 的能力。
- durable intent 必须先原子持久化再调用远端 update；若本地持久化失败则不得发出该远端请求。初始 create 后若 binding 无法持久化，未挂载 entity 直接放弃并回到旧链路。

### 10.2 权限与限流

AI马仔和马仔二号只需要本设计实际调用所要求的 `cardkit:card:write`；BotMux scope 清单已经包含它。首版不为了未调用的 card read 增加运行时依赖，也不再建设一套 preflight 框架；上线前通过现有权限检查确认应用已实际开通。首次 CardKit create 若明确返回权限错误，本轮直接沿用旧卡片/最终答复链路并记录可诊断错误。

CardKit 的 429 和暂时性 5xx 归类为可重试传输错误；4xx schema、权限、card withdrawn 和身份不匹配归类为永久错误。最终交付根据第 9 节处理。

### 10.3 Daemon 重启

Core 从最小 binding 恢复 card ID、message ID、sequence 和 turn 身份：

- TRAE 继续使用现有 rollout cursor/重放事实；
- Codex App 无法重放的中间 UI 不持久化，恢复后先显示“已恢复执行”，再接新事件；
- 终态 binding 永远不被恢复后的旧 progress 覆盖；
- 无法证明 binding 权威时，不重建或覆盖旧卡；现有 final settlement/replay 重新进入资格判断并选择可靠交付路径。

## 11. 代码克制与卫生

实现遵循以下硬约束：

1. 不因为“插件架构”建立第二套插件框架，直接扩展现有 convention scanner、effective plugin binding 和 runtime loader。
2. 不因为“组件化”创建继承树、通用 DSL 或虚拟 DOM；组件只是纯函数。
3. 不因一个调用写 wrapper；只有边界校验、复用或独立测试价值成立时才抽函数。
4. Core 大文件只留短 tap，逻辑放新模块；不在 switch 中堆 Codex/TRAE/CardKit 分支。
5. 复用 existing session plugin manifest、final card、reaction、dedupe、feedback、atomic persistence 和 IM UUID 语义。
6. 输入校验、幂等、安全、错误分类和最终交付不能为了少行数被删除。
7. 不加入“也许以后有用”的兼容层、feature matrix 或多插件组合协议。
8. 实现完成后按设计逐项 Review；发现设计与实现不一致时先修正实现，不能在编码过程中静默改变范围。

“一行能完成不要写一百行”被解释为选择最小、边界正确的实现，而不是压缩可读性或省略必要正确性。

## 12. 测试设计

### 12.1 Core 单元测试

- convention scanner 能发现并安装 `turn-progress/index.js`；session manifest 能冻结当前 generation 的贡献；
- 同一 Bot 多个 turn-progress 贡献明确冲突；
- 插件入口 schema、路径和导出校验 fail closed；
- CardKit adapter 的 create/update 参数、callback marker 与错误分类；
- delivery host 的单在途、latest-wins、sequence、稳定 UUID、撤回和 durable ambiguous retry；
- 旧 worker/turn/attempt 事件被丢弃；
- 统一资格判断覆盖普通 IM 与 HTTP/doc/VC/substitute/managed/suppressed/superseded 排除项；
- final plugin delivery 成功时不新发消息，明确永久失败时沿用稳定 UUID fallback，响应不明确时不得双发；
- final 成功后才加 `✅`，失败或未交付不误加。

### 12.2 插件单元测试

- reducer 的幂等、乱序、无 started completed、waiting/resume、terminal freeze；
- 四步时间线、折叠计数和各终态组件快照；
- 插件入口只导出约定的三个纯函数，卡片内容不含 raw reasoning、stdout、stderr、invocation/result。

### 12.3 集成与回归

- fake Codex App Server：一个实际执行单元只创建一张卡，ordered steer 复用同一张卡并最终原卡收尾；
- TRAE JSONL fixture：同一次增量扫描产出 task started、commentary、command/patch/MCP facts 与 final，不启用 RPC；
- Codex App `requestUserInput` 维持当前空答案行为，首版不伪造 waiting 支持；TRAE 现有 TUI prompt 能推进 waiting/resumed；
- CardKit 429、5xx、权限错误、撤回、超时和响应不明确；
- Daemon 重启后的 active/terminal binding 恢复；
- 现有 `card-builder`、`traex-transcript`、Codex App runner、`final_output`、feedback 与 reaction 测试无回归；
- `pnpm test`、相关集成测试和 `pnpm build` 全部通过。

### 12.4 飞书真机验收

分别用 AI马仔和马仔二号执行：

1. 简短纯回答；
2. 包含命令和文件修改的任务；
3. MCP 调用；
4. TRAE 等待用户输入并恢复；
5. 用户停止；
6. 执行失败；
7. 长最终答复；
8. Daemon 重启后继续。

普通 IM 每例确认：每个实际执行单元只有一张进度卡、步骤语义正确、无敏感内部输出、终态原卡正确、原消息有 `✅`、失败时答案不丢不重。另行验证 HTTP、文档评论、会议和显式 `botmux send` 仍走原路径且无回归。

## 13. 上线与回滚

1. 先合入并验证 Core SPI；未绑定插件时行为必须与当前版本完全一致。
2. 在独立仓库构建插件，通过 `--link` 安装。
3. 只给 AI马仔启用，完成自动与真机验证。
4. 再给马仔二号启用并验证 TRAE rollout 路径。
5. 稳定后将插件从 `--link` 切换为固定版本安装。

回滚只需从 Bot 配置移除 `semantic-progress` 或卸载插件；Core SPI 无插件时为 no-op，现有 streaming/final 链路继续工作。回滚不删除历史卡片和 session 数据。

## 14. 完成定义

以下条件同时成立才算完成：

- Core 只有通用、最小、可独立提交的扩展；
- 所有产品定制位于独立插件；
- 两个 Bot 均通过自动测试与真实飞书验收；
- 普通飞书 IM canonical final 在明确失败与模糊提交分支中不丢失、不重复；特殊交付通道保持现状；
- 未启用插件的 Bot 行为零变化；
- 代码 Review 未发现绕过现有正确性链路、重复基础设施或无必要抽象；
- 设计、实现、测试和部署配置一致。

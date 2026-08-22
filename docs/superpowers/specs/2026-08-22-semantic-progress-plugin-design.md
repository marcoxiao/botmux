# BotMux 语义进度卡插件设计

日期：2026-08-22
状态：已确认，等待书面审阅

## 1. 背景与问题

BotMux 当前的 streaming card 本质上是远程终端控制卡：它围绕终端截图、显示切换、快捷键和整卡 `message.patch` 组织。对使用者而言，它只能说明 CLI 仍在运行，不能稳定回答“正在做什么、完成了哪些步骤、是否等待我输入”。这也是现有卡片比飞书原生任务体验更重、更像终端的根因。

本次目标机器人为：

- AI马仔：`cliId = codex-app`；
- 马仔二号：`cliId = traex`。

两条运行链路已经具备足够事实来源：

- Codex App Server 会产生 turn、command、file change、MCP、request user input 和 final 等结构化通知；
- TRAE 即使保持当前 tmux 模式、不启用实验性 RPC，其 rollout 也已实测包含 `task_started`、commentary、`exec_command_end`、`patch_apply_end`、`mcp_tool_call_end` 和 `task_complete`。

问题不在于飞书缺少一个百分比控件，而在于 BotMux 没有把 CLI 事实转换成统一的语义进度。CardKit 只是交付载体，不能代替事件建模。

## 2. 目标

1. Codex App 与 TRAE 使用同一套 A 款“语义时间线”卡片。
2. 每个用户 turn 只创建一张进度卡；该卡从执行中、等待输入一直演进到最终答复。
3. 完成时给原用户消息添加 `✅`，不额外发送“已完成”占位消息。
4. 进度卡失败不能影响 CLI；最终答案必须可靠交付且不能重复。
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

## 4. 已确认的产品体验

### 4.1 运行态

卡片最多展示四个主要语义步骤：

- 已完成步骤使用完成态；
- 当前步骤突出显示，并允许一行经过清理的说明；
- 后续步骤只在有真实事件证据时出现；
- 低层操作折叠为“执行细节 N 条”，不直接展开终端日志。

普通进度按最新状态合并，最多每两秒更新一次。开始、等待输入、恢复、完成、失败和取消属于状态边界，立即更新。

### 4.2 等待输入

原进度卡切换为“等待你的输入”。具体问题和选项继续复用 BotMux 现有 ask/TUI prompt 交互卡；用户回答后，原进度卡恢复执行中。这样不复制一套问答回调协议。

### 4.3 终态

成功、失败或取消时，原卡切换为 BotMux 现有 canonical final card 内容。最终 Markdown、反馈按钮、usage/footer 和安全清理继续由 Core 的现有构建链负责，插件不复制 Markdown 渲染器。

原卡最终写入成功后，Core 给原用户消息添加 `✅`。卡片更新本身不被当作未读通知，因此 reaction 是无额外消息的完成提示。

## 5. 架构选择

### 5.1 为什么不能做成零 Core 修改

BotMux 现有插件贡献类型只有 Skill、MCP、CLI、Dashboard 和独立 service，没有“观察 turn 进度、接管同一张卡的开始/更新/终态”能力。若完全旁路 Core，插件只能重复扫描 transcript、自行持有机器人凭证、重新实现消息路由和最终去重。这会制造第二个不一致的 BotMux，而不是降低维护成本。

因此采用两层结构：

```text
BotMux Core（薄 SPI）
  ├── TurnProgressEvent v1
  ├── turn-progress 插件贡献点
  ├── CardKit Host 能力
  └── 少量 turn 接受 / progress / final 调用点
                │
                ▼
botmux-plugin-semantic-progress（独立仓库）
  ├── sources/
  ├── state/
  ├── components/
  └── controller/
```

Core 只描述通用事实和交付能力，不包含 A 款布局、“AI马仔/马仔二号”名称或 Codex/TRAE 专属卡片分支。插件负责将通用事实投影为具体产品体验。

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

1. BotMux Core：只包含通用 turn-progress SPI、CardKit Host 与必要事件 tap，可单独评审并回馈上游；
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

`PluginContributions` 增加单数 `turnProgress`。同一个 Bot 同时只能启用一个 turn-progress 贡献；出现多个时明确报配置冲突，不定义插件优先级或组合规则。该约束避免无意义的插件编排框架。

插件入口为受信任的进程内模块。入口导出 `schemaVersion: 1` 的结构对象，Core 在激活时做运行时校验。插件不 import `src/` 私有模块；协议采用小型结构化对象，插件内部自行声明对应 TypeScript 类型，不额外创建 SDK 包。

### 6.2 TurnProgressEvent v1

Worker 只向 Daemon 发送经过白名单化的事实：

```ts
type TurnProgressEventV1 = {
  schemaVersion: 1;
  id: string;
  seq: number;
  atMs: number;
  kind:
    | 'turn_started'
    | 'narrative'
    | 'operation_started'
    | 'operation_completed'
    | 'waiting_input'
    | 'turn_terminal';
  operation?: {
    id?: string;
    type: 'command' | 'file_change' | 'mcp' | 'other';
    label: string;
    outcome?: 'succeeded' | 'failed' | 'cancelled';
  };
  text?: string;
  terminal?: 'succeeded' | 'failed' | 'cancelled' | 'ambiguous';
};
```

Daemon 在进入插件前补充并验证 session、turn、dispatch attempt、worker generation、CLI ID 和工作目录等权威上下文。插件不能通过事件 payload 改写路由身份。

事件来源规则：

- Codex App：Runner 从 App Server 通知中发出事实 marker，Worker 转成同一 IPC 事件；
- TRAE：现有 rollout 增量读取在同一次 JSONL 扫描中额外产出事实，禁止建立第二个 reader/cursor；
- `agent_reasoning_raw_content` 永远忽略；
- command 不传原始命令与输出，只报告“执行命令”及成功/失败；
- file change 只允许工作目录内的相对路径，最多三个，其余折叠为数量；
- MCP 只允许稳定的工具名，不传 invocation/result；
- commentary 作为用户可见 narration，规范空白、移除控制字符、禁止原生 `<at>`，上限 240 个 Unicode 字符。

### 6.3 CardKit Host

Core 新增一个集中模块承载 CardKit 通用能力：

- 创建 CardKit card entity；
- 以 `card_id` 发送 interactive message；
- 串行执行 element/batch update；
- 维护单调 `sequence`；
- 读取卡片用于不明确响应后的交付确认；
- 添加 reaction；
- 持久化最小 card binding。

插件只提交“期望卡片模型”或稳定 element 更新，不接触 Lark SDK client、tenant token 或 App Secret。Host 负责 callback marker、安全校验、限流错误分类和消息撤回语义。

Card binding 只保存以下交付元数据，不保存推理或终端内容：

- plugin ID；
- session/turn/attempt 身份；
- card entity ID；
- Lark message ID；
- 最新成功 sequence；
- delivery state；
- 最新 card hash。

持久化复用 BotMux 现有原子写、owner-only 权限和 session 生命周期设施，不在插件里复制一套 sidecar 安全库。

现有 `V3ProgressCardManager` 保持不动：它绑定 Workflow journal、run sidecar、跨进程文件锁和整卡 PATCH，生命周期与普通聊天 turn 不同。这里复用它已经验证的“发送前意图、单在途、latest-wins、终态冻结”不变量，但不为表面复用把两套业务强行泛化成一个大 manager。CardKit Host 只实现当前需要的具体串行闭包。

### 6.4 Core 调用点

现有大文件只允许出现短调用点，复杂逻辑进入新模块：

1. turn 被接受后，询问已绑定 turn-progress 插件是否创建进度卡；
2. Worker 的 `turn_progress` IPC 到达后，交给统一 host 校验并投递；
3. ask/TUI prompt 开始和结束时发送 waiting/resumed 边界；
4. `final_output` 构建 canonical final card 后，先请求插件在原卡完成交付；
5. 插件返回已确认交付后，沿用现有 dedupe、feedback persistence、turn settlement 与 reaction；否则继续执行原有 fresh-message 最终链路。

不修改其他卡片 builder，不让插件分支散落到 `buildStreamingCard`。

## 7. 插件组件设计

插件 ID 为 `semantic-progress`。它只有一个具体产品，不建设可继承组件基类、依赖注入容器或通用渲染框架。

建议目录：

```text
botmux-plugin-semantic-progress/
  package.json
  turn-progress/
    index.js
  src/
    sources/
      codex-app.ts
      traex.ts
    state/
      reducer.ts
      types.ts
    components/
      status-header.ts
      semantic-timeline.ts
      collapsed-details.ts
      turn-actions.ts
      usage-footer.ts
    card.ts
    controller.ts
  test/
```

每个组件是一个小型纯函数：输入只读 view model，输出 CardKit 2.0 element。`card.ts` 组合这些函数。只有当一个组件确实存在独立规则和独立测试价值时才拆文件；一行映射留在调用处，不为对称而建空壳。

`controller.ts` 只负责：

- 选择对应 source mapper；
- 调用 reducer；
- 合并两秒内的普通更新；
- 在状态边界立即 render；
- 把期望卡片交给 Host；
- 终态后冻结并释放内存状态。

不在 controller 中实现 Lark HTTP、文件持久化、最终答案格式化或 session 路由。

## 8. 状态模型与数据流

插件内部 snapshot 状态为：

```text
starting → running ↔ waiting_input → succeeded
                         ├──────────→ failed
                         └──────────→ cancelled / ambiguous
```

规则：

- Reducer 是纯函数；相同事件 ID 幂等；小于等于当前 seq 的旧事件丢弃；
- Core 在 reducer 前丢弃旧 worker generation、旧 turn 和错误 attempt；
- operation 以稳定 ID 合并 started/completed；没有 started 的 completed 可以生成一条已完成事实，兼容 TRAE 当前主要提供 end 事件的情况；
- 相邻同类操作折叠，时间线只保留四项，完整计数进入 details；
- narrative 只更新当前步骤说明，不覆盖 terminal；
- terminal 一旦成立即冻结，迟到 progress 不得把卡片退回 running；
- 不根据 operation 数量计算百分比，因为总步骤在执行前未知。

完整数据流：

```text
Codex App notifications / TRAE rollout
  → Worker 白名单事实
  → TurnProgressEvent IPC
  → Core 权威身份校验
  → semantic-progress source mapper
  → pure reducer
  → A 款组件树
  → CardKit Host latest-wins update
```

## 9. 最终交付与幂等

最终答案仍由现有 `final_output` 负责。插件不成为答案的唯一所有者。

交付顺序：

1. Core 按现有逻辑构建 canonical final card；
2. Core 将该卡和权威 turn 身份交给 turn-progress host；
3. Host/插件尝试将原 card entity 更新为最终内容；
4. 明确成功后返回现有 message ID；
5. Core 才记录 feedback delivery、提交 Codex App settlement/bridge dedupe，并给原用户消息添加 `✅`；
6. 若失败或无法确认，则 Core 使用现有稳定 UUID 的 fresh-message 路径交付最终答案。

遇到“服务端可能已接受、客户端未收到响应”时，Host 先通过 card read 校验 turn marker/card hash；只有确认未落地才允许 fresh-message fallback。这样同时满足“答案不能丢”和“答案不能重复”。

若 CardKit 进度卡从未创建成功，`final_output` 直接走现有路径。进度能力是可降级 UI，最终答复不是。

## 10. 错误处理与恢复

### 10.1 更新调度

- 每张卡同时最多一个更新请求；
- 在途期间只保留一个 latest pending snapshot；
- 普通进度两秒合并一次；
- 状态边界绕过普通节流，但仍进入同一串行队列；
- 中间进度更新失败只记录并等待下一次最新快照，不做无界重试；
- 终态使用现有有限重试预算，失败后回到 fresh final。

### 10.2 权限与限流

AI马仔和马仔二号分别需要 `cardkit:card:read` 与 `cardkit:card:write`。首次启用前做显式 preflight；权限不足时插件对该 Bot 标记不可用，并让 Core 继续现有卡片/最终答复链路，不把失败伪装成新卡片成功。

CardKit 的 429 和暂时性 5xx 归类为可重试传输错误；4xx schema、权限、card withdrawn 和身份不匹配归类为永久错误。最终交付根据第 9 节处理。

### 10.3 Daemon 重启

Core 从最小 binding 恢复 card ID、message ID、sequence 和 turn 身份：

- TRAE 继续使用现有 rollout cursor/重放事实；
- Codex App 无法重放的中间 UI 不持久化，恢复后先显示“已恢复执行”，再接新事件；
- 终态 binding 永远不被恢复后的旧 progress 覆盖；
- 无法证明 binding 权威时，不重建或覆盖旧卡，最终答复走可靠 fallback。

## 11. 代码克制与卫生

实现遵循以下硬约束：

1. 不因为“插件架构”建立第二套插件框架，直接扩展现有 convention scanner、effective plugin binding 和 runtime loader。
2. 不因为“组件化”创建继承树、通用 DSL 或虚拟 DOM；组件只是纯函数。
3. 不因一个调用写 wrapper；只有边界校验、复用或独立测试价值成立时才抽函数。
4. Core 大文件只留短 tap，逻辑放新模块；不在 switch 中堆 Codex/TRAE/CardKit 分支。
5. 复用 existing final card、reaction、dedupe、feedback、atomic persistence 和 latest-wins 语义。
6. 输入校验、幂等、安全、错误分类和最终交付不能为了少行数被删除。
7. 不加入“也许以后有用”的兼容层、feature matrix 或多插件组合协议。
8. 实现完成后按设计逐项 Review；发现设计与实现不一致时先修正实现，不能在编码过程中静默改变范围。

“一行能完成不要写一百行”被解释为选择最小、边界正确的实现，而不是压缩可读性或省略必要正确性。

## 12. 测试设计

### 12.1 Core 单元测试

- convention scanner 能发现、安装和 materialize `turn-progress/index.js`；
- 同一 Bot 多个 turn-progress 贡献明确冲突；
- 插件入口 schema、路径和导出校验 fail closed；
- CardKit Host create/send/update/read/react 参数与权限错误分类；
- 单在途、latest-wins、sequence、撤回和不明确响应确认；
- 旧 worker/turn/attempt 事件被丢弃；
- final plugin delivery 成功时不新发消息，失败时沿用稳定 UUID fallback；
- final 成功后才加 `✅`，失败或未交付不误加。

### 12.2 插件单元测试

- Codex App observation 到统一事件的映射；
- TRAE `task_started`、commentary、command end、patch end、MCP end、task complete 映射；
- raw reasoning、stdout、stderr、invocation/result 永不进入 view；
- commentary、相对路径和工具名的清理与长度上限；
- reducer 的幂等、乱序、无 started completed、waiting/resume、terminal freeze；
- 四步时间线、折叠计数和各终态组件快照；
- 两秒合并与边界立即刷新。

### 12.3 集成与回归

- fake Codex App Server：一个 turn 只创建一张卡，并最终原卡收尾；
- TRAE JSONL fixture：不启用 RPC 也能产生同构时间线并完成；
- CardKit 429、5xx、权限错误、撤回、超时和响应不明确；
- Daemon 重启后的 active/terminal binding 恢复；
- 现有 `card-builder`、`traex-transcript`、Codex App runner、`final_output`、feedback 与 reaction 测试无回归；
- `pnpm test`、相关集成测试和 `pnpm build` 全部通过。

### 12.4 飞书真机验收

分别用 AI马仔和马仔二号执行：

1. 简短纯回答；
2. 包含命令和文件修改的任务；
3. MCP 调用；
4. 等待用户输入并恢复；
5. 用户停止；
6. 执行失败；
7. 长最终答复；
8. Daemon 重启后继续。

每例确认：只有一张进度卡、步骤语义正确、无敏感内部输出、终态原卡正确、原消息有 `✅`、失败时答案不丢不重。

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
- 最终答案在所有故障分支中不丢失、不重复；
- 未启用插件的 Bot 行为零变化；
- 代码 Review 未发现绕过现有正确性链路、重复基础设施或无必要抽象；
- 设计、实现、测试和部署配置一致。

# Desktop Handoff 薄插件设计

状态：已实现，待真实双端验收

日期：2026-08-23

## 1. 结论

本地 Codex Desktop 双端协同采用“一个通用 Core 消息认领点 + 一个独立插件”：

- BotMux Core 继续持有唯一飞书连接、身份权限、消息去重和 CardKit Host。
- `botmux-plugin-desktop-handoff` 负责 Desktop Hook、话题 route、显式接管和 Desktop owner/follower IPC。
- 飞书文本通过当前 Desktop owner 写入同一个 native thread；结果由 Desktop Hook 回到同一飞书根话题。
- Desktop/原任务离线时本条失败，不排队、不创建替代 Session。

BotMux 上游 Shared Adopt 保留且不修改，但它只适用于已有可访问的 WebSocket App Server endpoint。当前本机 Codex/Traex App 以 `app-server --listen stdio://` 运行，没有 `--remote` 可连接 endpoint，因此不能用 Shared Adopt 代替本地 Desktop IPC。

## 2. 目标与非目标

### 必须满足

1. Desktop 主任务完成后，在配置的工作台群发送或复用一个 CardKit 根话题。
2. 一个 Desktop thread 只绑定一个飞书根消息。
3. 只有 owner 点击根卡“飞书接管”且 Desktop 仍持有该 thread 时才接管成功。
4. 接管后回复该话题，文本进入同一个 Desktop thread。
5. Desktop 完成后，结果通过同一根话题的 CardKit 回复展示。
6. 离线明确失败；不排队、不新建替代会话。
7. 插件独立安装、启停、升级；Core 不出现 Codex IPC 或 route 业务代码。

### 明确不做

- 不自动接管全部 Desktop 会话，不回灌完整历史。
- 不启动第二个 App Server，不维护影子 BotMux Session。
- 本期只闭环文本 turn；不伪装支持图片、文件、审批或 token 级流式事件。
- 不修改或兼容上游 Shared Adopt 内部实现。
- Traex 在验证其 Desktop IPC 与 Codex 协议一致前不启用同一 provider。

## 3. 第一性原理与拓扑选择

“写回同一 Desktop 会话”的必要条件是：写入由当前 Desktop owner 接受，目标使用原生 `conversationId`。

```text
本机当前拓扑
Codex App ── stdio:// App Server ── native thread
    ▲
    └── local owner/follower IPC（可写同一 thread）

上游 Shared Adopt 适用拓扑
Codex App ── ws:// App Server ── native thread
                    ▲
                    └── codex --remote resume
```

两个拓扑不能混用：`stdio://` 没有 remote endpoint；强行走 Shared Adopt 只会稳定报离线。系统只保留两个状态真相：Desktop 是 thread/turn 真相源；插件账本只保存 `threadId ↔ 飞书根消息` 与显式接管状态。BotMux SessionStore 不参与本地 Desktop 路由。

## 4. 架构与边界

```text
Codex Desktop Hook
        │ UserPromptSubmit / Stop
        ▼
desktop-handoff 插件
  ├─ 最小 event/route 账本
  ├─ CardKit 根卡与结果回复
  ├─ 显式接管状态
  └─ Desktop owner/follower IPC
        ▲
        │ 已认领话题文本
BotMux 通用 Lark 插件入口
        ▲
        │ 原生身份、权限、去重
飞书话题
```

### Core 只负责

- 加载已启用插件并提供 CardKit、owner、配置和打开 App 的窄 Host。
- 对通过原生人类身份、talk 权限、去重和真实 `root_id + thread_id` 校验的消息，给插件一次认领机会。
- 首个 `{ handled: true }` 终止原生 Session 创建；全部 false 时原逻辑不变。

### 插件负责

- 识别 Desktop 主任务 Hook，保存最小原子账本。
- 创建 CardKit 根话题并验证按钮根消息/owner。
- 接管时发现当前 thread owner；成功后才标记 route。
- 对已接管话题执行一次 follower turn，并将飞书 `messageId` 作为原生幂等 ID。
- 已知插件根话题始终 fail-closed，异常绝不回落为 BotMux Session。

### 禁止进入 Core

- Desktop socket 路径、帧协议、Codex IPC 方法名。
- Desktop thread/turn 状态、插件 route、离线重试队列。
- Codex/Traex provider 条件分支。

## 5. 最小 Core 协议

```ts
interface LarkPluginMessageContext {
  larkAppId: string;
  chatId: string;
  messageId: string;
  rootMessageId: string;
  senderOpenId: string;
  text: string;
}

interface LarkPluginV1 {
  handleMessage?(
    context: LarkPluginMessageContext,
    host: LarkPluginHost,
  ): Promise<{ handled: boolean }>;
}
```

调用前置条件由 Core 固定：真实人类、talkAllowed、真实话题回复、现有消息去重、复用现有文本提取与前导 @ 清理。插件仍校验 owner 和自身根 route。

消息认领 fail-closed：根消息命中插件账本后，即使未接管、非 owner、空文本、IPC 离线或 provider 抛错，也返回 `handled: true`；只有根消息不属于插件才返回 false。

## 6. 关键流程

### 完成通知

1. Hook 经本机签名入口投递给启用插件。
2. 插件只接受主任务的 `UserPromptSubmit/Stop`，按 thread/turn 去重。
3. 首次完成发送根 CardKit；后续完成通过 `reply_in_thread=true` 回复同一根。
4. 根卡撤回后清理旧 route，下次完成重建根卡。

### 显式接管

1. owner 点击根卡“飞书接管”。
2. Core 校验 action 命名空间、操作者与真实卡片消息 ID。
3. 插件从账本恢复可信 threadId，执行 `thread-owner-discovery`。
4. owner 存在才写入 `adoptedAt`；失败返回离线 CardKit，不创建 Session。

### 飞书写回同一 thread

1. owner 在已接管根话题发送文本。
2. Core 调用插件 `handleMessage`。
3. 插件按根消息找到 route，再次发现当前 Desktop owner。
4. 插件调用 `thread-follower-start-turn`，目标 threadId 来自账本，`clientUserMessageId` 使用飞书 messageId。
5. Desktop 离线时回复错误卡，不排队、不 fallback。

## 7. 一致性与安全

- 账本临时文件 + 原子替换；event 清理不删除仍有效 route。
- 根卡稳定 UUID 抑制崩溃窗口重复发送。
- forwarded/copied CardKit 因 `open_message_id` 不匹配账本根卡而拒绝。
- 非 owner 即使拥有群聊权限也不能接管或写入 Desktop。
- IPC 固定本机 Codex socket，不接受飞书 payload 提供路径、threadId 或命令。
- socket 必须是同 UID 的 Unix socket；单帧 64 MiB；请求超时 5 秒；连接/关闭/无 owner 统一映射为离线。
- 不记录飞书正文、凭证、socket 数据或完整 thread 标识。

## 8. CardKit 用户体验

- 未接管：完成摘要、“飞书接管”、“打开 Codex App”。
- 已接管：提示回复本话题会进入同一个 Desktop 任务。
- 成功送达不刷屏；最终结果回同一话题。
- 离线只说明打开原任务后重发，不暴露内部协议或堆栈。
- 手机端与桌面端共用同一根卡/话题，不要求记命令。

本期闭环按 turn 粒度定义，不承诺 token/item 级实时流。

## 9. 飞书 CLI 与 Traex

飞书 CLI 只用于安装、自检和验收，不进入实时链路；运行时复用 BotMux 的飞书长连接和凭证。

CardKit 与 Core 消息认领可复用于 Traex。Desktop IPC provider 只有在实测 Traex 提供相同 owner/follower 协议后才启用；否则 Traex 继续使用 BotMux 原生 CLI/Shared Adopt 能力，不在 Codex 路径塞兼容分支。

## 10. 验收

### 自动化

- 未实现 `handleMessage` 的插件不受影响。
- 非真实话题、未授权用户、未启用插件不分发。
- 已知根的非 owner、未接管、空文本、离线全部 fail-closed。
- Desktop owner 探测成功后才接管。
- follower 请求使用账本 threadId 与飞书 messageId。
- CardKit 2.0、根锚点复用、账本生命周期、构建通过。
- 上游 Shared Adopt、普通 Session、关闭语义回归不受影响。

### 真实双端

1. Desktop 完成任务，工作台出现根 CardKit。
2. 点击接管，卡片显示已接管。
3. 话题发送唯一文本，原 Desktop thread 出现同一用户 turn。
4. Desktop 回复后，同一话题出现结果卡。
5. 关闭原任务后发送，飞书明确离线且无新 Session。
6. 普通 BotMux 话题、Semantic Progress、Web Terminal、审批不受影响。

## 11. 合并卫生

- 独立插件承载全部 Desktop 业务代码。
- Core 只增加通用协议、dispatcher 和原生事件入口的一个调用点。
- 不修改 worker、worker-pool、SessionStore 或 runner。
- 最新 `upstream/master` 已合入；每次升级运行插件路由、Shared Adopt 和构建回归。

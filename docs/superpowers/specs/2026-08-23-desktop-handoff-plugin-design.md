# Desktop Handoff 薄插件设计

状态：已修订，待最终确认

日期：2026-08-23
替代：本文件此前由插件直接接管 Desktop IPC 的方案

## 1. 结论

Desktop 双端协同采用两层结构：

- `botmux-plugin-desktop-handoff` 是独立安装的薄插件，只负责完成通知、CardKit 接管入口、接管目标和事件去重。
- BotMux 上游原生 Shared Adopt 负责会话连接、消息收发、审批、终端、生命周期和重启恢复。

插件不实现第二套 Codex 会话协议，不代理飞书后续消息，也不修改 Worker/Session 的业务分支。

上游已经具备官方共享接管路径：

```text
codex --remote <existing-app-server-endpoint> resume <thread-id>
```

其设计见 [codex-app-shared-adopt.md](../../design/codex-app-shared-adopt.md)。该路径连接同一个 App Server 和同一个 Desktop thread，是本方案唯一的数据面。

## 2. 用户目标

### 必须满足

1. Codex App 中发起的任务完成后，飞书“马仔工作台”收到一张 CardKit 通知卡片。
2. 每个 Desktop thread 对应一个飞书话题，避免所有会话堆在机器人私聊主时间线。
3. 用户明确点击“飞书接管”后，话题绑定同一个 Desktop thread。
4. 接管后从飞书发送的消息必须进入原 Desktop thread；Desktop 继续输入时，飞书也能看到后续进度和结果。
5. 原任务关闭或电脑离线时明确提示，不排队，不静默新建会话。
6. 保留 BotMux 原生的会话卡片、CardKit、审批、Web Terminal、恢复和关闭能力。
7. 插件可独立安装、启停和升级；同步 BotMux 上游时不需要反复解决 Worker/Session 冲突。

### 本期不做

- 不自动接管所有 Desktop 会话。
- 不同步接管前的完整历史，只从接管后的实时流开始。
- 不为失效 Desktop thread 自动创建替代会话。
- 不保留旧私有 IPC follower 的兼容分支。
- 不在未验证协议的情况下宣称支持 Traex 同会话接管。

## 3. 第一性原理

双端协同只有两个不可混淆的问题：

1. **控制面**：发现任务完成、通知用户、收集显式接管意图。
2. **数据面**：保证两端读写的是同一个会话对象，并由一个权威生命周期管理器维护。

BotMux 上游 Shared Adopt 已经解决数据面。插件再实现 IPC follower、消息路由和恢复状态，会产生两个会话真相源，也是此前“能通知但承接失败、重启后漂移”的根因类别。

因此本方案只补控制面，不复制数据面。

## 4. 总体架构

```text
Codex Desktop Hook
        │ 完成事件（本机）
        ▼
desktop-handoff 插件
  ├─ 事件去重/最小账本
  ├─ 创建或更新 CardKit 通知
  └─ 处理“飞书接管”按钮
        │ 调用受限 Host API
        ▼
BotMux 原生 Shared Adopt
  ├─ Session / Worker / SessionStore
  ├─ codex --remote ... resume ...
  ├─ 飞书消息与审批
  └─ Semantic Progress / Web Terminal
        │
        ▼
同一个 Codex App Server + 同一个 Desktop thread
```

接管成功后，飞书话题到 Session 的映射由 BotMux 原生会话系统持有。插件不再参与普通消息收发。

## 5. 责任边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| Desktop Handoff 插件 | Hook 事件、去重、通知卡、接管按钮、目标群/话题配置 | Codex 协议、普通消息路由、Worker 恢复 |
| BotMux Core | 飞书连接、认证、Session、Worker、Shared Adopt、审批、终端、关闭和恢复 | Desktop 完成通知的产品策略 |
| Semantic Progress 插件 | 接管后任务进度与结果的 CardKit 表达 | Desktop thread 发现与接管 |
| Codex App Server | thread、turn、item 的顺序和会话真相 | 飞书产品交互 |

禁区：Desktop Handoff 不得在 `worker.ts`、`worker-pool.ts`、`session-manager.ts` 或 `command-handler.ts` 中添加插件专用条件分支。

## 6. 最小 Core 扩展

现有插件框架已支持 Dashboard、Service、CLI、MCP 和 Turn Progress，但缺少本地事件与飞书卡片动作的通用扩展点。只新增一类通用贡献，不新增“Codex 专用插件框架”。

建议约定目录：

```text
lark/index.js
```

贡献接口只包含：

```ts
interface LarkContribution {
  actions: string[];
  handleLocalEvent?(event: PluginLocalEvent, host: LarkPluginHost): Promise<void>;
  handleCardAction?(action: PluginCardAction, host: LarkPluginHost): Promise<void>;
}
```

Host API 保持窄边界：

- `sendCard` / `updateCard`：复用 BotMux 当前飞书身份和 CardKit 客户端。
- `sharedAdopt`：调用上游原生 Shared Adopt 服务。
- `findSharedAdopt`：只读查询，防止重复通知或重复接管。
- 可信的 bot、chat、topic、operator 上下文。

Core 必须校验 action ID 唯一性、插件启用状态、事件体大小和调用身份。插件收到的按钮 payload 只含不可猜测的事件 ID，不直接信任客户端传入的 endpoint、thread ID 或命令。

本地 Hook 通过一个通用、有限输入的入口投递事件，例如：

```text
botmux plugin event desktop-handoff
```

JSON 从 stdin 读取并限制大小。它只分发给已启用插件，不开放任意模块或命令执行。

不增加以下能力：

- `handleMessage`；普通飞书消息由原生 Session 处理。
- 插件自己的 route claim 表；接管成功后原生 Session 就是路由真相。
- 私有 Codex IPC Host API；插件只能请求原生 Shared Adopt。

## 7. 独立插件包

插件放在独立仓库，布局与 Semantic Progress 一致：

```text
/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff/
├── package.json
├── lark/index.js
├── dashboard/index.js
└── src/
    ├── event-store.ts
    ├── cards.ts
    └── providers/codex.ts
```

通过链接模式开发：

```text
botmux plugin install ../botmux-plugin-desktop-handoff --link
```

插件包不复制 BotMux 的 Lark SDK、SessionStore 或 Codex runner。Dashboard 只承载必要配置：启用 Bot、目标工作台群和通知策略。

## 8. 关键流程

### 8.1 完成通知

1. Codex Hook 写入受限本地事件入口。
2. 插件按 `provider + threadId + completionId` 去重。
3. 若该 thread 已有活跃 Shared Adopt，避免重复发送“接管”通知；正常进度由 Session/CardKit 展示。
4. 否则在配置的工作台群中，为该 Desktop thread 创建或更新一个话题根卡片。
5. 插件账本只保存通知事件、卡片消息和话题定位，不保存会话运行态。

### 8.2 显式接管

1. 用户点击“飞书接管”。
2. Core 校验操作者、Bot、插件状态和 action ID。
3. 插件用事件 ID 从本地账本取回可信的 thread/endpoint 元数据。
4. 插件调用 `host.sharedAdopt(...)`。
5. 只有原生 Session 和 remote Worker 已成功建立后，卡片才更新为“已接管”。
6. 重复点击返回现有接管状态，不创建第二个 Session。
7. 失败时显示可重试原因；离线不排队，也不创建新会话。

### 8.3 接管后双向流转

- 飞书话题消息由 BotMux 原生路由进入 Shared Adopt Session。
- remote Codex client 将消息写入原 Desktop thread。
- Desktop 产生的新 turn 由同一 remote client 返回 BotMux。
- BotMux 原生 Worker 和 Semantic Progress 负责 CardKit 更新、审批与最终结果。
- 用户关闭飞书接管时，只 detach BotMux remote client，不停止源 App Server。

## 9. 生命周期与一致性

- 会话真相源：BotMux `SessionStore` + Codex App Server。
- 插件账本：仅用于通知幂等和卡片定位，可重建，不参与 turn 顺序。
- BotMux daemon 重启：沿用上游 Shared Adopt 恢复逻辑。
- 插件禁用/卸载：停止新通知和新接管；已经接管的原生 Session 继续安全运行，直至用户关闭。
- Desktop/App Server 离线：本次飞书消息失败并明确提示，不排队。
- 源 thread 被删除或不可恢复：不静默 fallback 到新 thread。

## 10. CardKit 与用户体验

- 未接管：一张完成通知卡，主操作只有“飞书接管”，次操作可“打开 Codex App”。
- 接管中：按钮禁用，显示连接状态，避免重复触发。
- 已接管：卡片显示绑定成功；后续交互进入同一话题。
- 执行中：继续复用 Semantic Progress 的统一 CardKit，不再生成另一套任务卡。
- 离线/失效：给出直接原因和“重新接管”，不展示内部 endpoint、命令或堆栈。
- 手机端与桌面端使用同一话题和同一按钮流程，不要求用户记命令。

## 11. Codex 与 Traex

P0 只承诺 Codex，因为上游已经提供经过验证的 App Server Shared Adopt。

Traex 分两层评估：

- 如果其 Hook 稳定，可先复用通知控制面。
- 只有 Traex 官方提供“连接已有进程并恢复同一会话”的远程客户端协议后，才接入同一 `sharedAdopt` 抽象。

不为 Traex 增加私有 IPC fallback，也不启动第二套通用会话框架。若协议不同，单独设计 provider adapter，不能污染 Codex 路径。

## 12. 安全边界

- endpoint 仅接受本机地址，接管后在 Session 中冻结。
- 不通过飞书卡片透传 endpoint、文件路径或任意 CLI 参数。
- Hook 入口限制调用用户、payload 大小和 schema。
- 卡片动作校验操作者权限和目标 Bot。
- 事件账本使用最小权限，日志脱敏，不记录 Codex 登录凭证。
- 不读取或复制 macOS 钥匙串凭证。

## 13. 历史代码清理

上线前执行一次性清理，不保留双路径：

1. 保留上游拥有的 `src/features/codex-notifier`，不得整目录删除。
2. 以 `git diff upstream/master` 为准，只移除 fork 中的私有 Desktop IPC follower、重试和 topic route 扩展。
3. 删除 `codexAppTransport: 'desktop-ipc'` 等旧类型、配置和条件分支。
4. 关闭旧 follower Session，删除其 fork 专用状态；不迁移陈旧 binding。
5. 保留 Codex/Traex 原生历史和用户数据。
6. 新插件与原生 Shared Adopt 验收通过后，再提交清理，避免半迁移状态。

## 14. 测试与验收

### 插件契约

- 未启用插件不会接收本地事件或卡片动作。
- action ID 冲突在启动时失败。
- 重复 completion 只产生一张通知卡。
- 重复点击只得到一个 Shared Adopt Session。
- 伪造 event ID、跨 Bot 操作和超大 payload 被拒绝。

### 双端主链路

- Desktop 完成 -> 工作台话题收到 CardKit。
- 点击接管 -> 原生 Shared Adopt 成功，卡片变为已接管。
- 飞书输入 -> 同一 Desktop thread 收到。
- Desktop 输入 -> 同一飞书话题显示。
- 接管前历史不回灌；接管后事件顺序正确。
- 审批、澄清、停止、Web Terminal 和关闭会话仍可用。
- 关闭飞书 Session 不终止源 App Server。
- daemon 重启后能恢复；Desktop 离线时明确失败且不排队。

### 回归与合并

- BotMux 全量构建和相关核心测试通过。
- Semantic Progress 在接管后继续显示统一 CardKit。
- 插件禁用后普通 BotMux/Codex/Traex 会话不受影响。
- 用最新 `upstream/master` 做一次试合并；插件代码无冲突，Core 仅通用 SPI 需要审查。

## 15. 完成定义

满足以下条件才算完成：

1. 同一 Desktop thread 的双向端到端测试通过，而不是只验证通知送达。
2. 数据面完全走上游 Shared Adopt，没有私有 follower 或 fallback。
3. Desktop Handoff 能独立安装、启停和卸载。
4. 接管后的 CardKit、审批和终端走 BotMux 原生链路。
5. 历史 fork 专用代码和状态完成清理。
6. 与最新上游试合并无高频核心文件冲突。

该边界是当前最小且完整的方案：只新增 BotMux 缺少的通用插件控制面，复用已经成熟的原生会话数据面。

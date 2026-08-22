# Semantic Progress Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为普通飞书 IM turn 增加一个最小、可独立安装的 `semantic-progress` 插件，使 Codex App 与 TRAE 的真实结构化事件驱动同一张 CardKit 2.0 语义进度卡，并由原卡可靠承接 canonical final。

**Architecture:** BotMux Core 只增加 provider-neutral 事实协议、单数插件贡献点、CardKit create/update 薄适配器、资格判断与单卡 delivery host；Codex App 与 TRAE 在各自现有 reader/runner 中只做一次白名单归一化。独立插件只包含纯 reducer、纯 card renderer 和入口导出，不持有飞书凭证、不实现传输或持久化。

**Tech Stack:** TypeScript 5.x、Node.js ESM、Vitest、`@larksuiteoapi/node-sdk` 1.64、BotMux convention plugin、飞书 CardKit v1 / Card JSON 2.0。

---

## 执行约束

- 设计权威文件：`docs/superpowers/specs/2026-08-22-semantic-progress-plugin-design.md`。
- Core 仓库：`/Users/bytedance/AiProjects/botmux`；插件仓库：`/Users/bytedance/AiProjects/botmux-plugin-semantic-progress`。
- 当前主工作区已有与本功能无关、且与 `src/codex-app-runner.ts`、`src/worker.ts`、`src/core/worker-pool.ts` 重叠的用户改动。执行前必须按 `using-git-worktrees` 技能从包含最终设计提交 `05e26ba4` 的 HEAD 建隔离 worktree；不得 reset、checkout 或覆盖主工作区改动。
- 每个任务按 RED → GREEN → REFACTOR 进行；只提交该任务列出的文件。任何基线失败先记录并确认与本功能无关，不能通过放宽断言或删除测试绕过。
- Core 中禁止出现 “AI马仔”“马仔二号” 或 A 款布局文案；插件中禁止 import `botmux/src/*`。
- 不实现 Codex App `requestUserInput` 双向桥，不新增 CardKit read/element/batch API，不新增第二个 TRAE reader/cursor，不接管特殊交付通道。

## Task 1: 定义最小进度事实协议与安全归一化

**Files:**

- Create: `src/core/turn-progress/protocol.ts`
- Modify: `src/types.ts:1109` (`WorkerToDaemon`)
- Test: `test/turn-progress-protocol.test.ts`

- [ ] **Step 1: 写失败测试，固定允许的事实形状和安全边界**

测试必须覆盖：合法 start/narrative/operation；空文本、控制字符、原生 `<at>`、240 字符上限；原始 command/output/invocation/result 字段被拒绝；绝对路径、`..` 路径和工作区外路径被丢弃；最多三个相对路径；非法 schema/seq/time/operation 被拒绝。

核心断言采用以下公开契约：

```ts
import { describe, expect, it } from 'vitest';
import { normalizeTurnProgressFact } from '../src/core/turn-progress/protocol.js';

describe('normalizeTurnProgressFact', () => {
  it('keeps only a bounded user-visible narrative', () => {
    expect(normalizeTurnProgressFact({
      schemaVersion: 1,
      seq: 7,
      atMs: 1_787_333_200_000,
      kind: 'narrative',
      text: `  正在检查\u0000 <at id="ou_x">某人</at>  ${'好'.repeat(300)}`,
    }, '/workspace')).toEqual({
      schemaVersion: 1,
      seq: 7,
      atMs: 1_787_333_200_000,
      kind: 'narrative',
      text: `正在检查某人 ${'好'.repeat(233)}`,
    });
  });

  it('rejects raw execution payload fields', () => {
    expect(normalizeTurnProgressFact({
      schemaVersion: 1,
      seq: 8,
      atMs: 1_787_333_200_001,
      kind: 'operation',
      operation: {
        type: 'command',
        phase: 'started',
        command: 'printenv',
      },
    }, '/workspace')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm vitest run --project unit test/turn-progress-protocol.test.ts`

Expected: FAIL，提示 `src/core/turn-progress/protocol.ts` 不存在。

- [ ] **Step 3: 增加协议类型和唯一的 IPC 消息**

`src/core/turn-progress/protocol.ts` 导出以下稳定类型；`src/types.ts` 的 `WorkerToDaemon` 只新增一个 variant：

```ts
export interface TurnProgressFactV1 {
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
}

export type TurnProgressTerminal = 'completed' | 'failed' | 'cancelled' | 'ambiguous';

export interface TurnProgressContextV1 {
  schemaVersion: 1;
  sessionId: string;
  primaryTurnId: string;
  turnId: string;
  dispatchAttempt?: number;
  workerGeneration: number;
  cliId: string;
  locale: 'zh' | 'en';
  restored: boolean;
}

export type TurnProgressEventV1 =
  | { schemaVersion: 1; seq: number; kind: 'turn_started' }
  | { schemaVersion: 1; seq: number; kind: 'narrative'; text: string }
  | { schemaVersion: 1; seq: number; kind: 'operation'; operation: NonNullable<TurnProgressFactV1['operation']> }
  | { schemaVersion: 1; seq: number; kind: 'waiting'; text: string }
  | { schemaVersion: 1; seq: number; kind: 'resumed' }
  | { schemaVersion: 1; seq: number; kind: 'finalizing' }
  | { schemaVersion: 1; seq: number; kind: 'external_reply' }
  | { schemaVersion: 1; seq: number; kind: 'terminal'; status: TurnProgressTerminal; errorCode?: string };

export interface TurnProgressPluginV1 {
  schemaVersion: 1;
  initialState(context: TurnProgressContextV1): unknown;
  reduce(state: unknown, event: TurnProgressEventV1, context: TurnProgressContextV1): unknown;
  render(state: unknown, context: TurnProgressContextV1): Record<string, unknown>;
}
```

IPC variant：

```ts
| {
    type: 'turn_progress';
    sessionId: string;
    turnId: string;
    dispatchAttempt?: number;
    fact: import('./core/turn-progress/protocol.js').TurnProgressFactV1;
  }
```

`normalizeTurnProgressFact(raw, workingDir)` 是唯一安全入口。它必须按字段白名单重新构造对象，不能用对象展开保留未知字段；路径用 `node:path` 的 `resolve`/`relative` 证明位于 `workingDir` 内。

- [ ] **Step 4: 运行协议测试与类型检查确认 GREEN**

Run: `pnpm vitest run --project unit test/turn-progress-protocol.test.ts && pnpm exec tsc --noEmit`

Expected: PASS。

- [ ] **Step 5: 提交 Core 协议**

```bash
git add src/core/turn-progress/protocol.ts src/types.ts test/turn-progress-protocol.test.ts
git commit -m "feat: add bounded turn progress facts"
```

## Task 2: 扩展 convention plugin 并冻结单数贡献

**Files:**

- Modify: `src/core/plugins/types.ts`
- Modify: `src/core/plugins/convention-scanner.ts`
- Modify: `src/core/plugins/runtime.ts`
- Test: `test/plugin-manifest-store.test.ts`
- Test: `test/turn-progress-plugin-runtime.test.ts`

- [ ] **Step 1: 扩展 scanner 测试并确认 RED**

在现有 “scans fixed plugin convention directories” fixture 中创建 `turn-progress/index.js`，期望：

```ts
turnProgress: { entry: 'turn-progress/index.js' }
```

新增 runtime 测试，覆盖：一个有效贡献可加载；同一 manifest 绑定 `first`、`second` 两个贡献时报 `multiple_turn_progress_plugins:first,second`；schema 不是 1、缺函数、render 返回数组时 fail closed。

Run: `pnpm vitest run --project unit test/plugin-manifest-store.test.ts test/turn-progress-plugin-runtime.test.ts`

Expected: FAIL，scanner 尚未返回 `turnProgress`，loader 尚不存在。

- [ ] **Step 2: 增加单数贡献类型和固定目录扫描**

```ts
export interface PluginTurnProgressContribution extends PluginRuntimeEntrypoint {}

export interface PluginContributions {
  skills?: PluginSkillEntry[];
  dashboard?: PluginDashboardEntry[];
  mcp?: PluginMcpContribution;
  cli?: PluginCliContribution;
  service?: PluginServiceContribution;
  turnProgress?: PluginTurnProgressContribution;
}
```

scanner 只识别固定入口：

```ts
function scanTurnProgress(runtimeDir: string): ScannedPluginContributions['turnProgress'] {
  const entry = 'turn-progress/index.js';
  return isFile(join(runtimeDir, entry)) ? { entry } : undefined;
}
```

不得读取 manifest 中的任意入口路径，不增加 hook 列表或通用事件总线。

- [ ] **Step 3: 实现纯贡献 loader**

`runtime.ts` 导出：

```ts
export interface LoadedTurnProgressPlugin {
  pluginId: string;
  plugin: TurnProgressPluginV1;
}

export function resolveTurnProgressPluginId(pluginIds: readonly string[]): string | undefined;

export async function loadTurnProgressPlugin(
  pluginIds: readonly string[],
): Promise<LoadedTurnProgressPlugin | undefined>;
```

实现要求：

- 只遍历传入的 session manifest `pluginIds`，不能默认加载全局插件；
- 先同步收集带 `turnProgress` 的 installed record，0 个返回 `undefined`，多于 1 个立即报冲突；
- 用 `resolvePluginPath` + `pathToFileURL` import 固定入口；
- 接受 `mod.default ?? mod`，严格校验 `schemaVersion === 1` 和三个函数；
- 用一次最小 probe context 调用 `initialState`/`render`，render 必须是非数组对象且 `schema === '2.0'`；probe 不执行网络或持久化。

冲突与入口校验错误必须带 plugin ID 记录一次诊断，并让语义进度 fail closed 到既有 streaming/final 链路；不得因为配置错误压制旧卡后静默返回。

- [ ] **Step 4: 运行插件测试确认 GREEN**

Run: `pnpm vitest run --project unit test/plugin-manifest-store.test.ts test/turn-progress-plugin-runtime.test.ts test/plugin-session-manifest.test.ts`

Expected: PASS；现有 session manifest 稳定性测试保持通过。

- [ ] **Step 5: 提交插件 SPI**

```bash
git add src/core/plugins/types.ts src/core/plugins/convention-scanner.ts src/core/plugins/runtime.ts test/plugin-manifest-store.test.ts test/turn-progress-plugin-runtime.test.ts
git commit -m "feat: add turn progress plugin contribution"
```

## Task 3: 增加两个 CardKit 薄适配器与可判定错误

**Files:**

- Modify: `src/im/lark/client.ts:397,982`
- Test: `test/lark-cardkit-client.test.ts`

- [ ] **Step 1: 写 SDK 参数测试并确认 RED**

mock `getBotClient()`，验证 create 与 update 的精确 payload；卡片在进入 SDK 前必须经过 `stampBotmuxCallbackMarkers`，以保证最终 feedback 按钮仍带 BotMux ownership marker。

预期调用：

```ts
expect(create).toHaveBeenCalledWith({
  data: {
    type: 'card_json',
    data: stampedCardJson,
  },
});

expect(update).toHaveBeenCalledWith({
  path: { card_id: 'card-1' },
  data: {
    card: { type: 'card_json', data: stampedCardJson },
    sequence: 4,
    uuid: 'tp_update_4',
  },
});
```

同时测试：code 0 但缺 `card_id`、HTTP 429、HTTP 5xx、无 response 的 timeout、业务 4xx。

Run: `pnpm vitest run --project unit test/lark-cardkit-client.test.ts`

Expected: FAIL，两个函数尚不存在。

- [ ] **Step 2: 实现最小错误类型和两个函数**

```ts
export class LarkCardKitError extends Error {
  constructor(
    message: string,
    readonly disposition: 'retryable' | 'ambiguous' | 'permanent',
    readonly code?: number,
  ) {
    super(message);
    this.name = 'LarkCardKitError';
  }
}

export async function createCardEntity(larkAppId: string, cardJson: string): Promise<string>;

export async function updateCardEntity(
  larkAppId: string,
  cardId: string,
  cardJson: string,
  sequence: number,
  uuid: string,
): Promise<void>;
```

分类规则固定为：HTTP 429/5xx → `retryable`；请求已发出但没有可判定 HTTP/业务响应 → `ambiguous`；明确 4xx、非零业务 code、schema/permission/withdrawn → `permanent`。Create 的 ambiguous 结果不重试 create；Update 的 final ambiguous 由 host 复用同一 intent 重试。

- [ ] **Step 3: 运行适配器测试确认 GREEN**

Run: `pnpm vitest run --project unit test/lark-cardkit-client.test.ts test/lark-transport-boundary.test.ts`

Expected: PASS；现有 IM send/reply/patch 行为零变化。

- [ ] **Step 4: 提交 CardKit adapter**

```bash
git add src/im/lark/client.ts test/lark-cardkit-client.test.ts
git commit -m "feat: add minimal cardkit entity adapters"
```

## Task 4: 实现单卡 delivery host 与最小 durable binding

**Files:**

- Create: `src/core/turn-progress/host.ts`
- Modify: `src/types.ts:173` (`Session`)
- Modify: `src/core/types.ts:50` (`DaemonSession` runtime owner)
- Test: `test/turn-progress-host.test.ts`
- Test: `test/session-store.test.ts`

- [ ] **Step 1: 写 host 状态机测试并确认 RED**

使用 `vi.useFakeTimers()` 与注入的 fake transport，逐项固定以下不变量：

- start 只 create 一次；create 后先持久化 `cardId + replyUuid`，再 reply `{"type":"card","data":{"card_id":"card-1"}}`；
- reply timeout 用同一 IM UUID 重试，绝不再次 create；明确永久失败时先清除未挂载 binding，再返回 legacy fallback；
- 同时最多一个 update；在途期间只保留最后一个 pending snapshot；普通更新 2 秒合并；boundary 立即排入同一串行队列；
- CardKit sequence 从 1 单调增加，单个 intent 的 UUID/sequence 固定；
- 普通 progress update 失败不无限重试；final 的 retryable/ambiguous 以封顶退避持续重试相同 intent；permanent 返回 fresh-final fallback；
- final update 成功后 binding 保持 `finalizing`；只有 Core 显式 ACK 才清除，紧随其后的 terminal 不得抢先释放；
- terminal 后丢弃迟到 progress；worker generation、turn、attempt 不匹配时不调用插件；
- terminal 只能收口已存在的 host/binding，不能从零创建卡；没有 canonical final 的终态复用 durable final intent 更新原卡，成功 ACK 后清 binding；
- CardKit create 返回后、reply/update/retry 前都重验当前 worker generation authority；失权后不继续外部写入；
- 同一 worker generation 内 `fact.seq <= lastFactSeq` 直接丢弃；lifecycle 与 provider fact 进入 reducer 前由 host 分配统一的本地单调 event seq；
- ordered steer alias 最多保存 primary + 最近 31 个成员；final 命中最新 alias，reaction 仍加 primary turn message；
- 新的独立执行单元只有在上一 binding 已收口后才能 start；不得覆盖仍 active/finalizing 的 binding；
- 首次 `initialState`/`render` 抛错时不 create；卡片已挂载后的 `reduce`/`render` 抛错时隔离后续 projection，但 `deliverFinal` 仍可用 Core canonical card 原卡收尾；
- binding/update intent 持久化失败时不得调用 reply/update；create 后首次 binding 持久化失败时安全放弃未挂载 entity；
- restore 只恢复 binding，插件 state 从 `initialState({ restored: true })` 开始，不能从 hash 反推 card 内容。

Run: `pnpm vitest run --project unit test/turn-progress-host.test.ts`

Expected: FAIL，host 尚不存在。

- [ ] **Step 2: 增加 durable binding 类型**

在 `Session` 上新增一个可选字段，不能新建 sidecar：

```ts
export interface TurnProgressBindingV1 {
  schemaVersion: 1;
  pluginId: string;
  primaryTurnId: string;
  primaryDispatchAttempt?: number;
  memberTurnIds: string[];
  workerGeneration: number;
  cardId: string;
  messageId?: string;
  replyUuid: string;
  cardSequence: number;
  deliveryState: 'replying' | 'active' | 'finalizing';
  updateIntent?: {
    uuid: string;
    sequence: number;
    cardHash: string;
  };
}
```

`Session` 增加 `turnProgressBinding?: TurnProgressBindingV1`。`DaemonSession` 只增加非持久 runtime owner：

```ts
turnProgressHost?: import('./turn-progress/host.js').TurnProgressHost;
turnProgressLegacyFallbackTurns?: Set<string>;
```

- [ ] **Step 3: 实现 host 的窄公开 API**

```ts
export interface TurnProgressHostDeps {
  active(): boolean;
  create(cardJson: string): Promise<string>;
  reply(cardRefJson: string, turnId: string, uuid: string): Promise<string>;
  update(cardId: string, cardJson: string, sequence: number, uuid: string): Promise<void>;
  reactDone(primaryTurnId: string): Promise<void>;
  persist(binding: TurnProgressBindingV1 | undefined): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type FinalCardDelivery =
  | { kind: 'delivered'; messageId: string }
  | { kind: 'fallback' }
  | { kind: 'not_applicable' };

export class TurnProgressHost {
  static start(
    pluginId: string,
    plugin: TurnProgressPluginV1,
    context: TurnProgressContextV1,
    deps: TurnProgressHostDeps,
  ): Promise<TurnProgressHost | null>;

  static restore(
    plugin: TurnProgressPluginV1,
    context: TurnProgressContextV1,
    binding: TurnProgressBindingV1,
    deps: TurnProgressHostDeps,
  ): TurnProgressHost;

  owns(turnId: string, dispatchAttempt?: number): boolean;
  bindSteer(turnId: string): void;
  dispatchFact(fact: TurnProgressFactV1): void;
  dispatch(event: Omit<TurnProgressEventV1, 'schemaVersion' | 'seq'>, boundary: boolean): void;
  settleTerminal(event: Omit<Extract<TurnProgressEventV1, { kind: 'terminal' }>, 'schemaVersion' | 'seq'>): Promise<FinalCardDelivery>;
  deliverFinal(cardJson: string): Promise<FinalCardDelivery>;
  ackFinal(turnId: string): void;
  dispose(): void;
}
```

实现中只允许一个 timer、一个 `inFlight` Promise 和一个 `pending` snapshot。Card hash 用 Node `createHash('sha256')`；UUID 从稳定的 session/primary turn/sequence hash 派生，长度不超过 50。持久化顺序是 intent-before-provider、success-after-provider；任何 intent 持久化异常都在远端调用前 fail closed。Projection 隔离状态只在 runtime host 内，不扩充 durable schema；canonical final 直接使用 Core 已构建的 card JSON，不依赖插件再次 render。

- [ ] **Step 4: 确认 host 与 session persistence GREEN**

Run: `pnpm vitest run --project unit test/turn-progress-host.test.ts test/session-store.test.ts`

Expected: PASS；旧 session 无该字段时正常读取。

- [ ] **Step 5: 提交 delivery host**

```bash
git add src/core/turn-progress/host.ts src/types.ts src/core/types.ts test/turn-progress-host.test.ts test/session-store.test.ts
git commit -m "feat: add durable turn progress host"
```

## Task 5: 统一资格判断并接入 start/progress/wait/terminal/steer

**Files:**

- Create: `src/core/turn-progress/eligibility.ts`
- Create: `src/core/turn-progress/controller.ts`
- Modify: `src/core/worker-pool.ts:750,10556,10856,10939,11507,11554`
- Test: `test/turn-progress-eligibility.test.ts`
- Test: `test/turn-progress-worker-routing.test.ts`
- Test: `test/session-lifecycle-start.test.ts`

- [ ] **Step 1: 写资格矩阵测试并确认 RED**

资格输入使用显式布尔值，禁止 controller 猜测字符串路由：

```ts
export interface TurnProgressEligibilityInput {
  pluginId?: string;
  larkTransport: boolean;
  http: boolean;
  docComment: boolean;
  vcReceiver: boolean;
  vcListener: boolean;
  substitute: boolean;
  managedOrSilent: boolean;
  suppressDelivery?: boolean;
  steerSuperseded?: boolean;
}
```

测试普通 Lark IM 为 true，并逐一翻转 HTTP wait、HTTP async、doc comment、VC receiver、VC listener、substitute、managed/silent、无插件为 false；final 额外排除 suppress/superseded。

Run: `pnpm vitest run --project unit test/turn-progress-eligibility.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现两个纯谓词**

```ts
export function canStartTurnProgress(input: TurnProgressEligibilityInput): boolean;

export function canDeliverFinalInProgressCard(input: TurnProgressEligibilityInput): boolean;
```

`canDeliverFinalInProgressCard` 必须先复用 `canStartTurnProgress`，再检查 `suppressDelivery !== true` 与 `steerSuperseded !== true`，不能复制第二套矩阵。

- [ ] **Step 3: 建立 controller，集中 runtime load 与 host deps**

`controller.ts` 只暴露短调用点：

```ts
export interface TurnProgressControllerDeps {
  reply(cardRefJson: string, turnId: string, uuid: string): Promise<string>;
  reactDone(primaryTurnId: string): Promise<void>;
}

export function semanticProgressSuppressesLegacyCard(
  ds: DaemonSession,
  turnId: string | undefined,
  eligibility: TurnProgressEligibilityInput,
): boolean;
export async function handleTurnProgressFact(
  ds: DaemonSession,
  message: Extract<WorkerToDaemon, { type: 'turn_progress' }>,
  workerGeneration: number,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<'handled' | 'fallback' | 'ignored'>;
export function handleTurnProgressSteer(ds: DaemonSession, turnId: string): void;
export async function handleTurnProgressWaiting(
  ds: DaemonSession,
  turnId: string | undefined,
  description: string,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<void>;
export async function handleTurnProgressResumed(
  ds: DaemonSession,
  turnId: string | undefined,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<void>;
export async function handleTurnProgressExternalReply(
  ds: DaemonSession,
  turnId: string,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<void>;
export async function handleTurnProgressTerminal(
  ds: DaemonSession,
  terminal: Extract<WorkerToDaemon, { type: 'turn_terminal' }>,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<void>;
```

controller 必须：

- 从 `readSessionPluginManifest(sessionId)` 获取冻结 plugin IDs；
- 用 Task 2 loader，每个 worker generation 至多加载一次；
- `semanticProgressSuppressesLegacyCard` 只在同步解析到恰好一个贡献、资格成立且本轮未标记 fallback 时返回 true；贡献冲突直接记录诊断并返回 false。异步入口加载/校验失败则由首个 fact 触发 fallback，恢复旧开始卡；
- fact、waiting、resumed、external、terminal 与 final 共用一个 lazy `ensureHost`；Daemon 重启后若只有 durable binding 没有 runtime host，也必须先 `restore()`，不能直接 fresh-send 或遗留悬空卡；
- 在调用 host 前再次校验 `ds.workerGeneration`、`session.workerGeneration`、session、turn alias、attempt；
- create 明确失败或响应不明确且拿不到 `cardId` 时，把该 turn 加入 `turnProgressLegacyFallbackTurns` 并返回 `fallback`；未挂载 entity 不会产生用户可见双卡。调用方再调用现有 `postTurnStartingCard`，controller 不反向 import `worker-pool.ts`；
- final update 成功只进入 `finalizing`，不得清 binding；Core 既有 dedupe/settlement 明确成功后才调用 `ackFinal()`；
- terminal handler 延后一个 event-loop turn 处理，让同一 Worker 先发出的 `final_output` 有机会登记 final intent；host 已 `finalizing` 时 terminal 只记账、不覆盖 final；
- failed/cancelled/ambiguous 且没有 final intent时冻结终态；completed 只有 `outputDisposition === 'nothing_to_send'` 或已有 external reply 时收口，裸 completed 只投递 provider-neutral `finalizing` 并保留 binding，展示文案由插件决定；
- 不包含卡片文案或 CLI 特判。

- [ ] **Step 4: 在现有大文件只加短 tap**

接入点固定如下：

- `beginNewTurn` 保持不改，仍设置 `streamCardPending`/generation、冻结上一张旧卡并调用 `postTurnStartingCard`；
- `postTurnStartingCard` 是开始卡的统一阻断点：插件贡献已冻结启用且当前 turn 未进入 legacy fallback 时直接返回；`screen_update` 自带的创建/patch 与 `screenshot_uploaded` patch 使用同一谓词；
- worker switch 新增 `case 'turn_progress'` 调 controller；若返回 `fallback`，只调用一次现有 `postTurnStartingCard`，不得在 controller 中反向 import；
- `tui_prompt` 在现有交互卡创建前 `await` waiting；`tui_prompt_resolved` 在权威校验后 `await` resumed；
- `steer_accepted` 调 `handleTurnProgressSteer`，不触发 reducer；
- `explicit_reply_observed` `await` external reply；
- `turn_terminal` 在现有 durable terminal 逻辑完成后 `await` terminal controller；`steer_superseded` 不从该分支伪造 terminal。

`setupWorkerHandlers` 在现有 `scopedReply` 旁构造一次 `progressDeps`：`reply` 继续调用 `scopedReply(cardRef, 'interactive', turnId, { uuid })`，`reactDone` 继续调用现有 `addReaction(ds.larkAppId, primaryTurnId, doneReactionEmojiFor(ds))`。Controller 不复制 Lark 路由、reaction 配置或 callback marker 逻辑。

- [ ] **Step 5: 测试“一张卡”与旧链路回退**

测试至少证明：

- 插件启用 + `turn_started` → CardKit create 一次，旧 `sessionReply(full streaming card)` 为 0 次；
- start create 明确失败 → 当前 turn 恢复调用现有 `postTurnStartingCard`；
- start create 响应不明确且无 `cardId` → 不重试 create，同样安全回到旧开始卡；
- 插件未启用 → 原测试调用数不变；
- 多贡献冲突或入口校验失败 → 记录诊断并保留旧开始卡/final，不出现无卡状态；
- 两个独立 started turn 各一张卡；同一执行单元的 steer alias 不创建第二张；
- TUI prompt 仍发送独立 ask card，但原进度卡 waiting/resumed；
- explicit reply 只更新进度卡终态，不改写显式消息。

Run: `pnpm vitest run --project unit test/turn-progress-eligibility.test.ts test/turn-progress-worker-routing.test.ts test/session-lifecycle-start.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交生命周期接入**

```bash
git add src/core/turn-progress/eligibility.ts src/core/turn-progress/controller.ts src/core/worker-pool.ts test/turn-progress-eligibility.test.ts test/turn-progress-worker-routing.test.ts test/session-lifecycle-start.test.ts
git commit -m "feat: route ordinary turns through progress host"
```

## Task 6: 让 canonical final 原卡收尾且不丢不重

**Files:**

- Modify: `src/core/turn-progress/controller.ts`
- Modify: `src/core/worker-pool.ts:12470` (`deliverFinalOutput`)
- Test: `test/turn-progress-final-delivery.test.ts`
- Test: existing final-output delivery tests discovered by `rg -l "deliverFinalOutput" test`

- [ ] **Step 1: 写最终交付分支测试并确认 RED**

覆盖以下顺序和结果：

1. Core 先调用现有 `buildCanonicalFinalReplyCard`；
2. active semantic host 用同一 card entity update；
3. update 明确成功后才记录 feedback、设置 `lastBridgeEmittedUuid`、完成 Codex settlement，并给 primary card-owning 用户消息加 `✅`；
4. update 明确 permanent failure 才走现有 `scopedReply`，且继续使用 `bridgeFinalOutputUuid` / `ca_${dispatchId}`；
5. update timeout/429/5xx 期间 `scopedReply` 调用数始终为 0，同一 `uuid + sequence` 重试；
6. 无 binding、HTTP wait/async、doc comment、VC receiver/listener、substitute、managed/silent 沿用旧路径；
7. `suppressDelivery` 只由 external/terminal 收口，`steer_superseded` 不冻结；真实最后 member final 命中 alias 并原卡收尾。
8. update 成功后 binding 仍是 `finalizing`；terminal 先到不清除；普通 bridge dedupe 或 Codex settlement 持久化成功后才 ACK 清除。

Run: `pnpm vitest run --project unit test/turn-progress-final-delivery.test.ts`

Expected: FAIL，final 尚未调用 semantic controller。

- [ ] **Step 2: 增加一个 final controller API**

```ts
export async function deliverFinalThroughProgressCard(
  ds: DaemonSession,
  message: Extract<WorkerToDaemon, { type: 'final_output' }>,
  cardJson: string,
  eligibility: TurnProgressEligibilityInput,
  deps: TurnProgressControllerDeps,
): Promise<FinalCardDelivery>;

export function acknowledgeProgressFinal(ds: DaemonSession, turnId: string): void;
```

它只在统一 final 资格谓词与 host `owns()` 同时成立时调用 `host.deliverFinal(cardJson)`。成功返回 host 已有 `messageId`；permanent 返回 `fallback`；没有资格返回 `not_applicable`。

- [ ] **Step 3: 在 `deliverFinalOutput` 的 canonical card 构建后接入**

保留 wait/async/doc/VC 的现有前置分支。只有走到普通 Lark canonical card 后：

```ts
const progressDelivery = await deliverFinalThroughProgressCard(
  ds,
  msg,
  cardJson,
  progressEligibility,
  progressDeps,
);
if (progressDelivery.kind === 'delivered') {
  const messageId = progressDelivery.messageId;
  ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg);
  if (feedbackPolicy && baseFeedbackCard) {
    await persistFinalOutputFeedback(
      ds,
      msg,
      safeAssistantText,
      effectiveCliId,
      messageId,
      feedbackPolicy,
      baseFeedbackCard,
      feedbackRequesterSubjectId,
      getBot(ds.larkAppId).config.feedbackWebhooks?.destinations,
      t,
    );
  }
  if (!msg.codexAppSettlement) acknowledgeProgressFinal(ds, msg.turnId);
  onComplete?.(true);
  return;
}
```

`fallback` 与 `not_applicable` 都继续执行现有 fresh reply 代码；若 fallback fresh reply 成功，也在既有 dedupe/settlement 成功点 ACK 并清除旧 binding。Codex App 分支必须在 `sessionStore.updateSession()` 已原子提交 FIFO/sequence 后调用 `acknowledgeProgressFinal`，不能只在 `deliverFinalOutput` 返回时清除。不得复制 final card builder、feedback store、settlement 或 dedupe。

`deliverFinalOutput` 在通过现有 wait/async/doc/VC 前置分流后，使用同一套既有 helper 构造 `progressEligibility`；`progressDeps` 的 reply/reaction 闭包与 Task 5 完全相同，不能在 final 分支另写一套 Lark 路由。

- [ ] **Step 4: 将完成 reaction 绑定到 primary 消息**

host 的 `reactDone` 依赖必须使用 binding 的 `primaryTurnId` 对应 Lark 用户消息，而不是 final member turn。Reaction 失败只记 debug，不改变已成功的 final delivery。

- [ ] **Step 5: 跑最终交付与回归测试**

Run:

```bash
pnpm vitest run --project unit \
  test/turn-progress-final-delivery.test.ts \
  test/bridge-final-output-retry.test.ts \
  test/worker-codex-app-turn-routing.integration.test.ts
```

若仓库中真实 final-output 测试文件名不同，先执行 `rg -l "deliverFinalOutput|final_output forwarded|bridgeFinalOutputUuid" test`，把所有命中文件加入命令，不能跳过。

Expected: PASS；原 fresh final 分支的稳定 UUID 断言保持不变。

- [ ] **Step 6: 提交 final 接管**

```bash
git add src/core/turn-progress/controller.ts src/core/worker-pool.ts test/turn-progress-final-delivery.test.ts
git commit -m "feat: finalize answers in semantic progress card"
```

## Task 7: 从 Codex App signed channel 产出白名单事实

**Files:**

- Modify: `src/codex-app-runner.ts:883,1355`
- Modify: `src/worker.ts:8835`
- Modify: `test/fixtures/fake-codex-app-server.mjs`
- Modify: `test/codex-app-runner.integration.test.ts`
- Modify: `test/worker-codex-app-turn-routing.integration.test.ts`

- [ ] **Step 1: 扩展 fake server 与 runner 测试并确认 RED**

fixture 为一个 turn 依序发出：`item/started(commandExecution)`、commentary `agentMessage`、`item/completed(commandExecution)`、`item/started(fileChange)`、`item/completed(fileChange)`、MCP started/completed、final。

测试只检查 signed marker 的白名单事实：

```ts
expect(result.markers.filter(marker => marker.kind === 'turn-progress').map(marker => marker.payload.fact)).toEqual([
  expect.objectContaining({ kind: 'turn_started' }),
  expect.objectContaining({ kind: 'operation', operation: { id: 'cmd-1', type: 'command', phase: 'started' } }),
  expect.objectContaining({ kind: 'narrative', text: '正在检查实现' }),
  expect.objectContaining({ kind: 'operation', operation: { id: 'cmd-1', type: 'command', phase: 'completed', outcome: 'succeeded' } }),
]);
expect(JSON.stringify(result.markers)).not.toContain('printenv');
expect(JSON.stringify(result.markers)).not.toContain('command output');
```

Run: `pnpm vitest run --project unit test/codex-app-runner.integration.test.ts`

Expected: FAIL，没有 `turn-progress` marker。

- [ ] **Step 2: Runner 只在现有 notification handler 归一化一次**

新增 `emitTurnProgressFact(turn, fact)`，payload 带 primary accepted dispatch 的 `replyTurnId`，签名序号继续复用 control channel 自带的 `control.seq`。规则：

- `runTurn` dequeue root 时发一次 `turn_started`；`turn/steer` 不发第二次；
- command 只发类型、item id、phase、outcome，不发 command/output；
- file change subjects 只取 `args.cwd` 内相对路径，最多三个；
- MCP 只取稳定 tool/server 名，绝不取 arguments/result；
- commentary 只在完整 `item/completed(agentMessage)` 且 `phase !== 'final_answer'` 时发，避免 delta 噪声和 reasoning；
- `agent_reasoning_raw_content` 与 output delta 永远不发事实；
- final 仍只走原 `final-start/chunk/end` 事务，不复制 terminal。

- [ ] **Step 3: Worker 验签后转成唯一 IPC**

在 `handleTrustedCodexAppMarker` 增加 `kind === 'turn-progress'` 分支：

- 必须有 signed `control`；fact 的 IPC seq 使用 `control.seq`；
- `replyTurnId` 必须属于当前 `codexAppTurnDispatchQueue` 或已接受 group；
- 调 `normalizeTurnProgressFact(payload.fact, workingDir)`；失败只拒绝该 marker，不崩 worker；
- 发送 `turn_progress` 时补 `sessionId`、BotMux `turnId`、准确 `dispatchAttempt`。

- [ ] **Step 4: 验证 ordered steer 仍为一张卡**

在 worker routing integration 中证明：root fact 创建一次；`steer_accepted` 只加 alias；后续事实仍命中原 host；N−1 superseded finals 不更新终态；最后 real final 更新原 card。

Run:

```bash
pnpm vitest run --project unit \
  test/codex-app-runner.integration.test.ts \
  test/worker-codex-app-turn-routing.integration.test.ts
```

Expected: PASS；现有 `requestUserInput` 空 answers 测试保持原样。

- [ ] **Step 5: 提交 Codex App facts**

```bash
git add src/codex-app-runner.ts src/worker.ts test/fixtures/fake-codex-app-server.mjs test/codex-app-runner.integration.test.ts test/worker-codex-app-turn-routing.integration.test.ts
git commit -m "feat: emit codex app progress facts"
```

## Task 8: 在同一 TRAE JSONL reader 中产出有序事实

**Files:**

- Modify: `src/services/traex-transcript.ts`
- Modify: `src/worker.ts:5776,6564`
- Modify: `test/traex-transcript.test.ts`
- Test: `test/worker-traex-progress-routing.test.ts`

- [ ] **Step 1: 增加真实 rollout shape fixture 并确认 RED**

fixture 依序包含 `user_message`、`task_started`、commentary `agent_message`、`exec_command_end`、`patch_apply_end`、`mcp_tool_call_end`、`task_complete`，以及必须被忽略的 raw reasoning/output/invocation/result。

`TraexDrainResult` 的新字段使用有序记录，避免一次 drain 包含多个 turn 时错绑：

```ts
export type TraexOrderedRecord =
  | { kind: 'bridge'; event: CodexBridgeEvent }
  | { kind: 'progress'; fact: TurnProgressFactV1 };

export interface TraexDrainResult extends CodexDrainResult {
  orderedRecords: TraexOrderedRecord[];
  latestModel?: string;
  latestReasoningEffort?: string;
}
```

测试要求 `orderedRecords` 保持 JSONL 行顺序，且 `events` 与其中 bridge records 完全一致。

Run: `pnpm vitest run --project unit test/traex-transcript.test.ts`

Expected: FAIL，没有 `orderedRecords`。

- [ ] **Step 2: 在现有 for-line 循环中同步构造 event 与 fact**

规则固定为：

- `task_started` → `turn_started`；
- commentary `agent_message` → narrative，同时保留现有 pending final/sentinel cache；
- `exec_command_end` → completed command；
- `patch_apply_end` → completed file change，相对路径最多三个；
- `mcp_tool_call_end` → completed MCP，仅工具名；
- `task_complete`/`turn_aborted` 仍只产现有 assistant_final，由 `turn_terminal` 合流；
- `probe: true` 不修改 pending cache，也不产生用于 Worker 外发的 progress side effect；返回记录本身仍是纯数据；
- 不开启 `codexRpcInput`，不增加文件 watcher、cursor 或第二次扫描。

- [ ] **Step 3: Worker 按 ordered records 逐条推进归属**

TRAE 分支不能再把整批 `events` 一次 ingest 后才猜 owner。对每条：

- bridge record 立即 `codexBridgeQueue.ingest([event])`；
- progress record 查找当前 started 且未 terminal 的 queue owner；若 `task_started` 先于 user record，最多缓存 128 条，匹配到 owner 后按序 flush；
- terminal bridge record 后清空该 owner 的 pending progress；
- adopt/substitute/managed/silent 的 worker 可以发送事实，Daemon 资格门统一丢弃；但 adopt 模式不发送本地 synthetic turn 的进度。

- [ ] **Step 4: 运行 TRAE reader 与 worker routing 测试**

Run:

```bash
pnpm vitest run --project unit \
  test/traex-transcript.test.ts \
  test/worker-traex-progress-routing.test.ts
```

Expected: PASS；现有 final、silent sentinel、turn_aborted、runtime model/effort 用例无回归。

- [ ] **Step 5: 提交 TRAE facts**

```bash
git add src/services/traex-transcript.ts src/worker.ts test/traex-transcript.test.ts test/worker-traex-progress-routing.test.ts
git commit -m "feat: emit traex progress facts from rollout"
```

## Task 9: 创建独立、只有三个源文件的 semantic-progress 插件

**Repository:** `/Users/bytedance/AiProjects/botmux-plugin-semantic-progress`

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/reducer.ts`
- Create: `src/card.ts`
- Create: `src/turn-progress/index.ts`
- Create: `test/reducer.test.ts`
- Create: `test/card.test.ts`
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: 按 `plugin-creator` 技能创建最小仓库**

不要保留官方模板里无关的 skill/MCP/CLI/dashboard/service 示例。最终 `package.json` 的功能性配置固定为：

```json
{
  "name": "@botmux-ai/plugin-semantic-progress",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "check": "pnpm test && pnpm build"
  },
  "keywords": ["botmux-plugin"],
  "botmux": {
    "schemaVersion": 1,
    "id": "semantic-progress",
    "displayName": "Semantic Progress"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^4.0.18"
  }
}
```

`tsconfig.json` 使用 `rootDir: "src"`、`outDir: "dist"`、`module/moduleResolution: "NodeNext"`、strict true，使入口精确生成 `dist/turn-progress/index.js`。

- [ ] **Step 2: 先写 reducer 失败测试**

覆盖：旧 seq 幂等；start；commentary；operation started/completed；只有 completed；相邻同类折叠；waiting/resume；terminal freeze；最多四个 timeline；计数不丢；external reply。

状态类型直接留在 `reducer.ts`，不要创建 `types.ts`：

```ts
export interface ProgressState {
  seq: number;
  phase: 'starting' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'cancelled' | 'ambiguous';
  currentText?: string;
  timeline: Array<{
    key: string;
    label: string;
    status: 'current' | 'completed' | 'failed';
    count: number;
  }>;
  operationCount: number;
  terminalErrorCode?: string;
}
```

Run: `pnpm test`

Expected: FAIL，reducer 尚不存在。

- [ ] **Step 3: 实现纯 reducer 并确认 GREEN**

固定投影标签：start=`理解需求`；command=`执行命令`；file_change=`修改文件`；mcp=`调用工具`；other=`执行操作`；waiting=`等待你的输入`。这些是事件类型映射，不从操作数量计算百分比。

timeline 压缩规则：同 label 相邻合并并累加 count；新增第五项时保留第一项与最近三项；terminal 将 current 改为 completed/failed 并冻结。

Run: `pnpm test -- test/reducer.test.ts`

Expected: PASS。

- [ ] **Step 4: 先写 CardKit renderer 失败测试**

测试 v2 schema、运行/等待/四种终态 header、最多四项、details count、240 字 narrative、不出现 raw 字段、无臆造百分比/ETA、无按钮协议。

Run: `pnpm test -- test/card.test.ts`

Expected: FAIL，renderer 尚不存在。

- [ ] **Step 5: 在一个 `card.ts` 中实现小型纯函数组装**

卡片根结构固定为：

```ts
return {
  schema: '2.0',
  config: { update_multi: true },
  header: {
    template: headerTemplate(state.phase),
    title: { tag: 'plain_text', content: headerTitle(state.phase, locale) },
  },
  body: {
    direction: 'vertical',
    elements: [
      ...timelineElements(state.timeline),
      detailsElement(state.operationCount, locale),
    ].filter((value): value is Record<string, unknown> => value !== undefined),
  },
};
```

组件函数留在同文件：`headerTemplate`、`headerTitle`、`timelineElements`、`detailsElement`。首版不创建 components 目录、卡片 DSL、停止按钮或百分比组件。

- [ ] **Step 6: 导出固定入口并验证构建产物**

`src/turn-progress/index.ts` 只导出一个 object：

```ts
import { initialState, reduce } from '../reducer.js';
import { render } from '../card.js';

export default {
  schemaVersion: 1 as const,
  initialState,
  reduce,
  render,
};
```

Run:

```bash
pnpm check
test -f dist/turn-progress/index.js
test "$(find src -type f | wc -l | tr -d ' ')" = "3"
```

Expected: 全部退出 0；`src/` 只有三份文件。

- [ ] **Step 7: 提交独立插件**

```bash
git init -b main
git add package.json pnpm-lock.yaml tsconfig.json src test .gitignore README.md
git commit -m "feat: add semantic progress card plugin"
```

## Task 10: Core + 插件集成、回归与分阶段启用

**Files:**

- Modify only if tests expose a real defect: files owned by Tasks 1–9
- Verify: `src/setup/lark-scopes.json`
- Runtime config: BotMux plugin registry and the two Bot plugin bindings

- [ ] **Step 1: 安装 linked plugin 并验证 discovery**

先构建 Core，再从 Core worktree 执行：

```bash
pnpm build
pnpm --dir /Users/bytedance/AiProjects/botmux-plugin-semantic-progress check
node dist/cli.js plugin install /Users/bytedance/AiProjects/botmux-plugin-semantic-progress --link
node dist/cli.js plugin list
```

Expected: `semantic-progress` 显示 installed，贡献中能看到 `turn-progress/index.js`；不得出现 service/CLI/MCP/dashboard/skill。

- [ ] **Step 2: 运行全量自动验证**

```bash
pnpm vitest run --project unit \
  test/turn-progress-protocol.test.ts \
  test/turn-progress-plugin-runtime.test.ts \
  test/lark-cardkit-client.test.ts \
  test/turn-progress-host.test.ts \
  test/turn-progress-eligibility.test.ts \
  test/turn-progress-worker-routing.test.ts \
  test/turn-progress-final-delivery.test.ts \
  test/codex-app-runner.integration.test.ts \
  test/worker-codex-app-turn-routing.integration.test.ts \
  test/traex-transcript.test.ts \
  test/worker-traex-progress-routing.test.ts
pnpm test
pnpm build
```

Expected: 全部 PASS。

- [ ] **Step 3: 做架构卫生审查**

```bash
rg -n "AI马仔|马仔二号|理解需求|执行命令|修改文件|等待你的输入" src
rg -n "cardkit.*(read|batch|element)|batchUpdate|cardElement" src/core/turn-progress src/im/lark/client.ts
rg -n "botmux/src" /Users/bytedance/AiProjects/botmux-plugin-semantic-progress/src
find /Users/bytedance/AiProjects/botmux-plugin-semantic-progress/src -type f -print | sort
git diff --check HEAD~8..HEAD
```

Expected:

- 第一条在 Core `src/` 无产品文案命中；
- 第二条无新增 read/batch/element 调用；
- 第三、四条证明无私有 Core import，且插件 `src/` 恰好只有 `card.ts`、`reducer.ts`、`turn-progress/index.ts`；
- diff 无空白错误。

- [ ] **Step 4: 只给 AI马仔启用并刷新 worker generation**

```bash
node dist/cli.js plugin enable semantic-progress --bot AI马仔
```

关闭或重启 AI马仔的测试 session，使新 generation 重新生成 session plugin manifest。检查 manifest 中只有当前冻结 plugin IDs，不依赖 Dashboard 热切换。

- [ ] **Step 5: AI马仔真机验收**

执行：短回答；命令 + 文件修改；MCP；ordered steer；显式 `botmux send`；用户停止；失败；长 final；daemon 重启恢复。每例记录 card entity create 次数、IM message ID、CardKit sequence、final delivery 分支和 reaction 目标。

通过条件：一个实际执行单元一张卡；ordered steer 不增卡；无 raw command/output/reasoning；canonical final 原卡收尾；primary 用户消息 `✅`；模糊 update 不 fresh 双发；特殊路径无行为变化。

- [ ] **Step 6: 再给马仔二号启用并验收 TRAE**

```bash
node dist/cli.js plugin enable semantic-progress --bot 马仔二号
```

刷新其 worker generation，执行：短回答；command/patch/MCP；TRAE TUI prompt waiting/resume；停止；失败；daemon 重启。确认未启用 `codexRpcInput`，同一个 rollout cursor 同时产 final 与 progress facts。

- [ ] **Step 7: 最终 Review 与提交修订**

按 `requesting-code-review` 和 `verification-before-completion` 技能审查：设计逐条覆盖、特殊交付回归、模糊提交幂等、session restore、插件边界、代码行数与重复逻辑。修复只针对实锤缺陷，修复后重跑 Step 2。

Core 或插件若有集成修订，先用 `git status --short` 核对真实改动，再逐文件暂存本功能文件并分别提交为 `fix: close semantic progress integration gaps` 或 `fix: harden semantic progress projection`；禁止 `git add .`。

## 完成门槛

- 未绑定插件的 Bot 自动测试与真机行为零变化。
- Core 只有通用事实、单数贡献点、两个 CardKit adapter、统一资格判断和 delivery host；没有产品布局文案。
- 插件 `src/` 恰好三个文件，所有产品投影都在独立仓库。
- Codex App 与 TRAE 共用同一 plugin reducer/render；provider reader 各自只归一化一次。
- 普通飞书 IM final 在成功、明确永久失败、429/5xx、timeout/响应不明确、daemon restart 下不丢失、不重复。
- HTTP、doc comment、VC、substitute、managed/silent、显式 `botmux send` 保持既有交付语义。
- `pnpm test`、`pnpm build`、插件 `pnpm check` 和两个 Bot 真机验收全部通过。

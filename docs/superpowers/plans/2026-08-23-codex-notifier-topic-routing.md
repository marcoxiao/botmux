# Codex Notifier 飞书话题路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Codex App/CLI 完成通知按原生 `threadId` 收敛到“马仔工作台”中的独立飞书话题，并让普通 Codex App 完成卡可安全接管回同一个原生任务。

**Architecture:** Hook 与 Side Chat monitor 在 outbox 入队时冻结 `targetBotAppId + targetChatId?`。目标 daemon 通过 notifier 专用 `delivery.ts` 和有界 `topic-route-store.ts` 完成群根卡/话题回复/私聊告警，`daemon.ts` 只负责装配与接管；Dashboard 复用现有 `/api/groups?refresh=1` 和 HMAC daemon IPC 做实时群选择与 `isInChat` 保存校验。

**Tech Stack:** TypeScript、Node.js、React、Vitest、飞书 IM v1、BotMux Host HMAC daemon IPC、原子 JSON 本地 Store。

---

## 文件结构

- `src/global-config.ts`：持久化可选 `targetChatId`，不引入目的地枚举框架。
- `src/features/codex-notifier/config.ts`：向 Hook/Side Chat monitor 暴露解析后的冻结目的地。
- `src/features/codex-notifier/outbox.ts`：把 `targetChatId?` 与 Bot 一起写入严格解析的 outbox item。
- `src/features/codex-notifier/hook-cli.ts`：普通 Codex turn 入队时传入当前 `targetChatId`。
- `src/features/codex-notifier/side-conversation-monitor.ts`：Side Chat pending 队列同样冻结目的地。
- `src/features/codex-notifier/paths.ts`：生成按 Bot 隔离的话题路由文件路径。
- `src/features/codex-notifier/topic-route-store.ts`：只负责路由查询、绑定、失效和有界淘汰。
- `src/features/codex-notifier/delivery.ts`：只负责 DM、群根卡、话题回复和无接管降级卡的投递决策。
- `src/features/codex-notifier/card.ts`：增加告警型降级卡；现有 Side Chat 卡保持仅结果行为。
- `src/features/codex-notifier/event.ts`：为降级私聊派生独立稳定 UUID，避免与群发送跨目标碰撞。
- `src/features/codex-notifier/index.ts`：只导出 notifier 内需要装配和测试的公开符号。
- `src/daemon.ts`：装配 Store/Coordinator；入口传入冻结 `targetChatId`；群接管使用权威路由根消息。
- `src/dashboard/settings-write-applier.ts`：解析 `targetChatId` 并在写入前请求目标 daemon 复核成员关系。
- `src/dashboard.ts`：设置快照、目标 Bot 校验和现有 daemon IPC 的生产注入。
- `src/dashboard/web/settings-page.tsx`：通知位置下拉框、实时群加载、离线/mention-mode 警告。
- `src/dashboard/web/i18n.ts`：中英文设置文案。
- `test/codex-notifier-*.test.ts`、`test/settings-write-applier.test.ts`：聚焦回归测试。

### Task 1: 冻结配置与 outbox 目的地

**Files:**
- Modify: `src/global-config.ts`
- Modify: `src/features/codex-notifier/config.ts`
- Modify: `src/features/codex-notifier/outbox.ts`
- Modify: `src/features/codex-notifier/hook-cli.ts`
- Modify: `src/features/codex-notifier/side-conversation-monitor.ts`
- Test: `test/codex-notifier-outbox.test.ts`
- Test: `test/codex-notifier-hook.test.ts`
- Test: `test/codex-notifier-side-conversation.test.ts`

- [ ] **Step 1: 写出目的地冻结失败测试**

```ts
it('freezes targetChatId together with the first target bot', () => {
  const path = enqueueCodexNotifierEvent(dataDir, 'cli_first', event, 'oc_old');
  enqueueCodexNotifierEvent(dataDir, 'cli_second', event, 'oc_new');
  expect(readCodexNotifierOutboxItem(path)).toMatchObject({
    targetBotAppId: 'cli_first',
    targetChatId: 'oc_old',
  });
});

it('keeps an absent targetChatId as an explicit DM destination', () => {
  const path = enqueueCodexNotifierEvent(dataDir, 'cli_target', event);
  expect(readCodexNotifierOutboxItem(path)).not.toHaveProperty('targetChatId');
});
```

Hook 和 Side Chat 测试分别断言 `enqueue(..., config.targetChatId)`；Side Chat 的内存 pending item 必须保留产生事件时的 `targetChatId`，不能 flush 时重新读取配置。

- [ ] **Step 2: 运行测试确认先失败**

Run: `pnpm vitest run --project unit test/codex-notifier-outbox.test.ts test/codex-notifier-hook.test.ts test/codex-notifier-side-conversation.test.ts`

Expected: FAIL，`targetChatId` 尚未进入配置或 outbox item。

- [ ] **Step 3: 实现最小配置与 outbox 字段**

```ts
export interface CodexNotifierGlobalConfig {
  enabled?: boolean;
  targetBotAppId?: string;
  targetChatId?: string;
  notifyWhen?: CodexNotifierNotifyWhen;
}

export interface CodexNotifierOutboxItem {
  schemaVersion: 1;
  targetBotAppId: string;
  targetChatId?: string;
  clientSurface?: CodexClientSurface;
  conversationKind?: CodexConversationKind;
  event: PersistedCodexNotifierEvent;
}

export function enqueueCodexNotifierEvent(
  dataDir: string,
  targetBotAppId: string,
  event: CodexTaskCompletedEvent,
  targetChatId?: string,
): string;
```

`parseCodexNotifierOutboxItem` 只接受非空、长度不超过 256 的可选 `targetChatId`；旧 item 缺少字段时仍解析为 DM。发布文件仍使用现有硬链接排他写入，使同一 eventId 的第一个 Bot 和 Chat 同时冻结。

- [ ] **Step 4: 运行聚焦测试确认通过**

Run: `pnpm vitest run --project unit test/codex-notifier-outbox.test.ts test/codex-notifier-hook.test.ts test/codex-notifier-side-conversation.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add src/global-config.ts src/features/codex-notifier/config.ts src/features/codex-notifier/outbox.ts src/features/codex-notifier/hook-cli.ts src/features/codex-notifier/side-conversation-monitor.ts test/codex-notifier-outbox.test.ts test/codex-notifier-hook.test.ts test/codex-notifier-side-conversation.test.ts
git commit -m "feat(notifier): freeze lark destination in outbox"
```

### Task 2: 有界、原子的话题路由 Store

**Files:**
- Modify: `src/features/codex-notifier/paths.ts`
- Create: `src/features/codex-notifier/topic-route-store.ts`
- Modify: `src/features/codex-notifier/index.ts`
- Create: `test/codex-notifier-topic-route-store.test.ts`

- [ ] **Step 1: 写路由生命周期失败测试**

```ts
it('isolates the same Codex thread by destination chat', () => {
  const store = new CodexNotifierTopicRouteStore(file, 2);
  store.bind({ threadId: 'thread-1', chatId: 'oc_a', rootMessageId: 'om_a' }, 1);
  store.bind({ threadId: 'thread-1', chatId: 'oc_b', rootMessageId: 'om_b' }, 2);
  expect(store.get('thread-1', 'oc_a')?.rootMessageId).toBe('om_a');
  expect(store.get('thread-1', 'oc_b')?.rootMessageId).toBe('om_b');
});

it('persists atomically with mode 0600 and evicts the least recently updated route', () => {
  const store = new CodexNotifierTopicRouteStore(file, 2);
  store.bind({ threadId: 't1', chatId: 'oc', rootMessageId: 'om1' }, 1);
  store.bind({ threadId: 't2', chatId: 'oc', rootMessageId: 'om2' }, 2);
  store.bind({ threadId: 't3', chatId: 'oc', rootMessageId: 'om3' }, 3);
  expect(store.get('t1', 'oc')).toBeUndefined();
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(new CodexNotifierTopicRouteStore(file, 2).get('t3', 'oc')).toBeDefined();
});
```

另测：严格 schema、重复 key 覆盖、`invalidate(threadId, chatId)` 只删除精确路由、返回值深拷贝。

- [ ] **Step 2: 运行测试确认先失败**

Run: `pnpm vitest run --project unit test/codex-notifier-topic-route-store.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现单一职责 Store**

```ts
export interface CodexNotifierTopicRoute {
  threadId: string;
  chatId: string;
  rootMessageId: string;
  updatedAt: string;
}

export class CodexNotifierTopicRouteStore {
  constructor(filePath: string, maxEntries = 1000);
  get(threadId: string, chatId: string): CodexNotifierTopicRoute | undefined;
  bind(route: Omit<CodexNotifierTopicRoute, 'updatedAt'>, now?: number): CodexNotifierTopicRoute;
  invalidate(threadId: string, chatId: string): boolean;
}
```

Store 使用 `atomicWriteFileSync(..., { mode: 0o600, durable: true, followTargetSymlink: false })`，key 仅为 `chatId + threadId`；文件由 `codexNotifierTopicRoutesPath(dataDir, larkAppId)` 使用 App ID SHA-256 前 16 位隔离。不要复用事件账本或会议话题 Store。

- [ ] **Step 4: 运行聚焦测试确认通过**

Run: `pnpm vitest run --project unit test/codex-notifier-topic-route-store.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add src/features/codex-notifier/paths.ts src/features/codex-notifier/topic-route-store.ts src/features/codex-notifier/index.ts test/codex-notifier-topic-route-store.test.ts
git commit -m "feat(notifier): persist bounded lark topic routes"
```

### Task 3: 群话题投递协调器与告警降级卡

**Files:**
- Modify: `src/features/codex-notifier/event.ts`
- Modify: `src/features/codex-notifier/card.ts`
- Create: `src/features/codex-notifier/delivery.ts`
- Modify: `src/features/codex-notifier/index.ts`
- Create: `test/codex-notifier-delivery.test.ts`
- Modify: `test/codex-notifier.test.ts`

- [ ] **Step 1: 写根卡、回复、并发和降级失败测试**

```ts
it('creates one root then replies later turns into the same native thread', async () => {
  sendMessage.mockResolvedValueOnce('om_root');
  replyMessage.mockResolvedValueOnce('om_reply');
  const coordinator = createCoordinator();
  await coordinator.deliver(firstEvent, 'oc_workbench');
  await coordinator.deliver(secondEventSameThread, 'oc_workbench');
  expect(sendMessage).toHaveBeenCalledWith('oc_workbench', expect.any(String), 'interactive', expect.any(String));
  expect(replyMessage).toHaveBeenCalledWith('om_root', expect.any(String), 'interactive', true, expect.any(String));
});

it('serializes concurrent first deliveries for the same bot/chat/thread', async () => {
  await Promise.all([
    coordinator.deliver(firstEvent, 'oc_workbench'),
    coordinator.deliver(secondEventSameThread, 'oc_workbench'),
  ]);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(replyMessage).toHaveBeenCalledTimes(1);
});

it('falls back to an alert-only DM and keeps the route on unknown reply errors', async () => {
  replyMessage.mockRejectedValueOnce(new Error('timeout'));
  const result = await coordinator.deliver(event, 'oc_workbench');
  expect(result.destination).toBe('fallback_dm');
  expect(resultCard).not.toContain('codex_notifier_continue');
  expect(routeStore.get(event.threadId, 'oc_workbench')).toBeDefined();
});
```

另测：无 `targetChatId` 只走现有管理员 DM；`MessageWithdrawnError` 精确失效路由且本事件不重建根；不同 chat/thread 并行；群 UUID 与 fallback DM UUID 不同且稳定；Side Chat 卡不出现动作。

- [ ] **Step 2: 运行测试确认先失败**

Run: `pnpm vitest run --project unit test/codex-notifier-delivery.test.ts test/codex-notifier.test.ts`

Expected: FAIL，协调器与降级卡尚不存在。

- [ ] **Step 3: 实现最小协调器**

```ts
export interface CodexNotifierDeliveryResult {
  messageId: string;
  destination: 'dm' | 'group' | 'fallback_dm';
}

export class CodexNotifierDeliveryCoordinator {
  async deliver(event: CodexTaskCompletedEvent, targetChatId?: string): Promise<CodexNotifierDeliveryResult>;
}
```

实现规则：

1. DM 继续调用 `sendUserMessage`。
2. 群路由不存在时 `sendMessage(chatId, card, 'interactive', eventUuid)`，成功后绑定根 ID。
3. 群路由存在时 `replyMessage(rootMessageId, card, 'interactive', true, eventUuid)`。
4. Promise 门闩 key 为 `${larkAppId}:${chatId}:${threadId}`，finally 后删除。
5. `MessageWithdrawnError` 才失效路由；超时、限流和未知错误保留路由。
6. 群错误改发 `buildCodexNotifierDeliveryFailureCard`，不含 continue；fallback 使用独立 `codexNotifierFallbackMessageUuid(eventId)`。
7. fallback 成功即返回 `fallback_dm`；其 messageId 由事件账本记录为实际可信卡片。

- [ ] **Step 4: 运行聚焦测试确认通过**

Run: `pnpm vitest run --project unit test/codex-notifier-delivery.test.ts test/codex-notifier.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add src/features/codex-notifier/event.ts src/features/codex-notifier/card.ts src/features/codex-notifier/delivery.ts src/features/codex-notifier/index.ts test/codex-notifier-delivery.test.ts test/codex-notifier.test.ts
git commit -m "feat(notifier): deliver completions into lark topics"
```

### Task 4: daemon 装配与群话题安全接管

**Files:**
- Modify: `src/daemon.ts`
- Test: `test/codex-notifier-card-action.test.ts`
- Test: `test/codex-notifier-adopt-race.test.ts`
- Create: `test/codex-notifier-topic-adoption.test.ts`

- [ ] **Step 1: 写群接管边界失败测试**

```ts
it('binds a later completion card to the authoritative topic root', async () => {
  routeStore.bind({ threadId: event.threadId, chatId: 'oc_workbench', rootMessageId: 'om_root' });
  getMessageChatId.mockResolvedValue('oc_workbench');
  getChatModeStrict.mockResolvedValue('group');
  await adoptEvent(APP_ID, event, 'om_later_card', OWNER, signal, deadline);
  expect(createSession).toHaveBeenCalledWith(
    'oc_workbench', 'om_root', expect.any(String), 'group', 'thread',
  );
});

it('fails closed when a group card has no matching route', async () => {
  getMessageChatId.mockResolvedValue('oc_workbench');
  getChatModeStrict.mockResolvedValue('group');
  await expect(adoptEvent(APP_ID, event, 'om_card', OWNER, signal, deadline))
    .rejects.toThrow('话题路由已过期');
});
```

另测：卡片实际 chat 与路由 chat 不同拒绝；`getChatModeStrict='unknown'` 拒绝；DM 保持原 `p2pMode`；Side Chat 仍在 card-action 层拒绝；非管理员与非精确 messageId 继续拒绝。

- [ ] **Step 2: 运行测试确认先失败**

Run: `pnpm vitest run --project unit test/codex-notifier-card-action.test.ts test/codex-notifier-adopt-race.test.ts test/codex-notifier-topic-adoption.test.ts`

Expected: FAIL，当前接管固定创建 `chatType='p2p'` 并以点击卡片为锚点。

- [ ] **Step 3: 装配投递与权威接管目的地**

`/api/codex-notifier/events` 把解析后的 `item.targetChatId` 传给 `respondCodexNotifierIngress`，后者传给 `deliverCodexNotifierEvent`。daemon 按 Bot 创建一个 Route Store 和一个 Delivery Coordinator，事件级 `codexNotifierDeliveries` 去重保持不变。

接管使用以下唯一分支：

```ts
const cardChatId = await getMessageChatId(larkAppId, cardMessageId, options);
const chatMode = await getChatModeStrict(larkAppId, cardChatId);
if (chatMode === 'unknown') throw new Error('无法确认完成通知所在会话');

if (chatMode === 'p2p') {
  // 沿用现有 p2pMode 推导 scope/anchor/chatType。
} else {
  const route = codexNotifierTopicRouteStore(larkAppId).get(event.threadId, cardChatId);
  if (!route) throw new Error('话题路由已过期，请等待下一条完成通知');
  destination = {
    chatId: cardChatId,
    anchor: route.rootMessageId,
    scope: 'thread',
    chatType: 'group',
  };
}
```

创建会话时调用 `createSession(chatId, anchor, title, chatType, scope)`；传给 `startCodexNotifierAdoptionSession` 的回执锚点也是 `anchor`。点击卡片 ID 仍只由事件账本做来源校验，不成为群接管锚点。

- [ ] **Step 4: 运行聚焦测试确认通过**

Run: `pnpm vitest run --project unit test/codex-notifier-card-action.test.ts test/codex-notifier-adopt-race.test.ts test/codex-notifier-topic-adoption.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add src/daemon.ts test/codex-notifier-card-action.test.ts test/codex-notifier-adopt-race.test.ts test/codex-notifier-topic-adoption.test.ts
git commit -m "feat(notifier): adopt codex tasks from lark topic roots"
```

### Task 5: Dashboard 原生群选择与保存校验

**Files:**
- Modify: `src/dashboard/settings-write-applier.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/dashboard/web/settings-page.tsx`
- Modify: `src/dashboard/web/i18n.ts`
- Test: `test/settings-write-applier.test.ts`
- Test: `test/codex-notifier-settings-ui.test.ts`

- [ ] **Step 1: 写保存与 UI 失败测试**

```ts
it('revalidates target chat membership before saving', async () => {
  const deps = makeDeps({
    validateCodexNotifierTargetBotAppId: vi.fn(async (_appId, options) =>
      options?.targetChatId === 'oc_member'
        ? { ok: true }
        : { ok: false, error: 'codexNotifier_target_chat_unavailable' }),
  });
  expect(await applySettingsWrite({
    codexNotifier: { targetChatId: 'oc_member' },
  }, deps)).toMatchObject({ ok: true });
});

it('switches bots by clearing the old group and never accepts free-form chat ids', async () => {
  const loadGroups = vi.fn(async () => [{ chatId: 'oc_workbench', name: '马仔工作台' }]);
  const onSave = vi.fn(async () => undefined);
  const { renderer } = renderEditor(
    configuredValue({ targetChatId: 'oc_old' }),
    onSave,
    loadGroups,
  );
  await act(async () => undefined);
  expect(JSON.stringify(renderer.toJSON())).toContain('马仔工作台');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('chatId');

  const botMenu = renderer.root.findByProps({ 'aria-label': '通知 Bot' });
  const nextBot = botMenu.parent!.findAllByType('button')
    .find(button => JSON.stringify(button.props.children).includes('Codex 二号'))!;
  act(() => { nextBot.props.onClick({}); });
  expect(onSave).toHaveBeenCalledWith({
    targetBotAppId: 'cli_second',
    targetChatId: null,
  });
});
```

另测：目标 daemon 离线不能保存新的群；不是成员返回明确错误；DM 用 `targetChatId: null`；`regularGroupMentionMode !== 'topic'` 显示警告但不自动修改；群列表加载失败不影响现有配置展示。

- [ ] **Step 2: 运行测试确认先失败**

Run: `pnpm vitest run --project unit test/settings-write-applier.test.ts test/codex-notifier-settings-ui.test.ts`

Expected: FAIL，设置模型和 UI 尚无通知位置。

- [ ] **Step 3: 实现最小设置链路**

设置快照增加：

```ts
codexNotifier: {
  targetChatId: string | null;
  botOptions: Array<{
    larkAppId: string;
    botName: string | null;
    cliId: string;
    recipientConfigured: boolean;
    recipientVerified: boolean;
    recipientHint: string | null;
    regularGroupMentionMode: 'always' | 'topic' | 'never' | 'ambient';
  }>;
}
```

设置写入规则：

```ts
validateCodexNotifierTargetBotAppId(appId, {
  requireReady: next.enabled === true || targetChatChanged,
  targetChatId: next.targetChatId,
});
```

生产校验通过 `registry.getByAppId(appId)` 找目标 daemon，再用现有 `fetchDaemonIpc` 请求 `/api/groups/:chatId/membership`；只有 HTTP 200 且 `{ inChat: true }` 才允许保存。

UI 增加 `loadGroups?: (appId: string) => Promise<Array<{ chatId: string; name: string }>>` 测试缝，默认实现读取现有 `/api/groups?refresh=1`，只保留 `memberBots` 中目标 Bot `inChat=true` 的群。通知位置下拉只有“管理员私聊”和返回的群；不渲染文本输入。目标 Bot 切换时一次保存 `{ targetBotAppId, targetChatId: null }`。

- [ ] **Step 4: 补齐中英文文案并运行聚焦测试**

Run: `pnpm vitest run --project unit test/settings-write-applier.test.ts test/codex-notifier-settings-ui.test.ts`

Expected: PASS，且中文包含“通知位置”“管理员私聊”“仅话题内不需要 @”。

- [ ] **Step 5: 提交本任务**

```bash
git add src/dashboard/settings-write-applier.ts src/dashboard.ts src/dashboard/web/settings-page.tsx src/dashboard/web/i18n.ts test/settings-write-applier.test.ts test/codex-notifier-settings-ui.test.ts
git commit -m "feat(dashboard): configure notifier lark topic destination"
```

### Task 6: 回归验证与本机配置

**Files:**
- Modify only if tests expose an in-scope defect.

- [ ] **Step 1: 运行全部 notifier 与设置测试**

Run:

```bash
pnpm vitest run --project unit \
  test/codex-notifier*.test.ts \
  test/settings-write-applier.test.ts
```

Expected: PASS；不得通过放宽断言或删除既有测试解决失败。

- [ ] **Step 2: 运行完整单测、类型检查和构建**

Run:

```bash
pnpm test
pnpm build
git diff --check
```

Expected: 全部退出码 0。

- [ ] **Step 3: 深度 Review 方案覆盖与代码卫生**

逐项确认：冻结目的地不读取投递时配置；Route Store 不保存正文；Side Chat 无按钮；fallback 无 continue；群接管必须存在精确 route；daemon 没有复制 Store 逻辑；Dashboard 没有任意 chatId 输入；Trae 没有新适配分支；没有把 `allowedChatGroups` 当成员关系。

- [ ] **Step 4: 构建并重启当前 BotMux**

Run:

```bash
pnpm switch:here
botmux restart
botmux status
```

Expected: 两个现有机器人 daemon 均在线，Dashboard 可打开；不启动第三套服务。

- [ ] **Step 5: 在 Dashboard 完成真实配置**

选择 Codex 通知 Bot，将 `regularGroupMentionMode` 明确设为“仅话题内不需要 @”，再在 Codex 通知设置选择“马仔工作台”。不要修改马仔二号的 Trae 配置。

- [ ] **Step 6: 真机验收**

1. Codex App 同一任务完成两轮：一个话题、两张卡。
2. 新 Codex App 任务完成：新话题。
3. 点击第二张普通完成卡后直接在话题回复：进入原任务且无需 `@`。
4. 在话题中 `@马仔二号`：Codex Bot 不抢答。
5. Side Chat 完成卡只有结果，无接管按钮。
6. 关闭 Codex App 后话题回复：明确离线、不排队。
7. 马仔二号现有 Trae 托管会话不受影响。

- [ ] **Step 7: 提交仅由最终验证产生的修复**

```bash
git status --short
git diff --check
git commit -m "fix(notifier): close topic routing review gaps"
```

若 Step 3 未产生代码修复，则跳过空提交。

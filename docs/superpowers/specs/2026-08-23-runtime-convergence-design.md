# BotMux 双机器人运行时收敛设计

## 目标

保留一套 BotMux 同时承载两个飞书应用的部署方式：Codex App 机器人与 TRAE 机器人各自拥有独立 daemon、身份、会话和插件配置，共享代码、Dashboard 与宿主资源。修复当前影响跨端可靠性的三个已复现问题，不引入第二套服务或新的兼容层。

## 方案选择

评估过三种部署形态：

1. **一套 BotMux、两个独立 daemon（采用）**：升级与运维入口统一，应用身份和会话仍隔离；最符合 BotMux 原生多 Bot 模型。
2. 两套完全独立 BotMux：故障域更小，但配置、升级、Dashboard、端口和日志全部重复，当前规模没有收益。
3. 一个飞书机器人动态切换 Codex/TRAE：交互和会话归属容易混淆，也破坏现有用户心智。

## 收敛范围

### 1. Side Chat 候选发现

Codex Desktop 的普通任务和 Side Chat 都可能生成 `visualizations/<date>/<threadId>`。普通任务同时会在 `sessions/<date>` 下生成同 ID 的 rollout；Side Chat 不落 rollout。

监听器只订阅满足以下条件的候选：

- visualization 目录是最近两天内的 UUID 线程；
- 同期 sessions 目录没有同 ID rollout；
- 新候选已经过短暂稳定窗口，使普通任务有时间创建 rollout。

每轮扫描都重新计算候选集合。某个已订阅线程一旦出现 rollout，立即取消订阅并加入本连接的忽略集合。帧上限保持不变；放大上限只会掩盖错误订阅。

### 2. Hook 真实健康

`hooks.json` 中存在命令只代表“已配置”，不能代表 Codex 会执行。健康检查通过 Codex App Server 原生 `hooks/list` 查询两个 BotMux Hook：

- `userPromptSubmit`
- `stop`

输出区分：`trusted`、`untrusted`、`disabled`、`missing`、`unavailable`。CLI 每次状态查询实时探测；Dashboard 使用短周期缓存，避免每次页面请求都拉起 app-server。探测只读，不调用 `config/batchWrite`，不自动授权。

### 3. 原生任务标题归属

BotMux 只给自己新建的 Codex App thread 设置 `[BotMux·Lark]` 标题。用户从工作台选择一个已有原生 thread 时，切换事务必须同时清空旧的 `nativeSessionTitle`、用户标题标记和待生成标记。后续 resume 不携带 BotMux 标题，因此不会覆盖原生任务名称。

## 双机器人边界

- Codex Desktop 通知只发送给 `codexNotifier.targetBotAppId`，不会广播给 TRAE 机器人。
- 插件按 Bot 配置启用；AI 机器人先验收 `semantic-progress`，TRAE 机器人在独立真机验收后再启用。
- 默认工作区可以统一为 `/Users/bytedance/AiProjects`，实际会话仍固定到各自选择的仓库目录。
- 两个飞书应用的凭证、owner allowlist、群白名单和会话账本不得互相复制。

## 错误处理与运维

- rollout 扫描失败时跳过本轮候选，不扩大订阅范围。
- App Server 探测失败显示 `unavailable` 与简短错误，不影响机器人基础收发消息。
- 健康检查不写 Codex 配置；授权仍由用户在 Codex 原生界面完成。
- 修复完成后先自动验证，再重启当前 checkout；Codex 与 TRAE 分别做真机验收。

## 验收标准

1. 已有普通大任务不会被 Side Chat monitor `follow`，Dashboard 不再每两秒输出超大帧错误。
2. Hook 未信任时状态明确为 `untrusted`，不能显示为健康。
3. 接管已有 Codex App thread 后，其原生标题保持不变。
4. 两个 daemon 同时在线；Codex 通知只进入配置的 Codex 机器人。
5. 聚焦测试、完整构建和 `git diff --check` 通过。

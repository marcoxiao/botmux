# Desktop Handoff Message Bridge Implementation Plan

**Goal:** 显式接管后的飞书话题文本可靠写入同一个本地 Codex Desktop thread，最终结果回到同一 CardKit 话题。

**Architecture:** Core 只增加通用 Lark 插件消息认领；本地 stdio Desktop 的 owner/follower IPC、route 与 CardKit 全部在独立插件。上游 Shared Adopt 保留给 WebSocket App Server 拓扑。

## Task 1: Core 通用消息认领

- [x] 增加规范化 `LarkPluginMessageContext` 与可选 `handleMessage`。
- [x] 只在真实人类、talkAllowed、真实话题和消息去重后调用。
- [x] 首个 handled 停止原生路由，异常传播且不静默 fallback。
- [x] 无 Codex IPC、route 或 provider 业务进入 Core。

## Task 2: 插件 Desktop IPC 与 route

- [x] 实现本机 length-prefixed JSON IPC client。
- [x] 校验 Unix socket 类型、同 UID、帧上限、超时和 pending 清理。
- [x] 实现 owner discovery 与 follower start turn。
- [x] route 生命周期独立于短期 event 清理，根撤回时清理。

## Task 3: CardKit 闭环

- [x] 接管成功前必须探测当前 Desktop owner。
- [x] 已知根话题对未接管、非 owner、空文本和离线 fail-closed。
- [x] 目标 threadId 只来自账本，飞书 messageId 作为原生幂等 ID。
- [x] 完成结果与错误卡都回复同一根 CardKit 话题。

## Task 4: 上游合并与自动回归

- [x] 合并最新 `upstream/master`，无业务冲突。
- [x] Core 插件路由、Shared Adopt、关闭语义和 build 回归。
- [x] 插件全测、build、CardKit 与 IPC 边界回归。
- [x] `git diff --check` 通过。

## Task 5: 安装与真实双端验收

- [ ] 合并功能分支到 `codex-office` 和插件 `main`。
- [ ] 写入两项非敏感插件配置，链接安装并重启 BotMux。
- [ ] 根卡到达、按钮接管、飞书文本进入原 Desktop thread。
- [ ] Desktop 最终结果回到同一话题。
- [ ] Desktop 离线时不排队、不创建替代 Session。

## Task 6: 深度 Review

- [ ] 修复所有 Critical/Important finding。
- [ ] 核对不存在第二飞书连接、影子 Session、私有 Core 分支和敏感日志。
- [ ] 记录未执行/环境失败项，不把未验证能力宣称为通过。

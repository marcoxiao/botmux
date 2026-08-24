# Desktop Handoff

BotMux 的 Codex/TraeX Desktop 双端协同插件：一个 Desktop 会话对应「马仔工作台」中的一个飞书 CardKit 话题。所有者显式接管后，话题文本通过 Desktop 原生 owner/follower IPC 写回同一个会话，最终结果再回复到同一话题。

插件复用 BotMux 的飞书连接、权限校验和 CardKit transport，不持有飞书凭证，不创建影子 Session，也不提供离线队列。普通 BotMux 会话、Web Terminal、Semantic Progress 和其他机器人不受影响。

## 架构边界

- Codex Bot 只对应 Codex Desktop，固定使用 `~/.codex/ipc/ipc.sock`。
- TraeX Bot 只对应 TraeX Desktop，固定使用 `~/.trae/cli/ipc/ipc.sock`。
- 路由身份为 `larkAppId + provider + threadId`；相同 thread ID 也不会跨 Bot 串线。
- 飞书只按已登记的 CardKit 根消息/thread alias 进入插件；同群里的普通新话题继续走 BotMux Session。
- 两个 Provider 复用同一套飞书 CardKit、账本和 IPC 协议实现，仅来源判定、socket 和产品文案不同。
- 同一 Desktop 会话同一时间只接受一个飞书轮次；忙碌、离线均明确失败且不排队。
- BotMux Worker、Session、Runner 和 CLI adapter 无业务分支；上游更新可正常合并。

## 插件配置

在插件配置中按飞书应用 ID 显式绑定 Provider。两个 Bot 可以指向同一个工作台群：

```json
{
  "bots": {
    "cli_codex": {
      "provider": "codex",
      "workbenchChatId": "oc_workbench"
    },
    "cli_traex": {
      "provider": "traex",
      "workbenchChatId": "oc_workbench"
    }
  }
}
```

必须分别在两个 Bot 上启用 `desktop-handoff` 插件。配置中不应保存飞书 App Secret；凭证仍由 BotMux 自身管理。

## Desktop Hook

使用安装器把 Hook 幂等写入 Codex 的 `~/.codex/hooks.json` 和 TraeX 的
`~/.trae/cli/hooks.json`：

```sh
pnpm hooks:install -- --codex-bot cli_codex --traex-bot cli_traex
```

安装器保留其他 Hook 及其数组位置，清除旧 `~/.trae/hooks.json` 中精确匹配的
Handoff 条目，重复执行不会重复插入。损坏或未知 JSON 结构会直接失败，不覆盖原文件。

`--best-effort` 只允许 BotMux 离线时丢弃通知，不会排队。Hook 修改后需要重启对应
Desktop App，并通过 Codex/TraeX 原生 Hook trust 流程确认命令；安装器不会伪造信任记录。
已打开的旧任务不会热加载新 Hook。

## Ledger v2 一次性迁移

旧版单 Codex 账本必须在 BotMux 停止后迁移一次：

```sh
node scripts/migrate-ledger-v2.mjs \
  --ledger ~/.botmux/plugins/desktop-handoff/desktop-handoff-ledger.json \
  --codex-app-id cli_codex
```

迁移命令只接受 v1，先在内存中校验事件、话题和引用，再通过 `0600` 临时文件原子替换。运行时只接受 v2，不保留永久兼容分支。迁移前应保留原文件快照，Codex 实机回归通过后再启用 TraeX。

## 使用方式

1. Desktop 完成一轮后，对应机器人会在工作台群创建或复用该会话的 CardKit 根话题。
2. 点击「在飞书中接管」；只有 Bot 所有者且原 Desktop 任务仍打开时才成功。
3. 在根卡话题中发送非空文本，消息进入同一个 Desktop 会话。
4. 插件只跟踪该轮原生 follower stream，完成后把最终回复写回同一 CardKit 话题并立即断开 IPC。
5. Desktop 离线、任务关闭或已有活跃轮次时，本条消息明确失败且不会排队。

「打开 Codex App」复用 BotMux 原生深链；「打开 TraeX App」只执行固定的 `/usr/bin/open -a Traex`，不宣称能精确定位到任务，也不拼接任何飞书输入。

## 当前不做

当前只桥接文本 turn，不镜像历史，不支持 Side Chat 接管，也不处理图片、文件、语音、审批和 token 级流式输出。BotMux 原生 CLI 会话、Web Terminal 和 shared-adopt 能力继续按上游方式使用，本插件只补齐本地 Desktop 内部 IPC 拓扑。

# Desktop Handoff Monorepo 整合设计

## 目标

把 Desktop Handoff 的唯一源码迁入 BotMux 仓库：

```text
botmux/
  src/
  plugins/
    desktop-handoff/
      src/
      test/
      scripts/
      package.json
      tsconfig.json
      README.md
```

插件继续作为独立 workspace package 构建和测试，继续通过 BotMux 已发布的插件协议运行。BotMux Core 不直接 import 插件业务代码；运行时安装记录只链接仓库内 `plugins/desktop-handoff/dist`，不再依赖外部仓库。

## 已确认的现状

- BotMux 当前源码位于 `/Users/bytedance/AiProjects/botmux`，运行分支为 `codex-office`。
- Desktop Handoff 当前源码位于独立仓库 `/Users/bytedance/AiProjects/botmux-plugin-desktop-handoff`，运行分支为 `main`。
- 已安装插件的 `dist` 是指向独立仓库 `dist` 的唯一软链。
- Core 与插件已经通过 `package.json.botmux`、固定 `dist/lark/index.js` 和 Host protocol 解耦；整合不需要改变协议。
- 同群普通新话题与 Handoff 根卡片回复已经实机验证为两条独立路由。验收必须核对消息 root/thread 与 claim，不能只根据回复文本判断。

## 方案选择

采用方案 A：仓库内独立 workspace package。

不采用以下方案：

- 只把源码复制到 `plugins/`，但不建立 workspace：目录看似合并，依赖、锁文件和根构建仍然分裂，不满足单一工程真相。
- 把插件编译进 Core `dist` 或由 Core 私有模块直接调用：会破坏薄插件边界，增加上游合并成本，也让插件无法按 Bot 独立启停。

## Workspace 与构建

根目录新增 `pnpm-workspace.yaml`，仅纳入 `plugins/*`。已有 `packages/workflow-core` 维持当前专用构建方式，本次不顺带改变其 workspace 身份。

插件删除独立的 `pnpm-lock.yaml`，依赖统一记录在 BotMux 根锁文件中。插件保留自己的 `package.json`、TypeScript 配置、测试和构建产物，不依赖 Core 的 `src/` 私有模块。

BotMux 根 `package.json` 增加三个明确脚本：

- `desktop-handoff:build`：构建插件。
- `desktop-handoff:test`：运行插件测试。
- `desktop-handoff:check`：构建并运行插件全量测试。

根 `build` 必须先构建 Desktop Handoff，再构建 Core。这样 `pnpm build` 产生一组一致的可部署产物，不会留下指向旧插件 `dist` 的隐性前置条件。根 `test` 暂不递归运行插件测试，避免改变现有 1.8 万余项 Core 单测的语义；发布或验收显式运行 `desktop-handoff:check`。

## 源码与文档迁移

独立仓库以下内容原样迁入 `plugins/desktop-handoff/`：

- `src/`
- `test/`
- `scripts/`
- `package.json`
- `tsconfig.json`
- `README.md`

不迁入独立仓库的 `.gitignore`、`pnpm-lock.yaml`、`dist/`、`node_modules/` 和 `.git/`。历史设计与计划文档迁入 BotMux 的 `docs/superpowers/` 对应目录，避免包目录同时承担工程决策档案。

插件包仍为 `private: true`。本次目标是仓库内单一源码和本地部署，不新增 npm 发布、自动内置、自动启用或 Core fallback。

## 安装与运行时切换

完成构建后，通过现有命令重新安装：

```sh
botmux plugin install ./plugins/desktop-handoff --link
```

安装器继续负责原子替换 `~/.botmux/plugins/desktop-handoff/dist`。切换后必须满足：

- `~/.botmux/plugins/desktop-handoff/dist` 是唯一软链。
- 软链目标精确为 `/Users/bytedance/AiProjects/botmux/plugins/desktop-handoff/dist`。
- `plugins-registry.json` 的 local source 指向仓库内 package。
- 现有插件配置、ledger、root claims 和 Hook 命令保持不变。

BotMux 重启后只允许一套 PM2 supervisor、两个 daemon 和一个 dashboard。TraeX 的会话 worker 仅由存量活跃 Session 决定，不视为重复服务。

## 旧仓库处理

整合完成后，外部独立仓库不再作为构建或运行时来源。由于删除整个 Git 仓库不可逆，本次实施先保留目录；在仓库内源码、软链、测试和实机验收全部通过后，再单独取得用户明确授权后删除。

## 错误处理与回滚

- workspace、包清单或构建失败时，不切换运行时软链。
- 插件重新安装失败时，复用 BotMux 现有原子安装回滚，不手工改 registry。
- daemon 重启失败时，保留原配置、ledger 和 claims，使用部署前备份恢复旧插件 `dist`。
- Hook trust 继续由 Codex/TraeX 原生流程管理；整合不写入或伪造 trust hash。

## 测试与验收

### 自动化

1. 新增 Core 集成测试，证明 workspace 包、根脚本、包清单和禁止嵌入 Core 的边界。
2. 迁移插件现有全量测试，包含双 Provider、root claim、Desktop IPC、Hook 安装、ledger 迁移和大型 `session_meta`。
3. 运行插件 `check`、Core 相关路由测试、Core TypeScript 检查和完整构建。
4. 检查 `git diff --check`、锁文件唯一性、构建产物和安装记录。

### 实机

1. Codex 与 TraeX Desktop 完成事件分别产生飞书根卡。
2. 同群普通新话题分别创建 BotMux Session，并返回指定结果。
3. Handoff 验收必须在原始根卡 thread 中发送；消息 ID 的 root/thread 必须命中对应 claim。
4. Codex 根卡回复只进入 Codex Desktop，TraeX 根卡回复只进入 TraeX Desktop。
5. Desktop 最终回复回到相同 root thread，ledger 标记 `delivery=delivered`。
6. claims 文件只包含 `version` 与 `claims`，不存在 `exclusiveChats`。
7. 重启后无外部仓库路径、无旧 worktree、无重复 daemon/service。

## 非目标

- 不把 Desktop Handoff 改成 Core 内建功能。
- 不新增兼容旧外部路径的 fallback。
- 不修改 CardKit、Desktop IPC 或 Hook 事件协议。
- 不扩展图片、文件、语音或离线队列。
- 不在本次顺带重构其他 workspace package。

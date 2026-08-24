# Semantic Progress Monorepo 整合设计

日期：2026-08-24

状态：方案 A 已确认，待实施计划

## 1. 结论

把 Semantic Progress 的唯一源码迁入 BotMux 仓库，作为与 Desktop Handoff 同级的独立 workspace package：

```text
botmux/
  src/                         # BotMux Core
  plugins/
    desktop-handoff/
    semantic-progress/
      src/
      test/
      package.json
      tsconfig.json
      vitest.config.ts
      README.md
```

插件继续通过 BotMux 的 `turnProgress` contribution 运行。Core 不 import 插件源码，插件也不 import Core 私有模块。本次只收敛仓库、构建和运行时来源，不改变进度卡产品语义、事件协议或飞书交付逻辑。

本设计仅替代《BotMux 语义进度卡插件设计》中“插件必须位于独立同级仓库”的物理仓库边界；该文档中的产品、SPI、一致性、安全与交付约束继续有效。

## 2. 已确认现状

- BotMux 位于 `/Users/bytedance/AiProjects/botmux`，当前分支为 `codex-office`。
- Desktop Handoff 已位于 `plugins/desktop-handoff`，并由根 workspace、锁文件和构建统一管理。
- Semantic Progress 仍位于 `/Users/bytedance/AiProjects/botmux-plugin-semantic-progress`，分支为 `main`。
- Semantic Progress 独立仓没有远程地址，共有 3 个本地提交；工作树干净。
- 已安装运行时 `~/.botmux/plugins/semantic-progress/dist` 仍链接到独立仓 `dist`。
- 两个飞书 Bot 均启用了 `semantic-progress` 与 `desktop-handoff`。
- Semantic Progress 没有运行时依赖，源码只有 reducer、CardKit renderer 和 contribution 入口，适合成为自包含 workspace package。
- BotMux 当前有用户未提交的 `CLAUDE.md` 修改与 `.superpowers/` 目录；本次不得修改、暂存或提交这些内容。

## 3. 方案选择

采用方案 A：保留历史的 monorepo workspace 导入。

导入提交以独立仓 `main` 为第二父提交，使原有 3 个提交继续存在于 BotMux Git 历史；当前文件树则落在 `plugins/semantic-progress/`。不保留 submodule、subtree 配置或永久本地 remote，因此日后只有一个仓库真相源。

不采用：

- **快照复制**：代码可运行，但独立仓删除后会丢失原始演进历史。
- **Git submodule**：继续制造双仓版本、初始化和发布协调成本，与收敛目标相反。
- **编入 Core**：破坏按 Bot 启停和薄 SPI 边界，增加上游合并成本。

## 4. 导入边界

迁入：

- `src/`
- `test/`
- `README.md`
- `package.json`
- `tsconfig.json`

不迁入：

- `.git/`
- 独立 `.gitignore`
- 独立 `pnpm-lock.yaml`
- `node_modules/`
- `dist/`

包名、插件 ID、版本和 contribution 入口保持不变：

```text
@botmux-ai/plugin-semantic-progress
semantic-progress
dist/turn-progress/index.js
```

`package.json` 增加 `private: true`，明确它是仓库内可独立构建的私有 package，而不是本次要发布到 npm 的产品。

## 5. Workspace 与构建

复用现有 `pnpm-workspace.yaml` 的 `plugins/*`，不新增 workspace 层级。

Semantic Progress 增加与 Desktop Handoff 相同的两项构建卫生：

- 构建前清理本包 `dist`，避免旧产物伪装成当前源码输出。
- 独立 `vitest.config.ts` 只匹配本包 `test/**/*.test.ts`，避免从 monorepo 根误加载 Core 测试。

BotMux 根 `package.json` 增加显式脚本：

- `semantic-progress:build`
- `semantic-progress:test`
- `semantic-progress:check`

根 `build` 在构建 Core 前依次构建两个插件，使一次构建得到一致的全部运行产物。根 `test` 仍保持 Core unit 语义，不隐式扩大为递归 workspace 测试；插件检查在发布和验收时显式执行。

根 `pnpm-lock.yaml` 增加 `plugins/semantic-progress` importer；独立锁文件不进入 monorepo。

## 6. 运行时切换

源码、锁文件、专项测试和构建全部通过后，使用 BotMux 现有原子安装器，以相同插件 ID 更新本地 link：

```sh
botmux plugin install ./plugins/semantic-progress --link
```

安装器原子替换运行时 `dist` 并 upsert registry；现有插件 settings、两个 Bot 的 enabled binding 和历史卡片不迁移、不重建。

切换后必须同时满足：

- `~/.botmux/plugins/semantic-progress/dist` 是唯一运行时软链。
- 目标精确为 `/Users/bytedance/AiProjects/botmux/plugins/semantic-progress/dist`。
- `plugins-registry.json` 的 local source 指向 monorepo package。
- 两个 Bot 仍同时启用 `semantic-progress` 与 `desktop-handoff`。
- BotMux 只运行现有 supervisor、两个 daemon 和 dashboard；Semantic Progress 不新增进程或 service。

BotMux 重启仅用于让新 generation 重新物化插件清单，不改飞书凭证、会话或 Handoff 账本。

## 7. 测试与验收

### 自动化

1. 新增 workspace 契约测试，验证包路径、`private`、贡献入口、独立测试配置、无独立锁文件和根脚本。
2. 运行 Semantic Progress 自身 reducer/card 全量测试与构建。
3. 运行 BotMux 的 turn-progress runtime、host、eligibility、worker routing、final delivery 等专项回归。
4. 运行 Desktop Handoff workspace 回归，确认第二个插件没有破坏既有构建边界。
5. 运行 BotMux 完整 build、`git diff --check`，并检查根锁文件只有预期 importer 变化。

### 运行态

1. 重启后确认插件 registry、materialized manifest 和软链全部指向 monorepo。
2. AI马仔执行一轮真实 Codex 普通路由，确认 Semantic Progress 原卡更新并正常交付 final。
3. 马仔二号执行一轮真实 TraeX 普通路由，确认同样的进度卡和 final 闭环。
4. 验证 Desktop Handoff 的 Codex/TraeX 通知与往返仍正常，两个贡献互不替代。
5. 检查没有引用旧独立仓路径、没有第二份插件运行代码、没有新增后台进程。

只有上述证据全部成立，才宣称整合完成。

## 8. 旧仓清理与恢复

验收通过后，独立仓 `/Users/bytedance/AiProjects/botmux-plugin-semantic-progress` 不再承担源码、构建或运行职责。将其移入系统废纸篓，保留可恢复性；确认运行时不再引用后，不保留备份目录或兼容软链。

原仓 3 个提交已通过第二父提交进入 BotMux 历史，因此删除工作目录不会丢失代码历史。

若在运行时切换前发生失败，不修改现有软链。若切换后重启或真机验收失败，使用安装器把 link 临时切回旧仓，保留失败证据并停止删除；不在代码中增加双路径 fallback。

## 9. 非目标

- 不修改 Semantic Progress reducer、CardKit UI 或事件含义。
- 不修改 BotMux `turnProgress` SPI、Worker、Session 或 final delivery 架构。
- 不把两个插件合成一个 package。
- 不新增插件自动发现、自动启用、统一发布器或通用构建框架。
- 不顺带重构 `packages/workflow-core` 或根测试体系。
- 不提交用户现有的无关工作树改动。

## 10. 完成定义

- 两个插件均位于 BotMux `plugins/`，且仍是职责独立的 workspace package。
- Semantic Progress 原仓历史可从 BotMux Git 图访问。
- 源码、依赖锁、构建、测试和运行时 link 均以 monorepo 为唯一真相源。
- 两个 Bot 的 Semantic Progress 与 Desktop Handoff 真实链路均通过。
- 旧独立仓已进入废纸篓，仓库外无残留构建来源或兼容分叉。
- 实现与本设计逐项一致，深度 Review 未发现不必要抽象、重复逻辑或遗漏边界。

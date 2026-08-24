# Semantic Progress Monorepo 整合设计

日期：2026-08-24

状态：方案 A 已确认，深度 Review 修订后待用户复核

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
- Semantic Progress 独立仓没有远程地址，共有 3 个本地提交；工作树干净，当前 `main` 为 `6d591f41c7155b49efebe5a9b4020538cbe1274c`。
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
- `README.md`，并把开发、构建和安装示例改为 monorepo 路径
- `package.json`
- `tsconfig.json`
- 新增 `vitest.config.ts`
- 新增 `scripts/clean-dist.mjs`

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

`package.json` 增加 `private: true`，明确它是仓库内可独立构建的私有 package，而不是本次要发布到 npm 的产品。版本保持 `0.1.0`，因为本次没有产品或协议语义变化。

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

根 `pnpm-lock.yaml` 增加 `plugins/semantic-progress` importer；独立锁文件不进入 monorepo。独立仓当前使用 Vitest `4.1.11`，monorepo 锁定 `4.0.18`；迁入后必须使用 monorepo 实际解析的版本重新运行插件测试，旧仓测试结果只能作为迁移前基线。

## 6. 运行时切换

本次是一次性仓库迁移，不为它新增常驻的全局 admission freeze、插件 active-count 查询或第二套部署状态机。现有 heartbeat 的 `busyCount` 只覆盖普通 worker，Desktop Handoff follower 状态又只存在于插件进程内；因此不能把两者包装成一个实际上不可验证的“无损静默点”。

运行时切换必须在用户明确批准的短维护窗口内执行，并明确接受两个 Bot 的短暂不可用，不承诺零中断。当前两个 Bot 都只配置了一个允许用户，因此窗口开始前由该用户确认：Codex/TraeX 没有正在执行或等待输入的普通任务，也没有正在执行的 Desktop Handoff 往返；从确认开始到验收完成，不再从飞书或桌面端发起正常业务任务。daemon 重启后只允许本设计列出的受控验收消息，逐项等待其结束后再继续。若未来准入范围扩大到其他用户或自动化入口，必须先在入口侧暂停它们，不能沿用单用户确认。

确认后立即执行 `botmux stop`，以 daemon 完全退出作为新请求入口已关闭的可执行边界。若停止期间发现仍有活跃任务、超时或非正常退出，终止迁移，恢复服务并重新约维护窗口；不得带着不确定状态切换运行时。源码、锁文件、专项测试和构建可以提前完成，但 link 切换、重启验收和旧仓清理只能在该维护窗口内进行。

daemon 停止后，使用 BotMux 现有原子安装器，以相同插件 ID 更新本地 link：

```sh
botmux plugin install ./plugins/semantic-progress --link
```

安装器原子替换运行时 `dist` 并 upsert registry；现有插件 settings、两个 Bot 的 enabled binding 和历史卡片不迁移、不重建。

切换后必须同时满足：

- `~/.botmux/plugins/semantic-progress/dist` 是唯一运行时软链。
- 目标精确为 `/Users/bytedance/AiProjects/botmux/plugins/semantic-progress/dist`。
- `plugins-registry.json` 的 local source 指向 monorepo package。
- 两个 Bot 仍同时启用 `semantic-progress` 与 `desktop-handoff`。
- `materialized.json` 仍存在且 plugin ID 正确；它不记录 source 或 `turnProgress`，不能用于证明源码路径。
- 重启后的新 session/generation manifest 仍包含相同 plugin IDs。
- Semantic Progress 未声明 service，且没有以该插件 ID 或旧仓路径启动的独立进程。

随后启动 BotMux，让新 generation 重新物化插件清单；该过程不改飞书凭证、会话或 Handoff 账本。这里保证的是“显式停机边界内完成可回滚切换”，不是对切换前已存在任务做无法证明的无损迁移。维护窗口不能在第一次运行态验收后提前结束，必须持续到旧仓进入废纸篓、旧路径缺失后的冷启动和双 Bot 最小 smoke 全部通过。

## 7. Dashboard 管理体验校正

当前插件页虽然能正确显示两个插件均由 `2/2` 个 Bot 单独启用，但错误地把两张卡都标成“未声明扩展能力”。原因不是 registry 丢失贡献，而是 Dashboard 的展示类型和 capability summary 只识别 Skills、MCP、CLI、Dashboard 和 Service，没有展示已经存在的 `turnProgress` 与 `lark` contribution。

本次做一个与事实对齐的最小校正：

- Semantic Progress 显示“进度卡”能力。
- Desktop Handoff 显示“飞书协同”能力。
- 数据仍直接来自 registry contributions，不增加第二份声明或插件自报文案。
- 保留当前“全局关闭、按 Bot 单独启用”的交互和作用域说明，不改变启停语义。
- 增加 Dashboard 组件测试，证明有已知 contribution 时不再显示“未声明扩展能力”，未知/空 contribution 仍保持原提示。

这项修改只修正管理界面的事实呈现，不改变 Core 插件协议、插件运行逻辑或终端用户的进度卡样式。

## 8. 测试与验收

### 自动化

1. 先写失败的 workspace 契约测试，再实施迁入；验证包路径、`private`、贡献入口、独立测试配置、无独立锁文件、README 命令和根脚本。
2. 保存迁移前基线：独立仓 commit、源码/测试/构建产物清单与 hash，以及插件 `23/23`、Core Turn Progress 专项 `126/126` 的通过证据。
3. 迁入后逐文件比较旧 commit 与新 package。业务源码和原测试必须字节一致；允许的差异仅限 `private`、清理脚本、Vitest 配置、README 路径及 monorepo 集成测试。
4. 使用 monorepo 的依赖解析运行 Semantic Progress reducer/card 全量测试与构建，并比较 `dist` 文件集合和内容 hash；差异必须解释，不能默认接受。
5. 运行 BotMux 的 turn-progress runtime、host、eligibility、worker routing、final delivery、恢复和特殊通道排除等专项回归。
6. 运行 Desktop Handoff workspace 回归，确认第二个插件没有破坏既有构建边界。
7. 运行 BotMux 完整 build、`git diff --check`，并检查根锁文件只有预期 importer 变化。
8. 运行 Dashboard 插件能力摘要测试，验证 `turnProgress`、`lark` 和空 contribution 三种呈现。
9. CI 显式执行 `semantic-progress:test` 与 `desktop-handoff:test`；根 build 继续负责两个插件的编译，防止以后只过 Core 测试而插件回归。
10. 验证历史导入：整合提交第二父精确为 `6d591f41...`，`git merge-base --is-ancestor 6d591f41 HEAD` 成功，3 个原提交可读，`git fsck --full` 无错误。

### 运行态

1. 重启后用 registry `source.spec`、`readlink` 和 `realpath` 证明运行时来自 monorepo；materialized marker 只校验 plugin ID。插件页显示 Semantic Progress“进度卡”和 Desktop Handoff“飞书协同”，不再错误显示“未声明扩展能力”。
2. AI马仔与马仔二号各执行一个包含说明、命令、文件修改和最终答复的真实普通路由。每个执行单元只能有一张进度卡；语义步骤、折叠计数、原卡 final、`✅` reaction、message/root 身份均正确，不得新发重复 final。
3. 覆盖 MCP；覆盖 TraeX 等待输入与恢复；分别覆盖停止、执行失败、长 final 和 daemon 重启恢复。源码等价性允许复用自动化覆盖重复的内部错误分支，但不能省略这些用户可见状态。
4. 通过自动化实证 HTTP、文档评论、会议、managed/silent、substitute 与显式 `botmux send` 不被 Semantic Progress 错误接管。
5. 验证 Desktop Handoff 的 Codex/TraeX 通知与往返仍正常，两个 contribution 可同时启用且互不替代。
6. 扫描运行配置、代码、脚本和当前操作文档，不得引用旧独立仓路径；历史 spec 允许保留路径，但必须显式标注仓库边界已被本设计替代。
7. 检查没有第二份插件运行代码、没有以 Semantic Progress 插件 ID/旧路径启动的进程。

只有上述证据全部成立，才宣称整合完成。

## 9. 旧仓清理与恢复

验收通过后，独立仓 `/Users/bytedance/AiProjects/botmux-plugin-semantic-progress` 不再承担源码、构建或运行职责。删除前必须通过历史导入的全部 Git 验证。将旧仓移入系统废纸篓，保留可恢复性；在包含第二父的 BotMux 分支推送并由干净 clone 验证前，不清空该废纸篓条目。未经用户授权不主动 push。

原仓 3 个提交已通过第二父提交进入 BotMux 历史，因此删除工作目录不会丢失代码历史。

旧仓移入废纸篓后，在同一维护窗口内按绝对路径缺失的状态再做一次 BotMux 冷启动、registry/link/session manifest 检查和双 Bot 最小 smoke，专门暴露隐藏旧路径依赖。若失败，先执行 `botmux stop` 并确认 daemon 完全退出，再从废纸篓恢复旧仓、用安装器切回 link、恢复服务并保留失败证据；不在代码中增加双路径 fallback。只有该冷启动和 smoke 通过，维护窗口才结束，正常业务流量才恢复。

若在运行时切换前发生失败，不修改现有软链。若切换后、旧仓移动前发生失败，在同一维护窗口内再次停止 daemon，使用安装器把 link 临时切回旧仓，恢复服务并停止清理。

## 10. 非目标

- 不修改 Semantic Progress reducer、CardKit UI 或事件含义。
- 不修改 BotMux `turnProgress` SPI、Worker、Session 或 final delivery 架构。
- 不重新设计 Dashboard 插件页，只补齐现有 contribution 摘要缺口。
- 不把两个插件合成一个 package。
- 不新增插件自动发现、自动启用、统一发布器或通用构建框架。
- 不顺带重构 `packages/workflow-core` 或根测试体系。
- 不提交用户现有的无关工作树改动。

## 11. 完成定义

- 两个插件均位于 BotMux `plugins/`，且仍是职责独立的 workspace package。
- Semantic Progress 原仓历史可从 BotMux Git 图访问。
- 源码、依赖锁、构建、测试和运行时 link 均以 monorepo 为唯一真相源。
- 两个 Bot 的 Semantic Progress 完整用户态矩阵与 Desktop Handoff 真实链路均通过。
- Dashboard 对两个插件的能力与启用范围描述准确。
- 旧独立仓已进入废纸篓，仓库外无残留构建来源或兼容分叉。
- 旧仓路径缺失后的冷启动与双 Bot smoke 通过；历史在 BotMux Git 图中完整可达，废纸篓在远端/干净 clone 验证前不清空。
- 运行时切换在已记录的单用户维护窗口内完成；停止前无普通任务、等待输入或 Handoff 往返，daemon 完全退出后才替换 link，验收结束前只有逐项完成的受控验收消息进入。
- 实现与本设计逐项一致，深度 Review 未发现不必要抽象、重复逻辑或遗漏边界。

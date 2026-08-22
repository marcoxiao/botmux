# Semantic Progress for BotMux

将 Codex App 与 TRAE 的白名单执行事实投影为同一张 CardKit 2.0 语义进度卡。插件只包含纯 reducer 与纯卡片渲染，不持有飞书凭证，也不负责网络传输、持久化或最终答案交付。

## 开发

```bash
pnpm install
pnpm check
```

`src/` 固定只有三个文件，构建入口为 `dist/turn-progress/index.js`。

## 本地安装

先使用包含 `turn-progress` contribution 支持的 BotMux 版本构建本插件，然后执行：

```bash
botmux plugin install /Users/bytedance/AiProjects/botmux-plugin-semantic-progress --link
botmux plugin enable semantic-progress --bot <机器人名称>
```

插件不会显示百分比、ETA、原始命令、stdout/stderr、MCP invocation/result 或推理内容。

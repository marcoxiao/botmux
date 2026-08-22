# BotMux Codex Office 第一阶段实施记录

## 版本基线

- 日期：2026-08-22
- 仓库：`marcoxiao/botmux`
- 分支：`codex-office`
- 起始 commit：`9684a1aa5971f1fd3655e790c5a38716480dfc3a`
- Node：`v22.22.0`
- pnpm：`9.5.0`
- Codex：`codex-cli 0.142.3`
- tmux：基线缺失；通过临时 TUNA API/bottle 环境安装 Homebrew `tmux 3.7c`，未修改全局 Homebrew 镜像配置；独立 socket 的 new-session/kill-server 功能探测通过。

## 旧通道基线

- LaunchAgent：`com.local.codex-feishu-native`
- 基线状态：running
- 飞书应用：`cli_aa9f099867385ccc`
- owner：1
- 群白名单：1
- workspace root：`/Users/bytedance/AiProjects`
- 基线期间旧通道保持在线，尚未启动 BotMux daemon。

## 自动验证

## 可逆切换

## 飞书真机验收

## 清理与保留项

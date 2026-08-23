/**
 * Codex Desktop 会广播完整会话快照，真实大型会话可超过 16 MiB。
 * 64 MiB 覆盖已观测快照，同时保留明确的单帧内存上限。
 */
export const CODEX_DESKTOP_IPC_MAX_FRAME_BYTES = 64 * 1024 * 1024;

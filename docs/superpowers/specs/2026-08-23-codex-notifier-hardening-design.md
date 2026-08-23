# Codex Notifier Hardening Design

## Goal

Keep the existing Codex App ↔ Feishu topic workflow, while making its online
semantics, hot paths, delivery retry policy, titles, and local state recovery
predictable. Offline input remains fail-fast and is never queued.

## Design

- A successful adoption means a persistent topic-to-thread binding, not that
  Codex Desktop currently owns the thread. The success card says `已绑定` and
  tells the user to keep the original task open in Codex App.
- Every Feishu turn still uses the Desktop IPC owner probe. Missing ownership
  returns a visible no-queue error; BotMux does not open, switch, or queue work.
- Transcript context is scanned in bounded chunks. No 64 MiB buffer/string and
  no whole-window `split` are created on the daemon event loop.
- Rollout discovery performs one full reconciliation at startup, checks known
  files plus today's directory on the fast interval, and periodically performs
  a full reconciliation for old resumed sessions.
- Group notification delivery passes the existing deadline to Feishu. Only a
  withdrawn root or a definite permanent provider rejection falls back to DM;
  rate limits, server errors, timeouts, and ambiguous transport failures stay
  retryable through the existing outbox and stable UUID.
- Titles are derived from the actual `My request` body and strip known Codex UI
  context and attachment wrappers. Attachment-only requests use a neutral title.
- Corrupt local notifier stores are renamed to a timestamped quarantine file,
  logged, and recreated empty. They are never silently overwritten.
- Both card actions require the notifier to remain enabled for the same bot.

## Non-goals

- Offline queues, automatic App navigation, or automatic task switching.
- A new database, service, watcher dependency, or migration framework.
- Trae/Traex parity changes.

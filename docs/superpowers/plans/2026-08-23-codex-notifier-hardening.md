# Codex Notifier Hardening Implementation Plan

1. Add failing tests for binding wording, card-action configuration, prompt
   sanitization, bounded transcript reads, rollout discovery cadence, delivery
   deadline/retry classification, and corrupt-store recovery.
2. Implement the smallest production changes in the existing notifier modules.
3. Run focused notifier tests and benchmarks, then build the project.
4. Inspect the running daemon configuration, logs, process health, and perform a
   final diff review without touching the user's `.superpowers/` directory.

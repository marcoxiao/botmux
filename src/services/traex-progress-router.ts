import type { TurnProgressFactV1 } from '../core/turn-progress/protocol.js';
import type { CodexBridgeQueue, CodexPendingTurn } from './codex-bridge-queue.js';
import type { TraexOrderedRecord } from './traex-transcript.js';

const MAX_PENDING_FACTS = 128;

/** Binds TRAE rollout facts to the same queue owner as the adjacent bridge
 * records. The parser owns line order; this router only advances that order. */
export class TraexProgressRouter {
  private readonly pending: TurnProgressFactV1[] = [];

  constructor(
    private readonly queue: CodexBridgeQueue,
    private readonly emit: (owner: CodexPendingTurn, fact: TurnProgressFactV1) => void,
  ) {}

  ingest(records: readonly TraexOrderedRecord[]): void {
    for (const record of records) {
      if (record.kind === 'bridge') {
        this.queue.ingest([record.event]);
        if (record.event.kind === 'user') this.flush();
        else if (record.event.kind === 'assistant_final' || record.event.kind === 'turn_aborted') {
          this.pending.length = 0;
        }
        continue;
      }

      const owner = this.activeOwner();
      if (owner) this.emitIfRemote(owner, record.fact);
      else if (this.pending.length < MAX_PENDING_FACTS) this.pending.push(record.fact);
    }
  }

  clear(): void {
    this.pending.length = 0;
  }

  private activeOwner(): CodexPendingTurn | undefined {
    return this.queue.peek().find(turn => turn.started && turn.finalText === undefined);
  }

  private flush(): void {
    const owner = this.activeOwner();
    if (!owner) return;
    for (const fact of this.pending.splice(0)) this.emitIfRemote(owner, fact);
  }

  private emitIfRemote(owner: CodexPendingTurn, fact: TurnProgressFactV1): void {
    if (!owner.isLocal) this.emit(owner, fact);
  }
}

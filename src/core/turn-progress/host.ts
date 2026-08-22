import { createHash } from 'node:crypto';
import type { TurnProgressBindingV1 } from '../../types.js';
import { logger } from '../../utils/logger.js';
import type {
  TurnProgressContextV1,
  TurnProgressEventV1,
  TurnProgressFactV1,
  TurnProgressPluginV1,
} from './protocol.js';

type TurnProgressEventInput = TurnProgressEventV1 extends infer Event
  ? Event extends TurnProgressEventV1 ? Omit<Event, 'schemaVersion' | 'seq'> : never
  : never;

export interface TurnProgressHostDeps {
  create(cardJson: string): Promise<string>;
  reply(cardRefJson: string, turnId: string, uuid: string): Promise<string>;
  update(cardId: string, cardJson: string, sequence: number, uuid: string): Promise<void>;
  reactDone(primaryTurnId: string): Promise<void>;
  persist(binding: TurnProgressBindingV1 | undefined): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type FinalCardDelivery =
  | { kind: 'delivered'; messageId: string }
  | { kind: 'fallback' }
  | { kind: 'not_applicable' };

interface PendingSnapshot {
  cardJson: string;
  final: boolean;
  boundary: boolean;
}

type FailureDisposition = 'retryable' | 'ambiguous' | 'permanent';
type UpdateOutcome = 'succeeded' | FailureDisposition;

function disposition(error: unknown): FailureDisposition {
  const value = (error && typeof error === 'object')
    ? (error as { disposition?: unknown }).disposition
    : undefined;
  return value === 'retryable' || value === 'permanent' ? value : 'ambiguous';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableUuid(prefix: 'tp_r' | 'tp_u', ...parts: Array<string | number | undefined>): string {
  return `${prefix}_${hash(parts.join('\0')).slice(0, 40)}`;
}

function renderCard(plugin: TurnProgressPluginV1, state: unknown, context: TurnProgressContextV1): string {
  const card = plugin.render(state, context);
  if (!card || typeof card !== 'object' || Array.isArray(card) || card.schema !== '2.0') {
    throw new Error('invalid_turn_progress_card');
  }
  return JSON.stringify(card);
}

export class TurnProgressHost {
  private state: unknown;
  private binding: TurnProgressBindingV1 | undefined;
  private eventSeq = 0;
  private lastFactSeq = -1;
  private terminal = false;
  private projectionIsolated = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private pending: PendingSnapshot | undefined;
  private finalDelivery: Promise<FinalCardDelivery> | undefined;
  private attachment: Promise<void> | undefined;

  private constructor(
    private readonly plugin: TurnProgressPluginV1,
    private readonly context: TurnProgressContextV1,
    binding: TurnProgressBindingV1,
    state: unknown,
    private readonly deps: TurnProgressHostDeps,
  ) {
    this.binding = binding;
    this.state = state;
  }

  static async start(
    pluginId: string,
    plugin: TurnProgressPluginV1,
    context: TurnProgressContextV1,
    deps: TurnProgressHostDeps,
  ): Promise<TurnProgressHost | null> {
    let state: unknown;
    let cardJson: string;
    try {
      state = plugin.initialState(context);
      cardJson = renderCard(plugin, state, context);
    } catch (error) {
      logger.error(`[turn-progress] initial projection failed plugin=${pluginId}: ${String(error)}`);
      return null;
    }

    let cardId: string;
    try {
      cardId = await deps.create(cardJson);
    } catch (error) {
      logger.error(`[turn-progress] card create failed plugin=${pluginId}: ${String(error)}`);
      return null;
    }

    const replyUuid = stableUuid('tp_r', context.sessionId, context.primaryTurnId, context.dispatchAttempt);
    const replying: TurnProgressBindingV1 = {
      schemaVersion: 1,
      pluginId,
      primaryTurnId: context.primaryTurnId,
      ...(context.dispatchAttempt !== undefined ? { primaryDispatchAttempt: context.dispatchAttempt } : {}),
      memberTurnIds: [context.primaryTurnId],
      workerGeneration: context.workerGeneration,
      cardId,
      replyUuid,
      cardSequence: 0,
      deliveryState: 'replying',
    };
    try {
      deps.persist(replying);
    } catch (error) {
      logger.error(`[turn-progress] initial binding persistence failed plugin=${pluginId}: ${String(error)}`);
      return null;
    }

    const host = new TurnProgressHost(plugin, context, replying, state, deps);
    const attached = await host.attachReply();
    return attached ? host : null;
  }

  static restore(
    plugin: TurnProgressPluginV1,
    context: TurnProgressContextV1,
    binding: TurnProgressBindingV1,
    deps: TurnProgressHostDeps,
  ): TurnProgressHost {
    let state: unknown;
    let isolated = false;
    try {
      state = plugin.initialState(context);
    } catch (error) {
      isolated = true;
      logger.error(`[turn-progress] restored projection failed plugin=${binding.pluginId}: ${String(error)}`);
    }
    const host = new TurnProgressHost(plugin, context, structuredClone(binding), state, deps);
    host.projectionIsolated = isolated;
    host.terminal = binding.deliveryState === 'finalizing';
    if (binding.deliveryState === 'replying') {
      host.attachment = host.attachReply().then(() => undefined);
    }
    return host;
  }

  owns(turnId: string, dispatchAttempt?: number): boolean {
    const binding = this.binding;
    if (!binding || this.disposed || !binding.memberTurnIds.includes(turnId)) return false;
    return binding.primaryDispatchAttempt === dispatchAttempt
      || binding.primaryDispatchAttempt === undefined && dispatchAttempt === undefined;
  }

  bindSteer(turnId: string): void {
    const binding = this.binding;
    if (!binding || this.disposed || binding.memberTurnIds.includes(turnId)) return;
    const aliases = binding.memberTurnIds.filter(id => id !== binding.primaryTurnId);
    const next = {
      ...binding,
      memberTurnIds: [binding.primaryTurnId, ...[...aliases, turnId].slice(-31)],
    };
    this.commit(next);
  }

  dispatchFact(fact: TurnProgressFactV1): void {
    if (this.terminal || this.disposed || fact.seq <= this.lastFactSeq) return;
    this.lastFactSeq = fact.seq;
    const event: TurnProgressEventInput = fact.kind === 'turn_started'
      ? { kind: 'turn_started' }
      : fact.kind === 'narrative'
        ? { kind: 'narrative', text: fact.text! }
        : { kind: 'operation', operation: fact.operation! };
    this.dispatch(event, fact.kind === 'turn_started');
  }

  dispatch(event: TurnProgressEventInput, boundary: boolean): void {
    if (this.terminal || this.disposed || this.projectionIsolated) return;
    if (event.kind === 'terminal' || event.kind === 'external_reply') this.terminal = true;
    const sequenced = { ...event, schemaVersion: 1 as const, seq: ++this.eventSeq } as TurnProgressEventV1;
    try {
      this.state = this.plugin.reduce(this.state, sequenced, this.context);
      this.enqueue({ cardJson: renderCard(this.plugin, this.state, this.context), final: false, boundary }, boundary);
    } catch (error) {
      this.projectionIsolated = true;
      logger.error(`[turn-progress] projection isolated plugin=${this.binding?.pluginId ?? 'unknown'}: ${String(error)}`);
    }
  }

  deliverFinal(cardJson: string): Promise<FinalCardDelivery> {
    if (this.finalDelivery) return this.finalDelivery;
    if (!this.binding || this.disposed) return Promise.resolve({ kind: 'not_applicable' });
    this.terminal = true;
    this.pending = undefined;
    this.clearTimer();
    const delivery = this.runFinal(cardJson);
    this.finalDelivery = delivery;
    void delivery.catch(() => {
      if (this.finalDelivery === delivery) this.finalDelivery = undefined;
    });
    return delivery;
  }

  ackFinal(turnId: string): void {
    const binding = this.binding;
    if (!binding || binding.deliveryState !== 'finalizing' || !binding.memberTurnIds.includes(turnId)) return;
    this.deps.persist(undefined);
    this.binding = undefined;
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.terminal = true;
    this.pending = undefined;
    this.clearTimer();
  }

  private async attachReply(): Promise<boolean> {
    const binding = this.binding;
    if (!binding || binding.deliveryState !== 'replying') return !!binding?.messageId;
    let delayMs = 250;
    for (;;) {
      if (this.disposed) return false;
      try {
        const messageId = await this.deps.reply(
          JSON.stringify({ type: 'card', data: { card_id: binding.cardId } }),
          binding.primaryTurnId,
          binding.replyUuid,
        );
        const active = { ...binding, messageId, deliveryState: 'active' as const };
        try {
          this.commit(active);
        } catch (error) {
          // The durable replying record still carries the same idempotent UUID;
          // keep runtime ownership so later persistence can repair it safely.
          this.binding = active;
          logger.error(`[turn-progress] active binding persistence failed plugin=${binding.pluginId}: ${String(error)}`);
        }
        return true;
      } catch (error) {
        if (disposition(error) === 'permanent') {
          this.deps.persist(undefined);
          this.binding = undefined;
          this.dispose();
          return false;
        }
        await this.deps.sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 4_000);
      }
    }
  }

  private enqueue(snapshot: PendingSnapshot, boundary: boolean): void {
    this.pending = { ...snapshot, boundary };
    if (this.inFlight) return;
    if (boundary) {
      this.clearTimer();
      this.launchPending();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.launchPending();
      }, 2_000);
    }
  }

  private launchPending(): void {
    if (this.inFlight || !this.pending || this.disposed) return;
    const snapshot = this.pending;
    this.pending = undefined;
    const work = this.performUpdate(snapshot).then(outcome => {
      if (outcome !== 'succeeded') logger.error(`[turn-progress] progress update skipped: ${outcome}`);
    }, error => logger.error(`[turn-progress] progress update skipped: ${String(error)}`));
    this.inFlight = work;
    void work.finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
      if (!this.pending) return;
      this.enqueue(this.pending, this.pending.boundary);
    });
  }

  private async runFinal(cardJson: string): Promise<FinalCardDelivery> {
    if (this.attachment) await this.attachment;
    while (this.inFlight) await this.inFlight;
    let delayMs = 250;
    const snapshot = { cardJson, final: true, boundary: true };
    for (;;) {
      const binding = this.binding;
      if (!binding || this.disposed) return { kind: 'not_applicable' };
      const work = this.performUpdate(snapshot);
      const guard = work.then(() => undefined, () => undefined);
      this.inFlight = guard;
      let outcome: UpdateOutcome;
      try {
        outcome = await work;
      } finally {
        if (this.inFlight === guard) this.inFlight = undefined;
      }
      if (outcome === 'succeeded') {
        try { await this.deps.reactDone(binding.primaryTurnId); } catch (error) {
          logger.debug(`[turn-progress] completion reaction failed: ${String(error)}`);
        }
        return binding.messageId
          ? { kind: 'delivered', messageId: binding.messageId }
          : { kind: 'not_applicable' };
      }
      if (outcome === 'permanent') {
        this.deps.persist(undefined);
        this.binding = undefined;
        this.dispose();
        return { kind: 'fallback' };
      }
      await this.deps.sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 4_000);
    }
  }

  private async performUpdate(snapshot: PendingSnapshot): Promise<UpdateOutcome> {
    const binding = this.binding;
    if (!binding) return 'permanent';
    const cardHash = hash(snapshot.cardJson);
    const existing = binding.updateIntent?.cardHash === cardHash ? binding.updateIntent : undefined;
    const sequence = existing?.sequence
      ?? Math.max(binding.cardSequence, binding.updateIntent?.sequence ?? 0) + 1;
    const intent = existing ?? {
      sequence,
      uuid: stableUuid('tp_u', this.context.sessionId, binding.primaryTurnId, sequence, cardHash),
      cardHash,
    };
    const intended: TurnProgressBindingV1 = {
      ...binding,
      deliveryState: snapshot.final ? 'finalizing' : binding.deliveryState,
      updateIntent: intent,
    };
    if (binding.updateIntent !== intent || binding.deliveryState !== intended.deliveryState) this.commit(intended);

    try {
      await this.deps.update(binding.cardId, snapshot.cardJson, intent.sequence, intent.uuid);
    } catch (error) {
      return disposition(error);
    }

    const current = this.binding ?? intended;
    const { updateIntent: _completed, ...withoutIntent } = current;
    try {
      this.commit({ ...withoutIntent, cardSequence: intent.sequence });
    } catch (error) {
      logger.error(`[turn-progress] successful update persistence delayed: ${String(error)}`);
      return 'ambiguous';
    }
    return 'succeeded';
  }

  private commit(binding: TurnProgressBindingV1): void {
    this.deps.persist(binding);
    this.binding = binding;
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

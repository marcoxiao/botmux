import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CompletionEvent, DesktopIdentity, ProviderId } from './types.js';

interface ConfirmedTurn { prompt: string; createdAt: number }
interface StoredEvent extends CompletionEvent { recordedAt: number; delivery?: 'delivered' }
export interface ThreadRoute extends DesktopIdentity {
  rootEventId?: string;
  rootMessageId?: string;
  latestEventId: string;
  updatedAt: number;
  adoptedAt?: number;
}
export type RootRoute = ThreadRoute;
export interface TakeoverResolution {
  event: CompletionEvent;
  route: ThreadRoute;
}
interface Ledger {
  version: 2;
  confirmedTurns: Record<string, ConfirmedTurn>;
  events: Record<string, StoredEvent>;
  threads: Record<string, ThreadRoute>;
}

const TURN_TTL_MS = 7 * 24 * 60 * 60_000;
const EVENT_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_TURNS = 2_048;
const MAX_EVENTS = 512;
const locks = new Map<string, Promise<void>>();

function emptyLedger(): Ledger {
  return { version: 2, confirmedTurns: {}, events: {}, threads: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isProvider(value: unknown): value is ProviderId {
  return value === 'codex' || value === 'traex';
}

function validIdentity(value: Record<string, unknown>): boolean {
  return typeof value.larkAppId === 'string' && !!value.larkAppId.trim()
    && isProvider(value.provider)
    && typeof value.threadId === 'string' && !!value.threadId.trim();
}

function validConfirmedTurn(value: unknown): value is ConfirmedTurn {
  return isRecord(value) && typeof value.prompt === 'string' && Number.isFinite(value.createdAt);
}

function validStoredEvent(value: unknown): value is StoredEvent {
  if (!isRecord(value) || !validIdentity(value)) return false;
  return typeof value.eventId === 'string' && !!value.eventId
    && typeof value.nativeTurnId === 'string' && !!value.nativeTurnId
    && typeof value.cwd === 'string'
    && typeof value.title === 'string'
    && typeof value.finalPreview === 'string'
    && (value.status === 'completed' || value.status === 'failed' || value.status === 'cancelled')
    && typeof value.completedAt === 'string'
    && Number.isFinite(value.recordedAt)
    && (value.delivery === undefined || value.delivery === 'delivered');
}

function validThreadRoute(value: unknown): value is ThreadRoute {
  if (!isRecord(value) || !validIdentity(value)) return false;
  return typeof value.latestEventId === 'string' && !!value.latestEventId
    && Number.isFinite(value.updatedAt)
    && (value.rootEventId === undefined || typeof value.rootEventId === 'string')
    && (value.rootMessageId === undefined || typeof value.rootMessageId === 'string')
    && (value.adoptedAt === undefined || Number.isFinite(value.adoptedAt));
}

function validLedger(value: unknown): value is Ledger {
  if (!isRecord(value)
    || value.version !== 2
    || !isRecord(value.confirmedTurns)
    || !isRecord(value.events)
    || !isRecord(value.threads)) return false;
  return Object.values(value.confirmedTurns).every(validConfirmedTurn)
    && Object.entries(value.events).every(([key, event]) => validStoredEvent(event) && event.eventId === key)
    && Object.entries(value.threads).every(([key, route]) => validThreadRoute(route) && identityKey(route) === key);
}

function identityKey(identity: DesktopIdentity): string {
  return JSON.stringify([identity.larkAppId, identity.provider, identity.threadId]);
}

function turnKey(identity: DesktopIdentity, turnId: string): string {
  return JSON.stringify([identity.larkAppId, identity.provider, identity.threadId, turnId]);
}

function sameIdentity(left: DesktopIdentity, right: DesktopIdentity): boolean {
  return left.larkAppId === right.larkAppId
    && left.provider === right.provider
    && left.threadId === right.threadId;
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  locks.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(path) === tail) locks.delete(path);
  }
}

export class DesktopHandoffStore {
  constructor(private readonly path: string) {}

  private async read(): Promise<Ledger> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!validLedger(parsed)) throw new Error('desktop_handoff_ledger_invalid');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger();
      throw error;
    }
  }

  private prune(ledger: Ledger): void {
    const now = Date.now();
    ledger.confirmedTurns = Object.fromEntries(Object.entries(ledger.confirmedTurns)
      .filter(([, value]) => now - value.createdAt <= TURN_TTL_MS)
      .sort((a, b) => b[1].createdAt - a[1].createdAt)
      .slice(0, MAX_TURNS));
    ledger.events = Object.fromEntries(Object.entries(ledger.events)
      .filter(([, value]) => now - value.recordedAt <= EVENT_TTL_MS)
      .sort((a, b) => b[1].recordedAt - a[1].recordedAt)
      .slice(0, MAX_EVENTS));
  }

  private async write(ledger: Ledger): Promise<void> {
    this.prune(ledger);
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(ledger)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, this.path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  async confirmTurn(identity: DesktopIdentity, turnId: string, prompt: string): Promise<void> {
    await withLock(this.path, async () => {
      const ledger = await this.read();
      ledger.confirmedTurns[turnKey(identity, turnId)] = { prompt, createdAt: Date.now() };
      await this.write(ledger);
    });
  }

  async confirmedTurn(identity: DesktopIdentity, turnId: string): Promise<string | undefined> {
    return withLock(this.path, async () => {
      const turn = (await this.read()).confirmedTurns[turnKey(identity, turnId)];
      return turn && Date.now() - turn.createdAt <= TURN_TTL_MS ? turn.prompt : undefined;
    });
  }

  async consumeConfirmedTurn(identity: DesktopIdentity, turnId: string): Promise<string | undefined> {
    return withLock(this.path, async () => {
      const ledger = await this.read();
      const key = turnKey(identity, turnId);
      const turn = ledger.confirmedTurns[key];
      if (!turn || Date.now() - turn.createdAt > TURN_TTL_MS) return undefined;
      delete ledger.confirmedTurns[key];
      await this.write(ledger);
      return turn.prompt;
    });
  }

  async recordEvent(event: CompletionEvent): Promise<{ duplicate: boolean }> {
    return withLock(this.path, async () => {
      const ledger = await this.read();
      if (ledger.events[event.eventId]?.delivery) return { duplicate: true };
      const now = Date.now();
      ledger.events[event.eventId] = { ...event, recordedAt: now };
      const key = identityKey(event);
      ledger.threads[key] = {
        ...ledger.threads[key],
        larkAppId: event.larkAppId,
        provider: event.provider,
        threadId: event.threadId,
        latestEventId: event.eventId,
        updatedAt: now,
      };
      await this.write(ledger);
      return { duplicate: false };
    });
  }

  async markDelivered(eventId: string, delivery: 'delivered'): Promise<void> {
    await withLock(this.path, async () => {
      const ledger = await this.read();
      if (ledger.events[eventId]) ledger.events[eventId].delivery = delivery;
      await this.write(ledger);
    });
  }

  async reserveRoot(identity: DesktopIdentity, candidateEventId: string): Promise<CompletionEvent> {
    return withLock(this.path, async () => {
      const ledger = await this.read();
      const route = ledger.threads[identityKey(identity)];
      const candidate = ledger.events[candidateEventId];
      if (!route || !candidate || !sameIdentity(candidate, identity)) {
        throw new Error('desktop_handoff_root_event_missing');
      }
      const reserved = route.rootEventId ? ledger.events[route.rootEventId] : undefined;
      const root = reserved && sameIdentity(reserved, identity) ? reserved : candidate;
      if (route.rootEventId !== root.eventId) {
        route.rootEventId = root.eventId;
        route.updatedAt = Date.now();
        await this.write(ledger);
      }
      return root;
    });
  }

  async markRoot(
    identity: DesktopIdentity,
    rootEventId: string,
    rootMessageId: string,
  ): Promise<void> {
    await withLock(this.path, async () => {
      const ledger = await this.read();
      const key = identityKey(identity);
      const route = ledger.threads[key];
      const event = ledger.events[rootEventId];
      if (!route || route.rootEventId !== rootEventId || !event || !sameIdentity(event, identity)) {
        throw new Error('desktop_handoff_root_event_missing');
      }
      ledger.threads[key] = { ...route, rootEventId, rootMessageId, updatedAt: Date.now() };
      await this.write(ledger);
    });
  }

  async clearRoot(identity: DesktopIdentity, expectedRootMessageId: string): Promise<boolean> {
    return withLock(this.path, async () => {
      const ledger = await this.read();
      const route = ledger.threads[identityKey(identity)];
      if (!route || route.rootMessageId !== expectedRootMessageId) return false;
      delete route.rootEventId;
      delete route.rootMessageId;
      delete route.adoptedAt;
      route.updatedAt = Date.now();
      await this.write(ledger);
      return true;
    });
  }

  async removeEvent(eventId: string): Promise<void> {
    await withLock(this.path, async () => {
      const ledger = await this.read();
      const event = ledger.events[eventId];
      if (!event) return;
      delete ledger.events[eventId];
      const route = ledger.threads[identityKey(event)];
      if (route?.latestEventId === eventId) {
        const previous = Object.values(ledger.events)
          .filter(candidate => sameIdentity(candidate, event))
          .sort((a, b) => b.recordedAt - a.recordedAt)[0];
        if (previous) route.latestEventId = previous.eventId;
      }
      await this.write(ledger);
    });
  }

  async thread(identity: DesktopIdentity): Promise<ThreadRoute | undefined> {
    return withLock(this.path, async () => {
      const route = (await this.read()).threads[identityKey(identity)];
      return route ? { ...route } : undefined;
    });
  }

  async markAdopted(identity: DesktopIdentity, expectedRootMessageId: string): Promise<void> {
    await withLock(this.path, async () => {
      const ledger = await this.read();
      const route = ledger.threads[identityKey(identity)];
      if (!route || route.rootMessageId !== expectedRootMessageId) {
        throw new Error('desktop_handoff_route_changed');
      }
      route.adoptedAt = Date.now();
      route.updatedAt = Date.now();
      await this.write(ledger);
    });
  }

  async routeByRoot(larkAppId: string, rootMessageId: string): Promise<RootRoute | undefined> {
    return withLock(this.path, async () => {
      const route = Object.values((await this.read()).threads)
        .find(candidate => candidate.larkAppId === larkAppId && candidate.rootMessageId === rootMessageId);
      return route ? { ...route } : undefined;
    });
  }

  async resolveTakeover(larkAppId: string, clickedEventId: string): Promise<TakeoverResolution | undefined> {
    return withLock(this.path, async () => {
      const ledger = await this.read();
      const clicked = ledger.events[clickedEventId];
      if (clicked && clicked.larkAppId !== larkAppId) return undefined;
      const route = clicked
        ? ledger.threads[identityKey(clicked)]
        : Object.values(ledger.threads)
          .find(candidate => candidate.larkAppId === larkAppId && candidate.rootEventId === clickedEventId);
      if (!route || route.larkAppId !== larkAppId || route.rootEventId !== clickedEventId || !route.rootMessageId) {
        return undefined;
      }
      const latest = ledger.events[route.latestEventId] ?? clicked;
      if (!latest || !sameIdentity(latest, route)) return undefined;
      return { event: latest, route: { ...route } };
    });
  }
}

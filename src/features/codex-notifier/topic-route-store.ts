import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';

const STORE_SCHEMA_VERSION = 1;
const ROUTE_KEYS = new Set(['threadId', 'chatId', 'rootMessageId', 'updatedAt']);
const MAX_ID_LENGTH = 256;

export const DEFAULT_MAX_CODEX_NOTIFIER_TOPIC_ROUTES = 1000;

export interface CodexNotifierTopicRoute {
  threadId: string;
  chatId: string;
  rootMessageId: string;
  updatedAt: string;
}

interface TopicRouteStoreFile {
  schemaVersion: 1;
  routes: CodexNotifierTopicRoute[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && value.trim() === value;
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validateRoute(value: unknown): CodexNotifierTopicRoute {
  if (
    !plainObject(value)
    || Object.keys(value).some(key => !ROUTE_KEYS.has(key))
    || !validId(value.threadId)
    || !validId(value.chatId)
    || !validId(value.rootMessageId)
    || !validIsoTimestamp(value.updatedAt)
  ) {
    throw new Error('Codex notifier topic route store schema mismatch');
  }
  return value as unknown as CodexNotifierTopicRoute;
}

function routeKey(threadId: string, chatId: string): string {
  return `${chatId}\0${threadId}`;
}

function cloneRoute(route: CodexNotifierTopicRoute): CodexNotifierTopicRoute {
  return { ...route };
}

/** 单 daemon 写入的最小路由账本；不存消息正文、凭证或 Codex 输出。 */
export class CodexNotifierTopicRouteStore {
  private readonly routes = new Map<string, CodexNotifierTopicRoute>();

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = DEFAULT_MAX_CODEX_NOTIFIER_TOPIC_ROUTES,
  ) {
    if (!filePath.trim()) throw new Error('Codex notifier topic route store path is required');
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('Codex notifier topic route maxEntries must be a positive safe integer');
    }
    this.load();
  }

  get(threadId: string, chatId: string): CodexNotifierTopicRoute | undefined {
    const route = this.routes.get(routeKey(threadId, chatId));
    return route ? cloneRoute(route) : undefined;
  }

  bind(
    route: Omit<CodexNotifierTopicRoute, 'updatedAt'>,
    now = Date.now(),
  ): CodexNotifierTopicRoute {
    if (!Number.isFinite(now)) throw new Error('Codex notifier topic route timestamp must be finite');
    const next = validateRoute({
      ...route,
      updatedAt: new Date(now).toISOString(),
    });
    const key = routeKey(next.threadId, next.chatId);
    this.routes.delete(key);
    this.routes.set(key, next);
    while (this.routes.size > this.maxEntries) this.evictOldest();
    this.persist();
    return cloneRoute(next);
  }

  invalidate(threadId: string, chatId: string): boolean {
    const deleted = this.routes.delete(routeKey(threadId, chatId));
    if (deleted) this.persist();
    return deleted;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, route] of this.routes) {
      const timestamp = Date.parse(route.updatedAt);
      if (timestamp < oldestAt) {
        oldestAt = timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.routes.delete(oldestKey);
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (cause) {
      throw new Error(`Codex notifier topic route store is unreadable at ${this.filePath}`, { cause });
    }
    if (
      !plainObject(parsed)
      || parsed.schemaVersion !== STORE_SCHEMA_VERSION
      || !Array.isArray(parsed.routes)
      || parsed.routes.length > this.maxEntries
      || Object.keys(parsed).some(key => !['schemaVersion', 'routes'].includes(key))
    ) {
      throw new Error(`Codex notifier topic route store schema mismatch at ${this.filePath}`);
    }
    for (const raw of parsed.routes) {
      const route = validateRoute(raw);
      const key = routeKey(route.threadId, route.chatId);
      if (this.routes.has(key)) {
        throw new Error(`duplicate Codex notifier topic route ${route.chatId}:${route.threadId}`);
      }
      this.routes.set(key, route);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const state: TopicRouteStoreFile = {
      schemaVersion: STORE_SCHEMA_VERSION,
      routes: [...this.routes.values()],
    };
    atomicWriteFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  }
}

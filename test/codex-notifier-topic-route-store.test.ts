import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexNotifierTopicRouteStore,
  codexNotifierTopicRoutesPath,
} from '../src/features/codex-notifier/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newStore(maxEntries = 2): {
  dataDir: string;
  file: string;
  store: CodexNotifierTopicRouteStore;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-codex-topic-routes-'));
  tempDirs.push(dataDir);
  const file = codexNotifierTopicRoutesPath(dataDir, 'cli_test');
  return { dataDir, file, store: new CodexNotifierTopicRouteStore(file, maxEntries) };
}

describe('Codex notifier topic route store', () => {
  it('isolates the same Codex thread by destination chat', () => {
    const { store } = newStore();
    store.bind({ threadId: 'thread-1', chatId: 'oc_a', rootMessageId: 'om_a' }, 1);
    store.bind({ threadId: 'thread-1', chatId: 'oc_b', rootMessageId: 'om_b' }, 2);

    expect(store.get('thread-1', 'oc_a')?.rootMessageId).toBe('om_a');
    expect(store.get('thread-1', 'oc_b')?.rootMessageId).toBe('om_b');
  });

  it('persists with mode 0600 and evicts the least recently updated route', () => {
    const { file, store } = newStore(2);
    store.bind({ threadId: 't1', chatId: 'oc', rootMessageId: 'om1' }, 1);
    store.bind({ threadId: 't2', chatId: 'oc', rootMessageId: 'om2' }, 2);
    store.bind({ threadId: 't3', chatId: 'oc', rootMessageId: 'om3' }, 3);

    expect(store.get('t1', 'oc')).toBeUndefined();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new CodexNotifierTopicRouteStore(file, 2).get('t3', 'oc')).toEqual({
      threadId: 't3',
      chatId: 'oc',
      rootMessageId: 'om3',
      updatedAt: new Date(3).toISOString(),
    });
  });

  it('updates duplicate keys, invalidates only the exact route and returns clones', () => {
    const { store } = newStore(3);
    store.bind({ threadId: 'thread', chatId: 'oc_a', rootMessageId: 'om_old' }, 1);
    store.bind({ threadId: 'thread', chatId: 'oc_b', rootMessageId: 'om_b' }, 2);
    store.bind({ threadId: 'thread', chatId: 'oc_a', rootMessageId: 'om_new' }, 3);

    const route = store.get('thread', 'oc_a');
    expect(route?.rootMessageId).toBe('om_new');
    if (route) route.rootMessageId = 'mutated';
    expect(store.get('thread', 'oc_a')?.rootMessageId).toBe('om_new');
    expect(store.invalidate('thread', 'oc_a')).toBe(true);
    expect(store.invalidate('thread', 'oc_a')).toBe(false);
    expect(store.get('thread', 'oc_b')?.rootMessageId).toBe('om_b');
  });

  it('rejects malformed or duplicate persisted routes', () => {
    const { file } = newStore();
    mkdirSync(dirname(file), { recursive: true });
    const route = {
      threadId: 'thread',
      chatId: 'oc',
      rootMessageId: 'om',
      updatedAt: new Date(1).toISOString(),
    };
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      routes: [route, route],
    }));

    expect(() => new CodexNotifierTopicRouteStore(file, 2))
      .toThrow('duplicate Codex notifier topic route');

    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      routes: [{ ...route, unexpected: true }],
    }));
    expect(() => new CodexNotifierTopicRouteStore(file, 2))
      .toThrow('Codex notifier topic route store schema mismatch');
    expect(JSON.parse(readFileSync(file, 'utf8')).routes).toHaveLength(1);
  });
});

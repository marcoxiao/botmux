#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';

function fail(message) {
  throw new Error(message);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseArgs(argv) {
  if (argv.length !== 4) {
    fail('usage: migrate-ledger-v2.mjs --ledger <path> --codex-app-id <app-id>');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== '--ledger' && flag !== '--codex-app-id') || !nonEmpty(value) || values.has(flag)) {
      fail('usage: migrate-ledger-v2.mjs --ledger <path> --codex-app-id <app-id>');
    }
    values.set(flag, value.trim());
  }
  const ledger = values.get('--ledger');
  const appId = values.get('--codex-app-id');
  if (!ledger || !appId || values.size !== 2) fail('desktop_handoff_migration_arguments_invalid');
  return { ledger, appId };
}

function identityKey(appId, threadId) {
  return JSON.stringify([appId, 'codex', threadId]);
}

function turnKey(appId, threadId, turnId) {
  return JSON.stringify([appId, 'codex', threadId, turnId]);
}

function validateTurn(value) {
  return !!record(value) && typeof value.prompt === 'string' && number(value.createdAt);
}

function validateEvent(key, value) {
  return !!record(value)
    && value.eventId === key
    && !!nonEmpty(value.threadId)
    && !!nonEmpty(value.nativeTurnId)
    && typeof value.cwd === 'string'
    && typeof value.title === 'string'
    && typeof value.finalPreview === 'string'
    && (value.status === 'completed' || value.status === 'failed' || value.status === 'cancelled')
    && typeof value.completedAt === 'string'
    && number(value.recordedAt)
    && (value.delivery === undefined || value.delivery === 'delivered');
}

function migrate(source, appId) {
  const ledger = record(source);
  if (!ledger || ledger.version !== 1) fail('desktop_handoff_v1_ledger_required');
  const turns = record(ledger.confirmedTurns);
  const events = record(ledger.events);
  const threads = record(ledger.threads);
  if (!turns || !events || !threads) fail('desktop_handoff_v1_ledger_invalid');

  const migratedEvents = {};
  for (const [eventId, candidate] of Object.entries(events)) {
    if (!validateEvent(eventId, candidate)) fail('desktop_handoff_v1_event_invalid');
    migratedEvents[eventId] = { ...candidate, larkAppId: appId, provider: 'codex' };
  }

  const migratedThreads = {};
  for (const [threadId, candidate] of Object.entries(threads)) {
    const route = record(candidate);
    const latest = route && migratedEvents[route.latestEventId];
    const root = route?.rootEventId === undefined ? undefined : migratedEvents[route.rootEventId];
    if (!route
      || !nonEmpty(threadId)
      || !latest
      || latest.threadId !== threadId
      || (route.rootEventId !== undefined && (!root || root.threadId !== threadId))
      || !number(route.updatedAt)
      || (route.rootMessageId !== undefined && typeof route.rootMessageId !== 'string')
      || (route.adoptedAt !== undefined && !number(route.adoptedAt))) {
      fail('desktop_handoff_v1_route_invalid');
    }
    migratedThreads[identityKey(appId, threadId)] = {
      ...route,
      larkAppId: appId,
      provider: 'codex',
      threadId,
    };
  }

  const migratedTurns = {};
  for (const [key, candidate] of Object.entries(turns)) {
    const separator = key.lastIndexOf('\u0000');
    const threadId = key.slice(0, separator);
    const turnId = key.slice(separator + 1);
    if (separator <= 0 || !threadId || !turnId || !validateTurn(candidate)) {
      fail('desktop_handoff_v1_turn_invalid');
    }
    migratedTurns[turnKey(appId, threadId, turnId)] = candidate;
  }

  return { version: 2, confirmedTurns: migratedTurns, events: migratedEvents, threads: migratedThreads };
}

async function atomicWrite(path, value) {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

const { ledger, appId } = parseArgs(process.argv.slice(2));
const source = JSON.parse(await readFile(ledger, 'utf8'));
await atomicWrite(ledger, migrate(source, appId));

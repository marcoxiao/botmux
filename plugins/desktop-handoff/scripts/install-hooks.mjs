#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENTS = ['UserPromptSubmit', 'Stop'];
const BOT_ID = /^cli_[A-Za-z0-9]+$/;
const HANDOFF_COMMAND = /^(?:\/usr\/bin\/env PATH=(?:'[^']*'|\S+) )?(?:'[^']*'|\S+) plugin emit desktop-handoff --bot cli_[A-Za-z0-9]+ --best-effort$/;

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid argument near ${key ?? '<end>'}`);
    }
    if (values.has(key)) throw new Error(`duplicate argument ${key}`);
    values.set(key, value);
  }
  const rawHome = values.get('--home') ?? process.env.HOME;
  const codexBot = values.get('--codex-bot');
  const traexBot = values.get('--traex-bot');
  if (!rawHome || !isAbsolute(rawHome) || !codexBot || !traexBot || !BOT_ID.test(codexBot) || !BOT_ID.test(traexBot)) {
    throw new Error('usage: install-hooks.mjs [--home <absolute-path>] --codex-bot <cli_id> --traex-bot <cli_id>');
  }
  const known = new Set(['--home', '--codex-bot', '--traex-bot']);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`unknown argument ${key}`);
  }
  return { home: resolve(rawHome), codexBot, traexBot };
}

function validateConfig(value, path) {
  if (!isObject(value) || !isObject(value.hooks)) {
    throw new Error(`invalid hook config ${path}: expected an object with hooks`);
  }
  if ('version' in value && (!Number.isInteger(value.version) || value.version < 1)) {
    throw new Error(`invalid hook config ${path}: version must be a positive integer`);
  }
  for (const [event, groups] of Object.entries(value.hooks)) {
    if (!Array.isArray(groups)) {
      throw new Error(`invalid hook config ${path}: hooks.${event} must be an array`);
    }
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.every(isObject)) {
        throw new Error(`invalid hook config ${path}: hooks.${event} contains an invalid group`);
      }
    }
  }
  return value;
}

function loadConfig(path, fallback) {
  if (!existsSync(path)) return { path, original: undefined, config: fallback };
  const original = readFileSync(path, 'utf8');
  try {
    return { path, original, config: validateConfig(JSON.parse(original), path) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid hook config')) throw error;
    throw new Error(`invalid hook config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function commandFor(home, botId) {
  const path = [...new Set([
    dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ])].join(':');
  const executable = join(home, '.botmux', 'bin', 'botmux');
  return `/usr/bin/env PATH=${shellQuote(path)} ${shellQuote(executable)} plugin emit desktop-handoff --bot ${botId} --best-effort`;
}

function isHandoffHook(hook) {
  return hook.type === 'command'
    && typeof hook.command === 'string'
    && HANDOFF_COMMAND.test(hook.command);
}

function installEvent(config, event, command) {
  const groups = config.hooks[event] ?? [];
  let installed = false;
  const nextGroups = [];
  for (const group of groups) {
    const hooks = [];
    for (const hook of group.hooks) {
      if (!isHandoffHook(hook)) {
        hooks.push(hook);
      } else if (!installed) {
        hooks.push({ ...hook, type: 'command', command, timeout: 10 });
        installed = true;
      }
    }
    if (hooks.length > 0) nextGroups.push({ ...group, hooks });
  }
  if (!installed) {
    nextGroups.push({
      matcher: '*',
      hooks: [{ type: 'command', command, timeout: 10 }],
    });
  }
  config.hooks[event] = nextGroups;
}

function removeLegacyEvent(config, event) {
  const groups = config.hooks[event] ?? [];
  const nextGroups = groups.flatMap(group => {
    const hooks = group.hooks.filter(hook => !isHandoffHook(hook));
    return hooks.length > 0 ? [{ ...group, hooks }] : [];
  });
  if (nextGroups.length > 0) config.hooks[event] = nextGroups;
  else delete config.hooks[event];
}

function serialize(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function persist(plan) {
  const contents = serialize(plan.config);
  if (contents === plan.original) {
    chmodSync(plan.path, 0o600);
    return false;
  }
  mkdirSync(dirname(plan.path), { recursive: true });
  const temporary = `${plan.path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(descriptor, contents, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort after a failed temporary write */ }
    throw error;
  }
  try {
    renameSync(temporary, plan.path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort after a failed rename */ }
    throw error;
  }
  chmodSync(plan.path, 0o600);
  return true;
}

export function installHooks({ home, codexBot, traexBot }) {
  const plans = [
    loadConfig(join(home, '.codex', 'hooks.json'), { hooks: {} }),
    loadConfig(join(home, '.trae', 'cli', 'hooks.json'), { version: 1, hooks: {} }),
  ];
  const legacyPath = join(home, '.trae', 'hooks.json');
  const legacy = existsSync(legacyPath) ? loadConfig(legacyPath, { version: 1, hooks: {} }) : undefined;

  for (const event of EVENTS) installEvent(plans[0].config, event, commandFor(home, codexBot));
  for (const event of EVENTS) installEvent(plans[1].config, event, commandFor(home, traexBot));
  if (legacy) {
    for (const event of EVENTS) removeLegacyEvent(legacy.config, event);
    plans.push(legacy);
  }

  return plans.map(plan => ({ path: plan.path, changed: persist(plan) }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = installHooks(parseArgs(process.argv.slice(2)));
    for (const item of result) console.log(`${item.changed ? 'updated' : 'unchanged'} ${item.path}`);
    console.log('Restart Codex and TraeX, approve the native Hook trust prompts, then run a real Hook event.');
  } catch (error) {
    console.error(`desktop-handoff hooks: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

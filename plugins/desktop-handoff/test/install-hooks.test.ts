import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'install-hooks.mjs');
const CODEX_BOT = 'cli_codex123';
const TRAEX_BOT = 'cli_traex456';
const OTHER_COMMAND = '/usr/bin/true --keep-this-hook';

interface HookCommand { type: string; command: string; timeout?: number }
interface HookGroup { matcher?: string; hooks: HookCommand[] }
interface HookConfig { version?: number; hooks: Record<string, HookGroup[]> }

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'desktop-handoff-hooks-'));
}

function writeJson(path: string, value: unknown, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function readJson(path: string): HookConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as HookConfig;
}

function commands(config: HookConfig, event: string): string[] {
  return (config.hooks[event] ?? []).flatMap(group => group.hooks.map(hook => hook.command));
}

function handoffCommands(config: HookConfig, event: string): string[] {
  return commands(config, event).filter(command => command.includes('plugin emit desktop-handoff'));
}

function oldCommand(home: string, bot: string): string {
  return `/usr/bin/env PATH=/usr/bin:/bin ${join(home, '.botmux', 'bin', 'botmux')} plugin emit desktop-handoff --bot ${bot} --best-effort`;
}

function run(home: string): void {
  execFileSync(process.execPath, [
    SCRIPT,
    '--home', home,
    '--codex-bot', CODEX_BOT,
    '--traex-bot', TRAEX_BOT,
  ], { stdio: 'pipe' });
}

describe('canonical Desktop Handoff Hook installer', () => {
  it('installs idempotently, preserves hook positions, and removes only the legacy TraeX entries', () => {
    const home = fixture();
    const codexPath = join(home, '.codex', 'hooks.json');
    const traexPath = join(home, '.trae', 'cli', 'hooks.json');
    const legacyTraexPath = join(home, '.trae', 'hooks.json');
    const otherGroup: HookGroup = { hooks: [{ type: 'command', command: OTHER_COMMAND }] };

    writeJson(codexPath, {
      hooks: {
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: oldCommand(home, CODEX_BOT), timeout: 10 }] },
          otherGroup,
        ],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: oldCommand(home, CODEX_BOT), timeout: 10 }] },
          otherGroup,
        ],
      },
    });
    writeJson(traexPath, {
      version: 1,
      hooks: {
        UserPromptSubmit: [otherGroup],
        Stop: [otherGroup],
        PostToolUseFailure: [otherGroup],
      },
    });
    writeJson(legacyTraexPath, {
      version: 1,
      hooks: {
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: oldCommand(home, TRAEX_BOT), timeout: 10 }] },
          otherGroup,
        ],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: oldCommand(home, TRAEX_BOT), timeout: 10 }] },
          otherGroup,
        ],
      },
    });

    run(home);

    const codex = readJson(codexPath);
    const traex = readJson(traexPath);
    const legacyTraex = readJson(legacyTraexPath);
    for (const event of ['UserPromptSubmit', 'Stop']) {
      expect(handoffCommands(codex, event)).toHaveLength(1);
      expect(handoffCommands(codex, event)[0]).toContain(`--bot ${CODEX_BOT} --best-effort`);
      expect(commands(codex, event)[1]).toBe(OTHER_COMMAND);
      expect(handoffCommands(traex, event)).toHaveLength(1);
      expect(handoffCommands(traex, event)[0]).toContain(`--bot ${TRAEX_BOT} --best-effort`);
      expect(commands(traex, event)[0]).toBe(OTHER_COMMAND);
      expect(handoffCommands(legacyTraex, event)).toHaveLength(0);
      expect(commands(legacyTraex, event)).toEqual([OTHER_COMMAND]);
    }
    expect(commands(traex, 'PostToolUseFailure')).toEqual([OTHER_COMMAND]);
    for (const path of [codexPath, traexPath, legacyTraexPath]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }

    const before = [codexPath, traexPath, legacyTraexPath].map(path => ({
      contents: readFileSync(path, 'utf8'),
      mtimeNs: statSync(path, { bigint: true }).mtimeNs,
    }));
    run(home);
    const after = [codexPath, traexPath, legacyTraexPath].map(path => ({
      contents: readFileSync(path, 'utf8'),
      mtimeNs: statSync(path, { bigint: true }).mtimeNs,
    }));
    expect(after).toEqual(before);
  });

  it.each([
    ['broken JSON', '{broken json\n'],
    ['unknown structure', '{"hooks":[]}\n'],
  ])('validates every input before changing any file: %s', (_name, invalidTraex) => {
    const home = fixture();
    const codexPath = join(home, '.codex', 'hooks.json');
    const traexPath = join(home, '.trae', 'cli', 'hooks.json');
    writeJson(codexPath, { hooks: { Stop: [{ hooks: [{ type: 'command', command: OTHER_COMMAND }] }] } });
    mkdirSync(dirname(traexPath), { recursive: true });
    writeFileSync(traexPath, invalidTraex);
    const before = readFileSync(codexPath, 'utf8');

    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--home', home,
      '--codex-bot', CODEX_BOT,
      '--traex-bot', TRAEX_BOT,
    ], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid hook config');
    expect(readFileSync(codexPath, 'utf8')).toBe(before);
    expect(handoffCommands(readJson(codexPath), 'Stop')).toHaveLength(0);
  });
});

import {
  listCodexAppHooks,
  type CodexAppHook,
} from '../../services/codex-app-threads.js';
import { isBotmuxCodexNotifierCommand } from './hook-installer.js';

export type CodexNotifierHookHealthStatus =
  | 'trusted'
  | 'untrusted'
  | 'disabled'
  | 'missing'
  | 'unavailable';

export interface CodexNotifierHookHealth {
  status: CodexNotifierHookHealthStatus;
  checkedAt: string;
  error?: string;
}

export interface ProbeCodexNotifierHookHealthOptions {
  now?: () => number;
  listHooks?: () => Promise<CodexAppHook[]>;
}

const REQUIRED_EVENTS = ['stop', 'userPromptSubmit'] as const;

/** 以 app-server 的生效视图为准；只读，不替用户修改 Codex 的 Hook 信任。 */
export async function probeCodexNotifierHookHealth(
  options: ProbeCodexNotifierHookHealthOptions = {},
): Promise<CodexNotifierHookHealth> {
  const checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  try {
    const hooks = (await (options.listHooks ?? listCodexAppHooks)())
      .filter(hook => isBotmuxCodexNotifierCommand(hook.command));
    const byEvent = new Map<string, CodexAppHook[]>();
    for (const hook of hooks) {
      const eventHooks = byEvent.get(hook.eventName) ?? [];
      eventHooks.push(hook);
      byEvent.set(hook.eventName, eventHooks);
    }

    if (REQUIRED_EVENTS.some(eventName => (byEvent.get(eventName)?.length ?? 0) === 0)) {
      return { status: 'missing', checkedAt };
    }
    if (REQUIRED_EVENTS.some(eventName => !byEvent.get(eventName)?.some(hook => hook.enabled))) {
      return { status: 'disabled', checkedAt };
    }
    if (REQUIRED_EVENTS.some(eventName => !byEvent.get(eventName)?.some(
      hook => hook.enabled && hook.trustStatus === 'trusted',
    ))) {
      return { status: 'untrusted', checkedAt };
    }
    return { status: 'trusted', checkedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'unavailable',
      checkedAt,
      error: [...message].slice(0, 300).join(''),
    };
  }
}

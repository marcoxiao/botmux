import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CODEX_APP_ID = 'cli_codex';
const TRAEX_APP_ID = 'cli_traex';
const THREAD_ID = '01a02d9c-fb00-7042-a396-ee9529207d03';
const CODEX_SOCKET = join(homedir(), '.codex', 'ipc', 'ipc.sock');
const TRAEX_SOCKET = join(homedir(), '.trae', 'cli', 'ipc', 'ipc.sock');

const desktop = vi.hoisted(() => ({
  probe: vi.fn(async () => true),
  send: vi.fn(async () => ({
    turnId: 'turn-from-feishu', completion: new Promise<never>(() => undefined),
  })),
}));

vi.mock('../src/desktop-ipc.js', () => ({
  probeDesktopThread: desktop.probe,
  sendDesktopTurn: desktop.send,
}));

import plugin from '../src/lark/index.js';

type Provider = 'codex' | 'traex';

interface SharedFixture {
  dir: string;
  ledgerPath: string;
}

async function sharedFixture(): Promise<SharedFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-handoff-plugin-'));
  return { dir, ledgerPath: join(dir, 'ledger.json') };
}

async function fixture(provider: Provider = 'codex', shared?: SharedFixture, rootMessageId?: string) {
  const state = shared ?? await sharedFixture();
  const appId = provider === 'codex' ? CODEX_APP_ID : TRAEX_APP_ID;
  const transcriptPath = join(state.dir, `${provider}-${Math.random()}.jsonl`);
  await writeFile(transcriptPath, `${JSON.stringify({
    type: 'session_meta', payload: {
      id: THREAD_ID,
      source: provider === 'codex' ? 'vscode' : 'cli',
      originator: 'Codex Desktop',
      ...(provider === 'traex' ? { model_provider: 'trae' } : {}),
      cwd: '/workspace/app',
    },
  })}\n`);
  const config = new Map<string, unknown>([
    ['bots', {
      [CODEX_APP_ID]: { provider: 'codex', workbenchChatId: 'oc_workbench' },
      [TRAEX_APP_ID]: { provider: 'traex', workbenchChatId: 'oc_workbench' },
    }],
    ['ledgerPath', state.ledgerPath],
  ]);
  const host = {
    config: {
      get: vi.fn((key?: string) => key ? config.get(key) : Object.fromEntries(config)),
      set: vi.fn(), delete: vi.fn(), path: join(state.dir, 'config.json'),
    },
    sendCard: vi.fn(async () => ({ messageId: rootMessageId ?? `om_${provider}` })),
    replyCard: vi.fn(async () => ({ messageId: `om_${provider}_reply` })),
    updateCard: vi.fn(async () => undefined),
    getOwnerOpenId: vi.fn(() => 'ou_owner'),
    openCodexApp: vi.fn(async () => ({ ok: true })),
  };
  return {
    ...state,
    provider,
    appId,
    transcriptPath,
    host,
    context: { larkAppId: appId, managedSession: false },
    rootMessageId: rootMessageId ?? `om_${provider}`,
  };
}

function prompt(transcriptPath: string, turn = 'turn-1') {
  return {
    hook_event_name: 'UserPromptSubmit', session_id: THREAD_ID, turn_id: turn,
    transcript_path: transcriptPath, cwd: '/workspace/app', prompt: '检查架构',
  };
}

function stop(transcriptPath: string, turn = 'turn-1') {
  return {
    hook_event_name: 'Stop', session_id: THREAD_ID, turn_id: turn,
    transcript_path: transcriptPath, cwd: '/workspace/app', last_assistant_message: '已完成',
  };
}

function eventIdFrom(result: Awaited<ReturnType<typeof fixture>>): string {
  const card = result.host.sendCard.mock.calls[0]![0].card as Record<string, unknown>;
  const eventId = JSON.stringify(card).match(/[a-f0-9]{64}/)?.[0];
  if (!eventId) throw new Error('missing fixture event id');
  return eventId;
}

async function publish(result: Awaited<ReturnType<typeof fixture>>, turn = 'turn-1'): Promise<string> {
  await plugin.handleLocalEvent?.(prompt(result.transcriptPath, turn), result.context, result.host);
  await plugin.handleLocalEvent?.(stop(result.transcriptPath, turn), result.context, result.host);
  return eventIdFrom(result);
}

async function adopt(result: Awaited<ReturnType<typeof fixture>>, eventId = eventIdFrom(result)) {
  return plugin.handleCardAction?.({
    operator: { open_id: 'ou_owner' }, context: { open_message_id: result.rootMessageId },
    action: { value: { action: 'desktop-handoff.takeover', event_id: eventId } },
  }, { larkAppId: result.appId }, result.host);
}

async function publishAndAdopt(result: Awaited<ReturnType<typeof fixture>>) {
  const eventId = await publish(result);
  await adopt(result, eventId);
  return eventId;
}

function message(result: Awaited<ReturnType<typeof fixture>>, text: string, id = 'om_input') {
  return {
    larkAppId: result.appId,
    chatId: 'oc_workbench',
    messageId: id,
    rootMessageId: result.rootMessageId,
    senderOpenId: 'ou_owner',
    text,
  };
}

beforeEach(() => {
  desktop.probe.mockReset().mockResolvedValue(true);
  desktop.send.mockReset().mockResolvedValue({
    turnId: 'turn-from-feishu', completion: new Promise<never>(() => undefined),
  });
});

describe('desktop-handoff dual-bot Lark contribution', () => {
  it.each([
    ['codex', CODEX_APP_ID, CODEX_SOCKET, 'Codex Desktop'],
    ['traex', TRAEX_APP_ID, TRAEX_SOCKET, 'TraeX Desktop'],
  ] as const)('%s Hook 只投递到自身 Bot 的统一 CardKit 工作台', async (provider, appId, socket, product) => {
    const result = await fixture(provider);
    await publish(result);

    expect(result.context.larkAppId).toBe(appId);
    expect(result.host.sendCard).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'oc_workbench',
      card: expect.objectContaining({ schema: '2.0' }),
      uuid: expect.stringMatching(/^dhr-.{46}$/),
      replyClaim: 'exclusive',
    }));
    expect(JSON.stringify(result.host.sendCard.mock.calls[0]![0].card)).toContain(product);

    await adopt(result);
    expect(desktop.probe).toHaveBeenCalledWith(THREAD_ID, { socketPath: socket });
  });

  it('未知 Bot 与 subagent Hook 均 fail-closed', async () => {
    const result = await fixture();
    await plugin.handleLocalEvent?.(prompt(result.transcriptPath), {
      ...result.context, larkAppId: 'cli_unknown',
    }, result.host);
    await plugin.handleLocalEvent?.({ ...prompt(result.transcriptPath), agent_id: 'subagent-1' }, result.context, result.host);
    expect(result.host.sendCard).not.toHaveBeenCalled();
  });

  it('相同 thread ID 在两个 Bot 和 Provider 间保持独立话题', async () => {
    const shared = await sharedFixture();
    const codex = await fixture('codex', shared, 'om_codex');
    const traex = await fixture('traex', shared, 'om_traex');
    const codexEventId = await publish(codex);
    const traexEventId = await publish(traex);
    expect(codexEventId).not.toBe(traexEventId);

    await expect(plugin.handleCardAction?.({
      operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_traex' },
      action: { value: { action: 'desktop-handoff.takeover', event_id: traexEventId } },
    }, { larkAppId: CODEX_APP_ID }, codex.host)).resolves.toMatchObject({ header: { template: 'red' } });
    expect(desktop.probe).not.toHaveBeenCalled();

    await expect(plugin.handleMessage?.({ ...message(codex, '串线'), rootMessageId: 'om_traex' }, codex.host))
      .resolves.toEqual({ handled: false });
  });

  it.each([
    ['codex', CODEX_SOCKET],
    ['traex', TRAEX_SOCKET],
  ] as const)('%s 接管后写回固定 socket，并把最终回复送回同一 CardKit 话题', async (provider, socket) => {
    const result = await fixture(provider);
    await publishAndAdopt(result);
    result.host.replyCard.mockClear();
    let complete!: (value: {
      turnId: string; status: 'completed'; finalText: string; cwd: string; title: string;
    }) => void;
    desktop.send.mockResolvedValueOnce({
      turnId: 'turn-from-feishu',
      completion: new Promise(resolve => { complete = resolve; }),
    });

    await expect(plugin.handleMessage?.(message(result, '继续检查架构'), result.host))
      .resolves.toEqual({ handled: true });
    expect(desktop.send).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      text: '继续检查架构',
      clientUserMessageId: 'om_input',
    }, { socketPath: socket });

    complete({
      turnId: 'turn-from-feishu', status: 'completed', finalText: '结构正常，没有冗余。',
      cwd: '/workspace/app', title: '架构检查',
    });
    await vi.waitFor(() => {
      expect(result.host.replyCard).toHaveBeenCalledWith(expect.objectContaining({
        rootMessageId: result.rootMessageId,
        card: expect.objectContaining({ schema: '2.0' }),
      }));
      expect(JSON.stringify(result.host.replyCard.mock.calls.at(-1)?.[0].card)).toContain('结构正常，没有冗余。');
    });
  });

  it('同一 Desktop 任务同一时刻只接收一个飞书轮次，不排队', async () => {
    const result = await fixture('traex');
    await publishAndAdopt(result);
    let release!: () => void;
    desktop.send.mockImplementationOnce(async () => ({
      turnId: 'turn-active',
      completion: new Promise(resolve => { release = () => resolve({
        turnId: 'turn-active', status: 'completed', finalText: '完成', cwd: '', title: '',
      }); }),
    }));

    await plugin.handleMessage?.(message(result, '第一条', 'om_first'), result.host);
    await plugin.handleMessage?.(message(result, '第二条', 'om_second'), result.host);
    expect(desktop.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.host.replyCard.mock.calls.at(-1)?.[0].card)).toContain('正在处理');
    expect(JSON.stringify(result.host.replyCard.mock.calls.at(-1)?.[0].card)).toContain('没有排队');
    release();
  });

  it.each([
    ['desktop_thread_offline', '当前离线', '本次没有排队'],
    ['desktop_thread_busy', '正在处理', '没有排队'],
    ['desktop_turn_delivery_unknown', '送达状态待确认', '不要立即重发'],
  ])('%s 使用独立失败语义且不回落到 BotMux', async (error, title, instruction) => {
    const result = await fixture();
    await publishAndAdopt(result);
    desktop.send.mockRejectedValueOnce(new Error(error));
    await expect(plugin.handleMessage?.(message(result, '继续'), result.host)).resolves.toEqual({ handled: true });
    const card = JSON.stringify(result.host.replyCard.mock.calls.at(-1)?.[0].card);
    expect(card).toContain(title);
    expect(card).toContain(instruction);
  });

  it('仅所有者可接管，复制卡片和错误根消息均被拒绝', async () => {
    const result = await fixture();
    const eventId = await publish(result);
    const data = {
      operator: { open_id: 'ou_other' }, context: { open_message_id: result.rootMessageId },
      action: { value: { action: 'desktop-handoff.takeover', event_id: eventId } },
    };
    await expect(plugin.handleCardAction?.(data, { larkAppId: result.appId }, result.host))
      .resolves.toMatchObject({ header: { template: 'red' } });
    data.operator.open_id = 'ou_owner';
    data.context.open_message_id = 'om_forwarded';
    await expect(plugin.handleCardAction?.(data, { larkAppId: result.appId }, result.host))
      .resolves.toMatchObject({ header: { template: 'red' } });
    expect(desktop.probe).not.toHaveBeenCalled();
  });

  it('根消息被撤回后只重建该 Bot 的话题根', async () => {
    const result = await fixture('traex');
    await publish(result);
    result.host.sendCard.mockResolvedValue({ messageId: 'om_rebuilt' });
    result.host.replyCard.mockRejectedValueOnce(new Error('lark_root_message_unavailable'));
    await plugin.handleLocalEvent?.(prompt(result.transcriptPath, 'turn-2'), result.context, result.host);
    await plugin.handleLocalEvent?.(stop(result.transcriptPath, 'turn-2'), result.context, result.host);
    expect(result.host.sendCard).toHaveBeenCalledTimes(2);
    expect(result.host.sendCard.mock.calls[1]![0]).toMatchObject({ chatId: 'oc_workbench' });
  });

  it('完成流中断只提示结果不可用，不允许同任务悄悄排队', async () => {
    const result = await fixture();
    await publishAndAdopt(result);
    result.host.replyCard.mockClear();
    let fail!: (error: Error) => void;
    desktop.send.mockResolvedValueOnce({
      turnId: 'turn-from-feishu',
      completion: new Promise((_, reject) => { fail = reject; }),
    });
    await plugin.handleMessage?.(message(result, '继续'), result.host);
    fail(new Error('desktop_ipc_closed'));
    await vi.waitFor(() => {
      const card = JSON.stringify(result.host.replyCard.mock.calls.at(-1)?.[0].card);
      expect(card).toContain('结果回传中断');
      expect(card).toContain('不要重复发送');
    });
  });
});

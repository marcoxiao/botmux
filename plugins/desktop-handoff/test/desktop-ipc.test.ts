import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeDesktopThread, sendDesktopTurn } from '../src/desktop-ipc.js';

const THREAD_ID = '01a02d9c-fb00-7042-a396-ee9529207d03';
const dirs: string[] = [];

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

function snapshot(socket: Socket, revision = 1, title = '架构检查'): void {
  socket.write(frame({
    type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
    sourceClientId: 'desktop-owner', targetClientIds: ['client-self'],
    params: {
      conversationId: THREAD_ID, hostId: 'local',
      change: {
        type: 'snapshot', revision,
        conversationState: {
          cwd: '/workspace/app', title,
          turnHistory: { history: { entitiesByKey: {} } },
        },
      },
    },
  }));
}

async function fakeRouter(
  handle: (message: any, socket: Socket) => void,
): Promise<{ socketPath: string; messages: any[]; close(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-ipc-'));
  dirs.push(dir);
  const socketPath = join(dir, 'ipc.sock');
  const messages: any[] = [];
  const server = createServer(socket => {
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < length + 4) return;
        const message = JSON.parse(buffered.subarray(4, length + 4).toString('utf8'));
        buffered = buffered.subarray(length + 4);
        messages.push(message);
        handle(message, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    messages,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Codex Desktop IPC', () => {
  it('保持原生 follower stream 到精确 turn 完成，并返回最终回复', async () => {
    const router = await fakeRouter((message, socket) => {
      if (message.method === 'initialize') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: 'initialize',
          resultType: 'success', handledByClientId: 'client-self', result: { clientId: 'client-self' },
        }));
      } else if (message.method === 'thread-owner-discovery') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner', result: {},
        }));
      } else if (message.type === 'broadcast'
        && message.method === 'thread-stream-following-changed'
        && message.params.following === true) {
        snapshot(socket);
      } else if (message.method === 'thread-follower-start-turn') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner',
          result: { result: { turn: { id: 'turn-native' } } },
        }));
        socket.write(frame({
          type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
          sourceClientId: 'desktop-owner', targetClientIds: ['client-self'],
          params: {
            conversationId: THREAD_ID, hostId: 'local',
            change: {
              type: 'patches', baseRevision: 1, revision: 2,
              patches: [{
                op: 'add',
                path: ['turnHistory', 'history', 'entitiesByKey', 'turn:new'],
                value: {
                  turnId: 'turn-native', status: 'completed', error: null,
                  params: {
                    clientUserMessageId: 'om_input',
                    input: [{ type: 'text', text: '从飞书继续' }],
                  },
                  items: [{
                    type: 'agentMessage', phase: 'final_answer', text: '检查完成，结构正常。',
                  }],
                },
              }],
            },
          },
        }));
      }
    });

    const handle = await sendDesktopTurn({
      threadId: THREAD_ID, text: '从飞书继续', clientUserMessageId: 'om_input',
    }, { socketPath: router.socketPath });

    expect(handle.turnId).toBe('turn-native');
    await expect(handle.completion).resolves.toEqual({
      turnId: 'turn-native', status: 'completed', finalText: '检查完成，结构正常。',
      cwd: '/workspace/app', title: '架构检查',
    });
    expect(router.messages).toContainEqual(expect.objectContaining({
      type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      targetClientIds: ['desktop-owner'],
      params: { conversationId: THREAD_ID, hostId: 'local', following: true },
    }));
    await vi.waitFor(() => expect(router.messages).toContainEqual(expect.objectContaining({
      type: 'broadcast', method: 'thread-stream-following-changed',
      params: { conversationId: THREAD_ID, hostId: 'local', following: false },
    })));
    await router.close();
  });

  it('先发现同一 Desktop 会话的 owner，再向该 owner 发送原生 follower turn', async () => {
    const router = await fakeRouter((message, socket) => {
      if (message.method === 'initialize') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: 'initialize',
          resultType: 'success', handledByClientId: 'client-self', result: { clientId: 'client-self' },
        }));
      } else if (message.method === 'thread-owner-discovery') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner', result: {},
        }));
      } else if (message.type === 'broadcast'
        && message.method === 'thread-stream-following-changed'
        && message.params.following === true) {
        snapshot(socket, 1, '');
      } else if (message.method === 'thread-follower-start-turn') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner', result: { result: { turn: { id: 'turn-native' } } },
        }));
        socket.write(frame({
          type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
          sourceClientId: 'desktop-owner', targetClientIds: ['client-self'],
          params: {
            conversationId: THREAD_ID, hostId: 'local',
            change: {
              type: 'patches', baseRevision: 1, revision: 2,
              patches: [{
                op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'turn:new'],
                value: {
                  turnId: 'turn-native', status: 'completed',
                  params: { clientUserMessageId: 'om_input' },
                  items: [{ type: 'agentMessage', phase: 'final_answer', text: '完成' }],
                },
              }],
            },
          },
        }));
      }
    });

    await expect(probeDesktopThread(THREAD_ID, { socketPath: router.socketPath })).resolves.toBe(true);
    const handle = await sendDesktopTurn({
      threadId: THREAD_ID,
      text: '从飞书继续',
      clientUserMessageId: 'om_input',
    }, { socketPath: router.socketPath });
    expect(handle.turnId).toBe('turn-native');
    await expect(handle.completion).resolves.toMatchObject({
      turnId: 'turn-native', finalText: '完成', title: '',
    });

    const discovery = router.messages.find(message => message.method === 'thread-owner-discovery');
    expect(discovery).toMatchObject({
      type: 'request', version: 1,
      params: { hostId: 'local', conversationId: THREAD_ID },
    });
    const start = router.messages.find(message => message.method === 'thread-follower-start-turn');
    expect(start).toMatchObject({
      type: 'request', version: 2, targetClientId: 'desktop-owner',
      params: {
        conversationId: THREAD_ID,
        turnStart: {
          request: {
            threadId: THREAD_ID,
            clientUserMessageId: 'om_input',
            input: [{ type: 'text', text: '从飞书继续', text_elements: [] }],
          },
          context: { inheritThreadSettings: true },
        },
      },
    });
    await router.close();
  });

  it('没有 Desktop owner 时明确离线，不发送 turn', async () => {
    const router = await fakeRouter((message, socket) => {
      if (message.method === 'initialize') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: 'initialize',
          resultType: 'success', handledByClientId: 'client-self', result: { clientId: 'client-self' },
        }));
      } else if (message.method === 'thread-owner-discovery') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'error', error: 'no-client-found',
        }));
      } else if (message.type === 'broadcast'
        && message.method === 'thread-stream-following-changed'
        && message.params.following === true) snapshot(socket);
    });

    await expect(probeDesktopThread(THREAD_ID, { socketPath: router.socketPath })).resolves.toBe(false);
    await expect(sendDesktopTurn({
      threadId: THREAD_ID, text: '继续', clientUserMessageId: 'om_input',
    }, { socketPath: router.socketPath })).rejects.toThrow('desktop_thread_offline');
    expect(router.messages.some(message => message.method === 'thread-follower-start-turn')).toBe(false);
    await router.close();
  });

  it('owner 探测超时统一视为离线', async () => {
    const router = await fakeRouter((message, socket) => {
      if (message.method === 'initialize') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: 'initialize',
          resultType: 'success', handledByClientId: 'client-self', result: { clientId: 'client-self' },
        }));
      }
    });
    await expect(probeDesktopThread(THREAD_ID, {
      socketPath: router.socketPath, timeoutMs: 20,
    })).resolves.toBe(false);
    await router.close();
  });

  it('turn 请求写出后超时标记为送达未知，不能谎称未排队并鼓励重发', async () => {
    const router = await fakeRouter((message, socket) => {
      if (message.method === 'initialize') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: 'initialize',
          resultType: 'success', handledByClientId: 'client-self', result: { clientId: 'client-self' },
        }));
      } else if (message.method === 'thread-owner-discovery') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner', result: {},
        }));
      } else if (message.type === 'broadcast'
        && message.method === 'thread-stream-following-changed'
        && message.params.following === true) snapshot(socket);
    });

    await expect(sendDesktopTurn({
      threadId: THREAD_ID, text: '继续', clientUserMessageId: 'om_input',
    }, { socketPath: router.socketPath, timeoutMs: 20 })).rejects.toThrow('desktop_turn_delivery_unknown');
    expect(router.messages.some(message => message.method === 'thread-follower-start-turn')).toBe(true);
    await router.close();
  });

  it('Desktop 明确拒绝活跃 turn 时返回 busy，不误报送达未知', async () => {
    const router = await fakeRouter((message, socket) => {
      if (message.method === 'initialize') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: 'initialize',
          resultType: 'success', handledByClientId: 'client-self', result: { clientId: 'client-self' },
        }));
      } else if (message.method === 'thread-owner-discovery') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner', result: {},
        }));
      } else if (message.type === 'broadcast'
        && message.method === 'thread-stream-following-changed'
        && message.params.following === true) {
        snapshot(socket);
      } else if (message.method === 'thread-follower-start-turn') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'error', error: 'thread-busy',
        }));
      }
    });

    await expect(sendDesktopTurn({
      threadId: THREAD_ID, text: '继续', clientUserMessageId: 'om_input',
    }, { socketPath: router.socketPath })).rejects.toThrow('desktop_thread_busy');
    await router.close();
  });

  it('只连接调用方明确指定的 Provider socket', async () => {
    const unused = await fakeRouter(() => undefined);
    const selected = await fakeRouter((message, socket) => {
      if (message.method === 'initialize') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: 'initialize',
          resultType: 'success', handledByClientId: 'client-self', result: { clientId: 'client-self' },
        }));
      } else if (message.method === 'thread-owner-discovery') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner', result: {},
        }));
      }
    });

    await expect(probeDesktopThread(THREAD_ID, { socketPath: selected.socketPath })).resolves.toBe(true);
    expect(selected.messages.length).toBeGreaterThan(0);
    expect(unused.messages).toHaveLength(0);
    await selected.close();
    await unused.close();
  });

  it('状态流 revision 断档时终止跟踪，不能把不完整状态当最终回复', async () => {
    const router = await fakeRouter((message, socket) => {
      if (message.method === 'initialize') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: 'initialize',
          resultType: 'success', handledByClientId: 'client-self', result: { clientId: 'client-self' },
        }));
      } else if (message.method === 'thread-owner-discovery') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner', result: {},
        }));
      } else if (message.type === 'broadcast'
        && message.method === 'thread-stream-following-changed'
        && message.params.following === true) {
        snapshot(socket);
      } else if (message.method === 'thread-follower-start-turn') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner',
          result: { result: { turn: { id: 'turn-native' } } },
        }));
        setImmediate(() => socket.write(frame({
          type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
          sourceClientId: 'desktop-owner', targetClientIds: ['client-self'],
          params: {
            conversationId: THREAD_ID, hostId: 'local',
            change: { type: 'patches', baseRevision: 9, revision: 10, patches: [] },
          },
        })));
      }
    });

    const handle = await sendDesktopTurn({
      threadId: THREAD_ID, text: '继续', clientUserMessageId: 'om_input',
    }, { socketPath: router.socketPath });
    await expect(handle.completion).rejects.toThrow('desktop_stream_revision_mismatch');
    await router.close();
  });

  it('initialize 响应无效时关闭短连接，不遗留挂起 socket', async () => {
    const router = await fakeRouter((message, socket) => {
      if (message.method === 'initialize') {
        socket.write(frame({
          type: 'response', requestId: message.requestId, method: 'initialize',
          resultType: 'success', handledByClientId: 'client-self', result: {},
        }));
      }
    });

    await expect(probeDesktopThread(THREAD_ID, { socketPath: router.socketPath }))
      .rejects.toThrow('desktop_ipc_initialize_failed');
    await expect(Promise.race([
      router.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('socket_not_closed')), 100)),
    ])).resolves.toBeUndefined();
  });

  it('拒绝非法会话 ID 和空消息', async () => {
    await expect(probeDesktopThread('not-a-thread')).rejects.toThrow('invalid_desktop_thread_id');
    await expect(sendDesktopTurn({
      threadId: THREAD_ID, text: '   ', clientUserMessageId: 'om_input',
    })).rejects.toThrow('invalid_desktop_turn_text');
  });
});

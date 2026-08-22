import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  CodexDesktopUnavailableError,
  probeCodexDesktopThread,
  sendCodexDesktopThreadTurn,
} from '../src/features/codex-notifier/desktop-ipc-client.js';

function encode(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

function decode(frame: Buffer): Record<string, any> {
  const size = frame.readUInt32LE(0);
  return JSON.parse(frame.subarray(4, 4 + size).toString('utf8')) as Record<string, any>;
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writes: Record<string, any>[] = [];
  onWrite?: (message: Record<string, any>) => void;

  write(frame: Buffer): boolean {
    const message = decode(frame);
    this.writes.push(message);
    this.onWrite?.(message);
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    this.writable = false;
    this.emit('close');
    return this;
  }

  respond(message: unknown): void {
    queueMicrotask(() => this.emit('data', encode(message)));
  }
}

function asSocket(socket: FakeSocket): Socket {
  return socket as unknown as Socket;
}

function readySocket(onRequest: (socket: FakeSocket, message: Record<string, any>) => void): FakeSocket {
  const socket = new FakeSocket();
  socket.onWrite = message => {
    if (message.method === 'initialize') {
      socket.respond({
        type: 'response',
        requestId: message.requestId,
        resultType: 'success',
        method: 'initialize',
        handledByClientId: 'botmux-client',
        result: { clientId: 'botmux-client' },
      });
      return;
    }
    onRequest(socket, message);
  };
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}

describe('Codex Desktop IPC follower client', () => {
  it('discovers the real Desktop owner before reporting the thread writable', async () => {
    const socket = readySocket((target, message) => {
      expect(message).toMatchObject({
        type: 'request',
        method: 'thread-owner-discovery',
        sourceClientId: 'botmux-client',
        version: 1,
        params: { hostId: 'local', conversationId: '01a02459-7f00-7022-917a-d7e400dab649' },
      });
      expect(message.targetClientId).toBeUndefined();
      target.respond({
        type: 'response',
        requestId: message.requestId,
        resultType: 'success',
        method: 'thread-owner-discovery',
        handledByClientId: 'desktop-owner',
        result: {},
      });
    });

    await expect(probeCodexDesktopThread('01a02459-7f00-7022-917a-d7e400dab649', {
      connect: () => asSocket(socket),
      timeoutMs: 100,
    })).resolves.toBe('desktop-owner');
    expect(socket.destroyed).toBe(true);
  });

  it('routes a Lark turn to the discovered writer through the native follower request', async () => {
    const socket = readySocket((target, message) => {
      if (message.method === 'thread-owner-discovery') {
        target.respond({
          type: 'response',
          requestId: message.requestId,
          resultType: 'success',
          method: message.method,
          handledByClientId: 'desktop-owner',
          result: {},
        });
        return;
      }
      expect(message).toMatchObject({
        type: 'request',
        method: 'thread-follower-start-turn',
        targetClientId: 'desktop-owner',
        sourceClientId: 'botmux-client',
        version: 1,
        params: {
          conversationId: '01a02459-7f00-7022-917a-d7e400dab649',
          turnStartParams: {
            input: [
              { type: 'text', text: '从飞书继续', text_elements: [] },
              { type: 'localImage', path: '/tmp/example.png', detail: 'high' },
            ],
            clientUserMessageId: 'om_lark_turn',
            additionalContext: {
              botmux_sender: { kind: 'untrusted', value: '肖明科' },
            },
          },
        },
      });
      target.respond({
        type: 'response',
        requestId: message.requestId,
        resultType: 'success',
        method: message.method,
        handledByClientId: 'desktop-owner',
        result: { method: message.method, result: { result: { turn: { id: 'turn-native' } } } },
      });
    });

    await expect(sendCodexDesktopThreadTurn({
      threadId: '01a02459-7f00-7022-917a-d7e400dab649',
      turnId: 'om_lark_turn',
      input: {
        text: '从飞书继续',
        additionalContext: {
          botmux_sender: { kind: 'untrusted', value: '肖明科' },
        },
        localImages: [{ path: '/tmp/example.png', detail: 'high' }],
      },
    }, {
      connect: () => asSocket(socket),
      pathExists: () => true,
      timeoutMs: 100,
    })).resolves.toMatchObject({ ownerClientId: 'desktop-owner' });
    expect(socket.destroyed).toBe(true);
  });

  it('fails closed as offline when no Desktop window owns the thread', async () => {
    const socket = readySocket((target, message) => {
      target.respond({
        type: 'response',
        requestId: message.requestId,
        resultType: 'error',
        error: 'no-client-found',
      });
    });

    await expect(probeCodexDesktopThread('01a02459-7f00-7022-917a-d7e400dab649', {
      connect: () => asSocket(socket),
      timeoutMs: 100,
    })).rejects.toBeInstanceOf(CodexDesktopUnavailableError);
    expect(socket.destroyed).toBe(true);
  });

  it('reports a socket connection failure immediately instead of waiting for the request timeout', async () => {
    const socket = new FakeSocket();
    queueMicrotask(() => socket.emit('error', new Error('connect refused')));

    await expect(probeCodexDesktopThread('01a02459-7f00-7022-917a-d7e400dab649', {
      connect: () => asSocket(socket),
      timeoutMs: 100,
    })).rejects.toThrow('connect refused');
    expect(socket.destroyed).toBe(true);
  });
});

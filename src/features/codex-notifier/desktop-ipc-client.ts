import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { CodexAppTurnInput } from '../../types.js';

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IPC_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const IPC_VERSION = 1;

type JsonObject = Record<string, any>;

interface IpcResponse extends JsonObject {
  type: 'response';
  requestId: string;
  resultType: 'success' | 'error';
  method?: string;
  handledByClientId?: string;
  result?: JsonObject;
  error?: string;
}

export interface CodexDesktopIpcOptions {
  socketPath?: string;
  timeoutMs?: number;
  connect?: (path: string) => Socket;
  pathExists?: (path: string) => boolean;
}

export class CodexDesktopUnavailableError extends Error {
  readonly code = 'codex_desktop_unavailable';

  constructor(message = 'Codex App 当前离线，或该任务未在 Codex App 中打开') {
    super(message);
    this.name = 'CodexDesktopUnavailableError';
  }
}

function encodeIpcFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

class CodexDesktopIpcClient {
  private socket: Socket | undefined;
  private clientId: string | undefined;
  private readonly pending = new Map<string, {
    resolve: (response: IpcResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private header = Buffer.allocUnsafe(4);
  private headerOffset = 0;
  private frame: Buffer | undefined;
  private frameOffset = 0;
  private closed = false;

  constructor(private readonly options: CodexDesktopIpcOptions) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    const socketPath = this.options.socketPath
      ?? join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'ipc', 'ipc.sock');
    const connect = this.options.connect ?? (path => createConnection(path));
    let socket: Socket;
    try {
      socket = connect(socketPath);
    } catch (error) {
      throw new CodexDesktopUnavailableError(
        `Codex App IPC 无法连接：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.socket = socket;
    socket.on('data', chunk => this.consume(chunk));
    socket.on('error', error => this.failAll(new CodexDesktopUnavailableError(`Codex App IPC 连接失败：${error.message}`)));
    socket.on('close', () => {
      if (!this.closed) this.failAll(new CodexDesktopUnavailableError('Codex App IPC 已断开'));
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutMs = this.timeoutMs();
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('error', onConnectError);
        socket.off('close', onConnectClose);
        action();
      };
      const onConnectError = (error: Error): void => finish(() => reject(
        new CodexDesktopUnavailableError(`Codex App IPC 连接失败：${error.message}`),
      ));
      const onConnectClose = (): void => finish(() => reject(
        new CodexDesktopUnavailableError('Codex App IPC 在初始化前断开'),
      ));
      const timer = setTimeout(() => {
        finish(() => reject(new CodexDesktopUnavailableError('Codex App IPC 连接超时')));
      }, timeoutMs);
      timer.unref?.();
      socket.once('error', onConnectError);
      socket.once('close', onConnectClose);
      socket.once('connect', () => {
        void this.requestRaw('initialize', { clientType: 'botmux-codex-desktop-follower' }, {
          includeVersion: false,
          requireInitialized: false,
        }).then(response => {
          const clientId = response.result?.clientId;
          if (typeof clientId !== 'string' || !clientId) {
            throw new Error('Codex App IPC 初始化响应缺少 clientId');
          }
          this.clientId = clientId;
          finish(resolve);
        }, error => finish(() => reject(error)));
      });
    });
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('Codex Desktop IPC client closed'));
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = undefined;
  }

  async findThreadOwner(threadId: string): Promise<string> {
    const response = await this.requestRaw('thread-owner-discovery', {
      hostId: 'local',
      conversationId: threadId,
    });
    const ownerClientId = response.handledByClientId;
    if (!ownerClientId) throw new CodexDesktopUnavailableError();
    return ownerClientId;
  }

  async startTurn(
    threadId: string,
    ownerClientId: string,
    turnId: string,
    input: CodexAppTurnInput,
  ): Promise<void> {
    const pathExists = this.options.pathExists ?? existsSync;
    const nativeInput: Array<Record<string, unknown>> = [
      { type: 'text', text: input.text, text_elements: [] },
    ];
    for (const image of input.localImages ?? []) {
      if (!isAbsolute(image.path) || !pathExists(image.path)) continue;
      nativeInput.push({
        type: 'localImage',
        path: image.path,
        ...(image.detail ? { detail: image.detail } : {}),
      });
    }
    const response = await this.requestRaw('thread-follower-start-turn', {
      conversationId: threadId,
      turnStartParams: {
        input: nativeInput,
        clientUserMessageId: turnId,
        ...(input.additionalContext && Object.keys(input.additionalContext).length > 0
          ? { additionalContext: input.additionalContext }
          : {}),
      },
    }, { targetClientId: ownerClientId });
    if (response.method !== 'thread-follower-start-turn') {
      throw new Error('Codex App follower 响应方法不匹配');
    }
  }

  private timeoutMs(): number {
    const value = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
  }

  private async requestRaw(
    method: string,
    params: JsonObject,
    opts: {
      targetClientId?: string;
      includeVersion?: boolean;
      requireInitialized?: boolean;
    } = {},
  ): Promise<IpcResponse> {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) {
      throw new CodexDesktopUnavailableError('Codex App IPC 未连接');
    }
    if (opts.requireInitialized !== false && !this.clientId) {
      throw new CodexDesktopUnavailableError('Codex App IPC 尚未初始化');
    }
    const requestId = randomUUID();
    const timeoutMs = this.timeoutMs();
    const response = await new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CodexDesktopUnavailableError(`Codex App IPC 请求超时：${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      socket.write(encodeIpcFrame({
        type: 'request',
        requestId,
        ...(this.clientId ? { sourceClientId: this.clientId } : {}),
        ...(opts.includeVersion === false ? {} : { version: IPC_VERSION }),
        method,
        params,
        ...(opts.targetClientId ? { targetClientId: opts.targetClientId } : {}),
        timeoutMs,
      }));
    });
    if (response.resultType === 'error') {
      if (
        response.error === 'no-client-found'
        || response.error === 'client-not-found'
        || response.error === 'client-disconnected'
      ) {
        throw new CodexDesktopUnavailableError();
      }
      throw new Error(`Codex App IPC ${method} 失败：${response.error ?? 'unknown_error'}`);
    }
    return response;
  }

  private consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.frame) {
        const headerBytes = Math.min(4 - this.headerOffset, chunk.length - offset);
        chunk.copy(this.header, this.headerOffset, offset, offset + headerBytes);
        this.headerOffset += headerBytes;
        offset += headerBytes;
        if (this.headerOffset < 4) continue;
        const frameLength = this.header.readUInt32LE(0);
        this.headerOffset = 0;
        if (frameLength === 0 || frameLength > IPC_MAX_FRAME_BYTES) {
          this.failAll(new Error(`Codex App IPC 帧长度无效：${frameLength}`));
          this.close();
          return;
        }
        this.frame = Buffer.allocUnsafe(frameLength);
        this.frameOffset = 0;
      }
      const frameBytes = Math.min(this.frame.length - this.frameOffset, chunk.length - offset);
      chunk.copy(this.frame, this.frameOffset, offset, offset + frameBytes);
      this.frameOffset += frameBytes;
      offset += frameBytes;
      if (this.frameOffset < this.frame.length) continue;
      const completed = this.frame;
      this.frame = undefined;
      this.frameOffset = 0;
      let message: JsonObject;
      try {
        message = JSON.parse(completed.toString('utf8')) as JsonObject;
      } catch {
        this.failAll(new Error('Codex App IPC 返回了无效 JSON'));
        this.close();
        return;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonObject): void {
    if (message.type === 'client-discovery-request' && typeof message.requestId === 'string') {
      this.socket?.write(encodeIpcFrame({
        type: 'client-discovery-response',
        requestId: message.requestId,
        response: { canHandle: false },
      }));
      return;
    }
    if (message.type !== 'response' || typeof message.requestId !== 'string') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message as IpcResponse);
  }

  private failAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function validateThreadId(threadId: string): void {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error('Codex App threadId 格式无效');
}

async function withClient<T>(
  options: CodexDesktopIpcOptions,
  action: (client: CodexDesktopIpcClient) => Promise<T>,
): Promise<T> {
  const client = new CodexDesktopIpcClient(options);
  try {
    await client.connect();
    return await action(client);
  } finally {
    client.close();
  }
}

/** Prove that the running Codex Desktop owns this exact native thread. */
export async function probeCodexDesktopThread(
  threadId: string,
  options: CodexDesktopIpcOptions = {},
): Promise<string> {
  validateThreadId(threadId);
  return withClient(options, client => client.findThreadOwner(threadId));
}

/** Send one turn through Codex Desktop's native owner/follower protocol. */
export async function sendCodexDesktopThreadTurn(
  request: {
    threadId: string;
    turnId: string;
    input: CodexAppTurnInput;
  },
  options: CodexDesktopIpcOptions = {},
): Promise<{ ownerClientId: string }> {
  validateThreadId(request.threadId);
  if (!request.turnId) throw new Error('Codex App follower turnId 不能为空');
  return withClient(options, async client => {
    const ownerClientId = await client.findThreadOwner(request.threadId);
    await client.startTurn(request.threadId, ownerClientId, request.turnId, request.input);
    return { ownerClientId };
  });
}

import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

interface IpcResponse {
  type: 'response';
  requestId: string;
  method?: string;
  resultType: 'success' | 'error';
  handledByClientId?: string;
  result?: any;
  error?: string;
}

interface PendingRequest {
  resolve(response: IpcResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface IpcBroadcast {
  type: 'broadcast';
  method: string;
  version?: number;
  sourceClientId?: string;
  targetClientIds?: string[];
  params?: any;
}

export interface DesktopIpcOptions {
  socketPath?: string;
  timeoutMs?: number;
}

export interface DesktopTurnInput {
  threadId: string;
  text: string;
  clientUserMessageId: string;
}

export interface DesktopTurnCompletion {
  turnId: string;
  status: 'completed' | 'failed' | 'cancelled';
  finalText: string;
  cwd: string;
  title: string;
}

export interface DesktopTurnHandle {
  turnId: string;
  completion: Promise<DesktopTurnCompletion>;
}

type NativeTurn = {
  turnId?: string;
  status?: string;
  error?: unknown;
  params?: { clientUserMessageId?: string; input?: Array<{ type?: string; text?: string }>; cwd?: string };
  items?: Array<{ type?: string; phase?: string; text?: string }>;
};

type StreamPatch = { op: 'add' | 'replace' | 'remove'; path: Array<string | number>; value?: unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  // The stream can fail between subscription and returning the public handle.
  // Mark the promise observed immediately; callers still receive the original
  // rejection when they await it, without a process-level unhandled rejection.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function applyPatch(target: unknown, path: Array<string | number>, patch: StreamPatch): void {
  if (path.length === 0 || !target || typeof target !== 'object') return;
  let parent: any = target;
  for (const segment of path.slice(0, -1)) {
    if (!parent || typeof parent !== 'object') return;
    parent = parent[segment];
  }
  if (!parent || typeof parent !== 'object') return;
  const key = path.at(-1)!;
  if (patch.op === 'remove') {
    if (Array.isArray(parent) && typeof key === 'number') parent.splice(key, 1);
    else delete parent[key];
    return;
  }
  if (Array.isArray(parent) && typeof key === 'number' && patch.op === 'add') {
    parent.splice(key, 0, patch.value);
  } else {
    parent[key] = patch.value;
  }
}

class DesktopTurnTracker {
  private readonly snapshot = deferred<void>();
  private readonly completed = deferred<DesktopTurnCompletion>();
  private snapshotSettled = false;
  private completionSettled = false;
  private revision: number | undefined;
  private cwd = '';
  private title = '';
  private turnId: string | undefined;
  private turnKey: string | undefined;
  private turn: NativeTurn | undefined;

  constructor(
    private readonly threadId: string,
    private readonly clientUserMessageId: string,
    private readonly ownerClientId: string,
    private readonly selfClientId: string,
  ) {}

  async waitForSnapshot(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.snapshot.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('desktop_stream_snapshot_timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  setTurnId(turnId: string): void {
    this.turnId = turnId;
    if (this.turn?.turnId !== turnId) {
      this.turn = undefined;
      this.turnKey = undefined;
    }
    this.finishIfTerminal();
  }

  completion(): Promise<DesktopTurnCompletion> {
    return this.completed.promise;
  }

  handle(message: IpcBroadcast): void {
    if (message.method !== 'thread-stream-state-changed'
      || message.version !== 11
      || message.sourceClientId !== this.ownerClientId
      || (message.targetClientIds && !message.targetClientIds.includes(this.selfClientId))
      || message.params?.conversationId !== this.threadId
      || message.params?.hostId !== 'local') return;
    const change = message.params.change;
    if (change?.type === 'snapshot') {
      this.revision = change.revision;
      this.cwd = typeof change.conversationState?.cwd === 'string' ? change.conversationState.cwd : '';
      this.title = typeof change.conversationState?.title === 'string' ? change.conversationState.title : '';
      for (const [key, candidate] of Object.entries(
        change.conversationState?.turnHistory?.history?.entitiesByKey ?? {},
      )) this.captureTurn(key, candidate);
      if (!this.snapshotSettled) {
        this.snapshotSettled = true;
        this.snapshot.resolve();
      }
      this.finishIfTerminal();
      return;
    }
    if (change?.type !== 'patches' || !this.snapshotSettled) return;
    if (change.baseRevision !== this.revision) {
      this.fail(new Error('desktop_stream_revision_mismatch'));
      return;
    }
    for (const patch of change.patches as StreamPatch[]) this.handlePatch(patch);
    this.revision = change.revision;
    this.finishIfTerminal();
  }

  fail(error: Error): void {
    if (!this.snapshotSettled) {
      this.snapshotSettled = true;
      this.snapshot.reject(error);
    }
    if (!this.completionSettled) {
      this.completionSettled = true;
      this.completed.reject(error);
    }
  }

  private handlePatch(patch: StreamPatch): void {
    const prefix = ['turnHistory', 'history', 'entitiesByKey'];
    if (patch.path.length < 4 || prefix.some((segment, index) => patch.path[index] !== segment)) return;
    const key = patch.path[3];
    if (typeof key !== 'string') return;
    if (patch.path.length === 4) {
      if (patch.op === 'remove') {
        if (this.turnKey === key) this.fail(new Error('desktop_stream_turn_removed'));
        return;
      }
      this.captureTurn(key, patch.value);
      return;
    }
    if (key === this.turnKey && this.turn) applyPatch(this.turn, patch.path.slice(4), patch);
  }

  private captureTurn(key: string, value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const turn = value as NativeTurn;
    if (turn.turnId !== this.turnId && turn.params?.clientUserMessageId !== this.clientUserMessageId) return;
    this.turnKey = key;
    this.turn = turn;
  }

  private finishIfTerminal(): void {
    if (this.completionSettled || !this.turnId || this.turn?.turnId !== this.turnId) return;
    const nativeStatus = this.turn.status;
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(nativeStatus ?? '')) return;
    const agentMessages = (this.turn.items ?? []).filter(item => item.type === 'agentMessage');
    const final = [...agentMessages].reverse().find(item => item.phase === 'final_answer')
      ?? agentMessages.at(-1);
    const errorText = typeof this.turn.error === 'string'
      ? this.turn.error
      : this.turn.error && typeof this.turn.error === 'object'
        ? JSON.stringify(this.turn.error)
        : '';
    const inputTitle = this.turn.params?.input?.find(item => item.type === 'text')?.text ?? '';
    this.completionSettled = true;
    this.completed.resolve({
      turnId: this.turnId,
      status: nativeStatus === 'completed' ? 'completed' : nativeStatus === 'failed' ? 'failed' : 'cancelled',
      finalText: final?.text?.trim() || errorText || (nativeStatus === 'completed' ? '任务已完成。' : '任务未完成。'),
      cwd: this.turn.params?.cwd?.trim() || this.cwd,
      title: this.title.trim() || inputTitle.trim(),
    });
  }
}

function defaultSocketPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(codexHome, 'ipc', 'ipc.sock');
}

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw new Error('desktop_ipc_frame_too_large');
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

class DesktopIpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private buffered = Buffer.alloc(0);
  private clientId: string | undefined;
  private tracker: DesktopTurnTracker | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    socket.on('data', chunk => this.onData(chunk));
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('desktop_ipc_closed')));
  }

  static async connect(options: DesktopIpcOptions): Promise<DesktopIpcClient> {
    const socketPath = options.socketPath ?? defaultSocketPath();
    const info = await lstat(socketPath).catch(() => undefined);
    const uid = process.getuid?.();
    if (!info?.isSocket() || (uid !== undefined && info.uid !== uid)) {
      throw new Error('desktop_ipc_unavailable');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('desktop_ipc_connect_timeout'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const client = new DesktopIpcClient(socket, timeoutMs);
    try {
      const initialized = await client.request('initialize', {
        clientType: 'botmux-desktop-handoff',
      }, 0);
      const clientId = initialized.result?.clientId;
      if (typeof clientId !== 'string' || !clientId) {
        throw new Error('desktop_ipc_initialize_failed');
      }
      client.clientId = clientId;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  close(): void {
    this.socket.destroy();
  }

  async followThread(threadId: string, ownerClientId: string, clientUserMessageId: string): Promise<DesktopTurnTracker> {
    if (!this.clientId) throw new Error('desktop_ipc_initialize_failed');
    const tracker = new DesktopTurnTracker(threadId, clientUserMessageId, ownerClientId, this.clientId);
    this.tracker = tracker;
    await this.broadcast('thread-stream-following-changed', {
      conversationId: threadId,
      hostId: 'local',
      following: true,
    }, 1, [ownerClientId]);
    await tracker.waitForSnapshot(this.timeoutMs);
    return tracker;
  }

  async unfollowThread(threadId: string, ownerClientId: string): Promise<void> {
    await this.broadcast('thread-stream-following-changed', {
      conversationId: threadId,
      hostId: 'local',
      following: false,
    }, 1, [ownerClientId]);
  }

  async findThreadOwner(threadId: string): Promise<string | undefined> {
    const response = await this.request('thread-owner-discovery', {
      hostId: 'local',
      conversationId: threadId,
    }, 1);
    return typeof response.handledByClientId === 'string' && response.handledByClientId
      ? response.handledByClientId
      : undefined;
  }

  async startTurn(input: DesktopTurnInput, ownerClientId: string): Promise<{ turnId: string }> {
    const response = await this.request('thread-follower-start-turn', {
      conversationId: input.threadId,
      turnStart: {
        request: {
          threadId: input.threadId,
          input: [{ type: 'text', text: input.text, text_elements: [] }],
          clientUserMessageId: input.clientUserMessageId,
        },
        context: { inheritThreadSettings: true },
      },
    }, 2, ownerClientId);
    const turnId = response.result?.result?.turn?.id;
    if (typeof turnId !== 'string' || !turnId) throw new Error('desktop_turn_not_started');
    return { turnId };
  }

  private request(
    method: string,
    params: unknown,
    version: number,
    targetClientId?: string,
  ): Promise<IpcResponse> {
    const requestId = randomUUID();
    const message = {
      type: 'request',
      requestId,
      ...(this.clientId ? { sourceClientId: this.clientId } : {}),
      version,
      method,
      params,
      ...(targetClientId ? { targetClientId } : {}),
      timeoutMs: this.timeoutMs,
    };
    return new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`desktop_ipc_timeout:${method}`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(encodeFrame(message), error => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  private broadcast(
    method: string,
    params: unknown,
    version: number,
    targetClientIds?: string[],
  ): Promise<void> {
    if (!this.clientId) return Promise.reject(new Error('desktop_ipc_initialize_failed'));
    return new Promise<void>((resolve, reject) => {
      this.socket.write(encodeFrame({
        type: 'broadcast', method, sourceClientId: this.clientId, version, params,
        ...(targetClientIds ? { targetClientIds } : {}),
      }), error => error ? reject(error) : resolve());
    });
  }

  private onData(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    for (;;) {
      if (this.buffered.length < 4) return;
      const length = this.buffered.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.fail(new Error('desktop_ipc_invalid_frame'));
        this.socket.destroy();
        return;
      }
      if (this.buffered.length < length + 4) return;
      const payload = this.buffered.subarray(4, length + 4);
      this.buffered = this.buffered.subarray(length + 4);
      let message: any;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch {
        this.fail(new Error('desktop_ipc_invalid_json'));
        this.socket.destroy();
        return;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: any): void {
    if (message?.type === 'client-discovery-request' && typeof message.requestId === 'string') {
      this.socket.write(encodeFrame({
        type: 'client-discovery-response',
        requestId: message.requestId,
        response: { canHandle: false },
      }));
      return;
    }
    if (message?.type === 'broadcast') {
      this.tracker?.handle(message as IpcBroadcast);
      return;
    }
    if (message?.type !== 'response' || typeof message.requestId !== 'string') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.resultType === 'success') pending.resolve(message as IpcResponse);
    else pending.reject(new Error(`desktop_ipc_request_failed:${message.method ?? 'unknown'}:${message.error ?? 'error'}`));
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.tracker?.fail(error);
  }
}

function validateThreadId(threadId: string): void {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error('invalid_desktop_thread_id');
}

function isOfflineError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('no-client-found')
    || message === 'desktop_ipc_unavailable'
    || message === 'desktop_ipc_closed'
    || message === 'desktop_ipc_connect_timeout'
    || message.startsWith('desktop_ipc_timeout:')
    || message.startsWith('connect ENOENT')
    || message.startsWith('connect ECONNREFUSED')
    || message.startsWith('read ECONNRESET')
    || message.startsWith('write EPIPE');
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.endsWith(':thread-busy') || message.endsWith(':thread_busy');
}

async function withClient<T>(
  options: DesktopIpcOptions,
  operation: (client: DesktopIpcClient) => Promise<T>,
): Promise<T> {
  const client = await DesktopIpcClient.connect(options);
  try {
    return await operation(client);
  } finally {
    client.close();
  }
}

export async function probeDesktopThread(
  threadId: string,
  options: DesktopIpcOptions = {},
): Promise<boolean> {
  validateThreadId(threadId);
  try {
    return await withClient(options, async client => !!(await client.findThreadOwner(threadId)));
  } catch (error) {
    if (isOfflineError(error)) return false;
    throw error;
  }
}

export async function sendDesktopTurn(
  input: DesktopTurnInput,
  options: DesktopIpcOptions = {},
): Promise<DesktopTurnHandle> {
  validateThreadId(input.threadId);
  if (!input.text.trim()) throw new Error('invalid_desktop_turn_text');
  if (!input.clientUserMessageId.trim()) throw new Error('invalid_desktop_client_message_id');
  let turnRequestStarted = false;
  let client: DesktopIpcClient | undefined;
  let owner: string | undefined;
  try {
    client = await DesktopIpcClient.connect(options);
    owner = await client.findThreadOwner(input.threadId);
    if (!owner) throw new Error('desktop_thread_offline');
    const tracker = await client.followThread(input.threadId, owner, input.clientUserMessageId);
    turnRequestStarted = true;
    const { turnId } = await client.startTurn({ ...input, text: input.text.trim() }, owner);
    tracker.setTurnId(turnId);
    const activeClient = client;
    const activeOwner = owner;
    const completion = tracker.completion().finally(async () => {
      await activeClient.unfollowThread(input.threadId, activeOwner).catch(() => undefined);
      activeClient.close();
    });
    return { turnId, completion };
  } catch (error) {
    if (client && owner) await client.unfollowThread(input.threadId, owner).catch(() => undefined);
    client?.close();
    if (isBusyError(error)) throw new Error('desktop_thread_busy');
    if (turnRequestStarted) throw new Error('desktop_turn_delivery_unknown');
    if (isOfflineError(error)) throw new Error('desktop_thread_offline');
    throw error;
  }
}

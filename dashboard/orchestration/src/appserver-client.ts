import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

// ─── Protocol types (minimal, matching codex app-server JSON-RPC) ────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

export interface AppServerConfig {
  url: string;
  autoApprove?: boolean;
  reconnectMs?: number;
  interruptTimeoutMs?: number;
}

export interface ThreadInfo {
  threadId: string;
  sessionId: string;
  model: string;
  cwd: string;
}

export interface TurnInfo {
  turnId: string;
  status: string;
}

export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

export type AppServerSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type AppServerSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
    type: 'workspaceWrite';
    writableRoots: string[];
    networkAccess: boolean;
    excludeTmpdirEnvVar: boolean;
    excludeSlashTmp: boolean;
  };

export interface AppServerTokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cacheWriteInputTokens?: number;
}

export interface AppServerThreadTokenUsage {
  last: AppServerTokenUsageBreakdown;
  total: AppServerTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

// ─── Events emitted by AppServerClient ──────────────────────────────────────

export interface AppServerEvents {
  'thread:started': (threadId: string) => void;
  'turn:started': (threadId: string, turnId: string) => void;
  'turn:completed': (threadId: string, turnId: string, status: string) => void;
  'turn:failed': (threadId: string, turnId: string, error: string) => void;
  'item:started': (threadId: string, turnId: string, item: Record<string, unknown>) => void;
  'item:completed': (threadId: string, turnId: string, item: Record<string, unknown>) => void;
  'agentMessage:delta': (threadId: string, turnId: string, itemId: string, delta: string) => void;
  'reasoning:summaryDelta': (
    threadId: string, turnId: string, itemId: string, summaryIndex: number, delta: string,
  ) => void;
  'tokenUsage:updated': (threadId: string, turnId: string, usage: AppServerThreadTokenUsage) => void;
  'commandExec:outputDelta': (threadId: string, turnId: string, itemId: string, delta: string) => void;
  'process:outputDelta': (threadId: string, processId: string, stream: string, delta: string) => void;
  'process:exited': (threadId: string, processId: string, exitCode: number) => void;
  'error': (threadId: string | null, message: string) => void;
  'connected': () => void;
  'disconnected': () => void;
}

// ─── AppServerClient ────────────────────────────────────────────────────────

export class AppServerClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private config: Required<AppServerConfig>;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private _connected = false;

  constructor(config: AppServerConfig) {
    super();
    this.config = {
      url: config.url,
      autoApprove: config.autoApprove ?? true,
      reconnectMs: config.reconnectMs ?? 5_000,
      interruptTimeoutMs: config.interruptTimeoutMs ?? 15_000,
    };
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected) return;
    if (this.ws) {
      throw new Error('App-server connection is already in progress');
    }
    this.closed = false;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.url);
      this.ws = ws;
      let settled = false;

      const resolveConnection = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const rejectConnection = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      ws.on('open', () => {
        // Send initialize handshake
        this.request('initialize', {
          clientInfo: { name: 'devteam-dashboard', title: 'DevTeam Dashboard', version: '0.1.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }).then(() => {
          this._connected = true;
          this.emit('connected');
          resolveConnection();
        }).catch((error: unknown) => {
          rejectConnection(error instanceof Error ? error : new Error(String(error)));
          ws.close();
        });
      });

      ws.on('message', (data) => {
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.handleMessage(msg);
      });

      ws.on('close', () => {
        this._connected = false;
        this.emit('disconnected');
        this.rejectAllPending('Connection closed');
        if (this.ws === ws) this.ws = null;
        rejectConnection(new Error('App-server connection closed before initialization'));
        if (!this.closed) this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.emitError(null, error.message);
        rejectConnection(error);
        // 'close' will follow
      });
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this.rejectAllPending('Client closed');
  }

  // ─── High-level API ─────────────────────────────────────────────────────

  async createThread(params: {
    cwd: string;
    runtimeWorkspaceRoots?: string[];
    model?: string;
    approvalPolicy?: string;
    sandbox?: AppServerSandboxMode;
    baseInstructions?: string;
    personality?: string;
  }): Promise<ThreadInfo> {
    const result = await this.request('thread/start', {
      cwd: params.cwd,
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
      model: params.model,
      approvalPolicy: params.approvalPolicy ?? 'never',
      sandbox: params.sandbox ?? 'danger-full-access',
      baseInstructions: params.baseInstructions,
      personality: params.personality ?? 'pragmatic',
      ephemeral: false,
    }) as { thread: { id: string; sessionId: string; cwd: string }; model: string };

    return {
      threadId: result.thread.id,
      sessionId: result.thread.sessionId,
      model: result.model,
      cwd: result.thread.cwd,
    };
  }

  async resumeThread(threadId: string, params?: {
    cwd?: string;
    runtimeWorkspaceRoots?: string[];
    model?: string;
    sandbox?: AppServerSandboxMode;
  }): Promise<ThreadInfo> {
    const result = await this.request('thread/resume', {
      threadId,
      cwd: params?.cwd,
      runtimeWorkspaceRoots: params?.runtimeWorkspaceRoots,
      model: params?.model,
      sandbox: params?.sandbox,
    }) as { thread: { id: string; sessionId: string; cwd: string }; model: string };

    return {
      threadId: result.thread.id,
      sessionId: result.thread.sessionId,
      model: result.model,
      cwd: result.thread.cwd,
    };
  }

  async startTurn(threadId: string, input: string, params?: {
    model?: string;
    cwd?: string;
    runtimeWorkspaceRoots?: string[];
    sandboxPolicy?: AppServerSandboxPolicy;
    effort?: string;
    summary?: ReasoningSummary;
  }): Promise<TurnInfo> {
    const result = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: input, text_elements: [] }],
      model: params?.model,
      cwd: params?.cwd,
      runtimeWorkspaceRoots: params?.runtimeWorkspaceRoots,
      sandboxPolicy: params?.sandboxPolicy,
      effort: params?.effort,
      summary: params?.summary,
    }) as { turn: { id: string; status: string } };

    return { turnId: result.turn.id, status: result.turn.status };
  }

  async steerTurn(threadId: string, turnId: string, input: string): Promise<TurnInfo> {
    const result = await this.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: input, text_elements: [] }],
    }) as { turnId: string };

    return { turnId: result.turnId, status: 'inProgress' };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    let cleanup = (): void => {};
    const completed = new Promise<void>((resolve, reject) => {
      const onCompleted = (completedThreadId: string, completedTurnId: string, status: string): void => {
        if (completedThreadId !== threadId || completedTurnId !== turnId) return;
        cleanup();
        if (status === 'interrupted') resolve();
        else reject(new Error(`Turn ${turnId} completed with status ${status} while interrupting`));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for turn ${turnId} to be interrupted`));
      }, this.config.interruptTimeoutMs);
      timeout.unref();
      cleanup = () => {
        clearTimeout(timeout);
        this.removeListener('turn:completed', onCompleted);
      };
      this.on('turn:completed', onCompleted);
    });

    try {
      await Promise.all([
        this.request('turn/interrupt', { threadId, turnId }),
        completed,
      ]);
    } finally {
      cleanup();
    }
  }

  async injectItems(threadId: string, items: unknown[]): Promise<void> {
    await this.request('thread/injectItems', { threadId, items });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request('thread/archive', { threadId });
  }

  // ─── Low-level JSON-RPC ─────────────────────────────────────────────────

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });

      // Timeout after 120s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 120_000);
    });
  }

  private sendResponse(id: number, result: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to our request
    if ('id' in msg && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Notification from server
    if (!('id' in msg) && 'method' in msg) {
      this.handleNotification(msg as JsonRpcNotification);
      return;
    }

    // Server request (expects response)
    if ('id' in msg && 'method' in msg) {
      this.handleServerRequest(msg as JsonRpcRequest);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    const params = (msg.params || {}) as Record<string, unknown>;
    const threadId = params.threadId as string | undefined;
    const turnId = params.turnId as string | undefined;

    switch (msg.method) {
      case 'thread/started': {
        const thread = params.thread as { id: string } | undefined;
        if (thread) this.emit('thread:started', thread.id);
        break;
      }
      case 'turn/started': {
        const turn = params.turn as { id: string } | undefined;
        if (turn && threadId) this.emit('turn:started', threadId, turn.id);
        break;
      }
      case 'turn/completed': {
        const turn = params.turn as { id: string; status?: string } | undefined;
        if (turn && threadId) this.emit('turn:completed', threadId, turn.id, turn.status || 'unknown');
        break;
      }
      case 'item/started': {
        if (threadId && turnId) this.emit('item:started', threadId, turnId, params.item as Record<string, unknown>);
        break;
      }
      case 'item/completed': {
        if (threadId && turnId) this.emit('item:completed', threadId, turnId, params.item as Record<string, unknown>);
        break;
      }
      case 'agentMessage/delta': {
        if (threadId && turnId) {
          this.emit('agentMessage:delta', threadId, turnId, params.itemId as string, params.delta as string);
        }
        break;
      }
      case 'item/reasoning/summaryTextDelta': {
        if (threadId && turnId) {
          this.emit(
            'reasoning:summaryDelta',
            threadId,
            turnId,
            params.itemId as string,
            Number(params.summaryIndex || 0),
            params.delta as string,
          );
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        if (threadId && turnId && params.tokenUsage) {
          this.emit('tokenUsage:updated', threadId, turnId, params.tokenUsage as AppServerThreadTokenUsage);
        }
        break;
      }
      case 'commandExecution/outputDelta':
      case 'commandExec/outputDelta': {
        if (threadId && turnId) {
          this.emit('commandExec:outputDelta', threadId, turnId, params.itemId as string, params.delta as string);
        }
        break;
      }
      case 'process/outputDelta': {
        if (threadId) {
          this.emit('process:outputDelta', threadId, params.processHandle as string,
            params.stream as string, params.deltaBase64 as string);
        }
        break;
      }
      case 'process/exited': {
        if (threadId) {
          this.emit('process:exited', threadId, params.processHandle as string, params.exitCode as number);
        }
        break;
      }
      case 'error': {
        const error = params.error as { message: string } | undefined;
        this.emitError(threadId ?? null, error?.message ?? 'Unknown error');
        break;
      }
    }
  }

  private handleServerRequest(msg: JsonRpcRequest): void {
    const params = (msg.params || {}) as Record<string, unknown>;

    // Auto-approve command executions if configured
    if (this.config.autoApprove && msg.method === 'item/commandExecution/requestApproval') {
      this.sendResponse(msg.id, 'acceptForSession');
      return;
    }
    if (this.config.autoApprove && msg.method === 'item/fileChange/requestApproval') {
      this.sendResponse(msg.id, 'acceptForSession');
      return;
    }
    if (this.config.autoApprove && msg.method === 'item/permissions/requestApproval') {
      this.sendResponse(msg.id, {
        permissions: { level: 'dangerFullAccess' },
        scope: 'session',
      });
      return;
    }

    // Reject unknown server requests
    this.sendResponse(msg.id, { error: 'Not supported' });
  }

  private rejectAllPending(reason: string): void {
    for (const [, { reject }] of this.pending) {
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  private emitError(threadId: string | null, message: string): void {
    // EventEmitter treats the `error` event specially and throws when there is
    // no listener. A transport failure can happen before a session bridge has
    // registered its listener, so only publish it when it can be consumed.
    if (this.listenerCount('error') > 0) {
      this.emit('error', threadId, message);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => { /* will retry */ });
    }, this.config.reconnectMs);
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: AppServerClient | null = null;

export function getAppServerClient(config?: AppServerConfig): AppServerClient {
  if (!instance && config) {
    instance = new AppServerClient(config);
  }
  if (!instance) {
    throw new Error('AppServerClient not initialized. Call with config first.');
  }
  return instance;
}

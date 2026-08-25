import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AppServerClient, AppServerThreadTokenUsage } from './appserver-client.js';

// ─── Session metadata format (compatible with session-capture.js output) ─────

interface SessionMetadata {
  schemaVersion: 2;
  runId: string;
  attemptId: string;
  inngestRunId: string;
  inngestAttempt: number;
  flowId: string;
  step: string;
  threadId: string | null;
  turnId: string | null;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  } | null;
  errorSummary: { stage: string; message: string } | null;
}

export interface SessionBridgeConfig {
  workDir: string;
  flowId: string;
  step: string;
  attemptId: string;
  inngestRunId: string;
  inngestAttempt: number;
  sessionRunId: string;
  logFile: string;
}

export interface SessionBridgeEvents {
  'log': (line: string) => void;
  'completed': (exitCode: number) => void;
  'failed': (error: string) => void;
  'threadId': (threadId: string) => void;
  'outputDelta': (text: string) => void;
}

/**
 * Bridges app-server WebSocket events into the same metadata JSON format
 * that session-capture.js produces, plus writes log files compatible with
 * the existing watcher/tailer infrastructure.
 */
export class AppServerSessionBridge extends EventEmitter {
  private metadata: SessionMetadata;
  private metadataPath: string;
  private logStream: fs.WriteStream | null = null;
  private boundThreadId: string | null = null;
  private boundTurnId: string | null = null;
  private finalized = false;
  private _finalAgentMessage = '';
  private reasoningItems = new Set<string>();
  private usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };

  constructor(
    private readonly client: AppServerClient,
    private readonly config: SessionBridgeConfig,
  ) {
    super();
    this.metadataPath = path.join(config.workDir, 'sessions', config.step, `${config.sessionRunId}.json`);
    this.metadata = {
      schemaVersion: 2,
      runId: config.sessionRunId,
      attemptId: config.attemptId,
      inngestRunId: config.inngestRunId,
      inngestAttempt: config.inngestAttempt,
      flowId: config.flowId,
      step: config.step,
      threadId: null,
      turnId: null,
      status: 'starting',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      usage: null,
      errorSummary: null,
    };
  }

  start(resetMetadata = true): void {
    // Ensure directories exist
    fs.mkdirSync(path.dirname(this.metadataPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.config.logFile), { recursive: true });

    // If resuming, load existing metadata instead of creating new
    if (!resetMetadata) {
      try {
        const existing = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8')) as SessionMetadata;
        if (existing.runId === this.config.sessionRunId) {
          this.metadata = {
            ...existing,
            attemptId: this.config.attemptId,
            inngestRunId: this.config.inngestRunId,
            inngestAttempt: this.config.inngestAttempt,
            turnId: null,
            status: 'running',
            finishedAt: null,
            exitCode: null,
            errorSummary: null,
          };
        }
      } catch { /* no existing metadata, use default */ }
    }

    // Open log file
    const logStream = fs.createWriteStream(this.config.logFile, { flags: 'a' });
    logStream.on('error', () => {
      if (this.logStream === logStream) this.logStream = null;
    });
    this.logStream = logStream;
    this._finalAgentMessage = '';
    this.reasoningItems.clear();

    // Wire up client events
    this.client.on('thread:started', this.onThreadStarted);
    this.client.on('turn:started', this.onTurnStarted);
    this.client.on('turn:completed', this.onTurnCompleted);
    this.client.on('item:started', this.onItemStarted);
    this.client.on('item:completed', this.onItemCompleted);
    this.client.on('agentMessage:delta', this.onAgentMessageDelta);
    this.client.on('reasoning:summaryDelta', this.onReasoningSummaryDelta);
    this.client.on('tokenUsage:updated', this.onTokenUsageUpdated);
    this.client.on('commandExec:outputDelta', this.onCommandExecDelta);
    this.client.on('process:outputDelta', this.onProcessDelta);
    this.client.on('process:exited', this.onProcessExited);
    this.client.on('error', this.onError);

    this.writeMetadata();
    this.appendLog(`[${new Date().toISOString()}] Session bridge started for ${this.config.flowId}/${this.config.step}\n`);
  }

  stop(): void {
    this.client.removeListener('thread:started', this.onThreadStarted);
    this.client.removeListener('turn:started', this.onTurnStarted);
    this.client.removeListener('turn:completed', this.onTurnCompleted);
    this.client.removeListener('item:started', this.onItemStarted);
    this.client.removeListener('item:completed', this.onItemCompleted);
    this.client.removeListener('agentMessage:delta', this.onAgentMessageDelta);
    this.client.removeListener('reasoning:summaryDelta', this.onReasoningSummaryDelta);
    this.client.removeListener('tokenUsage:updated', this.onTokenUsageUpdated);
    this.client.removeListener('commandExec:outputDelta', this.onCommandExecDelta);
    this.client.removeListener('process:outputDelta', this.onProcessDelta);
    this.client.removeListener('process:exited', this.onProcessExited);
    this.client.removeListener('error', this.onError);

    this.logStream?.end();
    this.logStream = null;
  }

  get finalAgentMessage(): string {
    return this._finalAgentMessage;
  }

  get isFinalized(): boolean {
    return this.finalized;
  }

  /**
   * Bind this bridge to the exact app-server thread returned by the request
   * that created or resumed it. The AppServerClient is shared by every active
   * flow, so a bridge must never infer ownership from a global notification.
   */
  bindThread(threadId: string): void {
    if (!threadId) throw new Error('Cannot bind a session bridge to an empty thread ID');
    if (this.boundThreadId && this.boundThreadId !== threadId) {
      throw new Error(`Session bridge is already bound to thread ${this.boundThreadId}`);
    }
    if (this.boundThreadId === threadId) return;

    this.boundThreadId = threadId;
    this.metadata.threadId = threadId;
    this.metadata.status = 'running';
    this.writeMetadata();
    this.emit('threadId', threadId);
    this.appendLog(`\x1b[35m\x1b[3mthread\x1b[0m\x1b[0m\nThread started: ${threadId}\n`);
  }

  /** Bind the bridge to the single turn owned by the current attempt. */
  bindTurn(turnId: string): void {
    if (!this.boundThreadId) throw new Error('Bind the session thread before binding its turn');
    if (!turnId) throw new Error('Cannot bind a session bridge to an empty turn ID');
    if (this.boundTurnId && this.boundTurnId !== turnId) {
      throw new Error(`Session bridge is already bound to turn ${this.boundTurnId}`);
    }
    if (this.boundTurnId === turnId) return;

    this.boundTurnId = turnId;
    this.metadata.turnId = turnId;
    this.writeMetadata();
    this.appendLog(`\n--- Turn ${turnId} started ---\n`);
  }

  // ─── Event handlers ─────────────────────────────────────────────────────

  private onThreadStarted = (threadId: string): void => {
    if (threadId !== this.boundThreadId) return;
    this.bindThread(threadId);
  };

  private onTurnStarted = (threadId: string, turnId: string): void => {
    if (!this.ownsThread(threadId)) return;
    if (this.boundTurnId && this.boundTurnId !== turnId) return;
    this.bindTurn(turnId);
  };

  private onTurnCompleted = (threadId: string, turnId: string): void => {
    if (!this.ownsTurn(threadId, turnId)) return;
    this.appendLog(`\n--- Turn completed ---\n`);
  };

  private onItemStarted = (threadId: string, turnId: string, item: Record<string, unknown>): void => {
    if (!this.ownsTurn(threadId, turnId)) return;
    const type = item.type as string;
    if (type === 'commandExecution') {
      const cmd = item.command as string || '';
      this.appendLog(`\x1b[35m\x1b[3mexec\x1b[0m\x1b[0m\n$ ${cmd}\n`);
    }
  };

  private onItemCompleted = (threadId: string, turnId: string, item: Record<string, unknown>): void => {
    if (!this.ownsTurn(threadId, turnId)) return;
    const type = item.type as string;
    if (type === 'agentMessage') {
      const text = item.text as string || '';
      this.appendLog(`\x1b[35m\x1b[3mcodex\x1b[0m\x1b[0m\n${text}\n`);
      this._finalAgentMessage = text;
      this.emit('outputDelta', text);
    } else if (type === 'commandExecution') {
      const output = item.aggregatedOutput as string || '';
      if (output) this.appendLog(output + '\n');
      const exitCode = item.exitCode as number | null;
      if (exitCode !== null && exitCode !== 0) {
        this.appendLog(`Exit code: ${exitCode}\n`);
      }
    }
  };

  private onAgentMessageDelta = (threadId: string, turnId: string, _itemId: string, delta: string): void => {
    if (!this.ownsTurn(threadId, turnId)) return;
    this.appendLog(delta);
    this.emit('outputDelta', delta);
  };

  private onReasoningSummaryDelta = (
    threadId: string,
    turnId: string,
    itemId: string,
    _summaryIndex: number,
    delta: string,
  ): void => {
    if (!this.ownsTurn(threadId, turnId)) return;
    if (!this.reasoningItems.has(itemId)) {
      this.reasoningItems.add(itemId);
      this.appendLog(`\n\x1b[35m\x1b[3mthinking\x1b[0m\x1b[0m\n`);
    }
    this.appendLog(delta);
  };

  private onTokenUsageUpdated = (
    threadId: string,
    turnId: string,
    usage: AppServerThreadTokenUsage,
  ): void => {
    if (!this.ownsTurn(threadId, turnId)) return;
    this.usage = {
      inputTokens: usage.total.inputTokens,
      cachedInputTokens: usage.total.cachedInputTokens,
      outputTokens: usage.total.outputTokens,
      reasoningOutputTokens: usage.total.reasoningOutputTokens,
    };
    this.metadata.usage = { ...this.usage };
    this.writeMetadata();
  };

  private onCommandExecDelta = (threadId: string, turnId: string, _itemId: string, delta: string): void => {
    if (!this.ownsTurn(threadId, turnId)) return;
    this.appendLog(delta);
  };

  private onProcessDelta = (threadId: string, _processId: string, stream: string, deltaBase64: string): void => {
    if (!this.ownsThread(threadId)) return;
    try {
      const decoded = Buffer.from(deltaBase64, 'base64').toString('utf8');
      this.appendLog(decoded);
    } catch { /* ignore decode errors */ }
  };

  private onProcessExited = (threadId: string, _processId: string, exitCode: number): void => {
    if (!this.ownsThread(threadId)) return;
    this.appendLog(`\ntokens used\n${this.usage.outputTokens || 0}\n`);
  };

  private onError = (threadId: string | null, message: string): void => {
    if (threadId !== null && !this.ownsThread(threadId)) return;
    this.metadata.errorSummary = { stage: threadId ? 'turn' : 'before_thread', message: message.slice(0, 500) };
    this.metadata.status = 'failed';
    this.writeMetadata();
    this.appendLog(`[ERROR] ${message}\n`);
  };

  // ─── Completion ─────────────────────────────────────────────────────────

  complete(exitCode: number): void {
    if (this.finalized) return;
    this.finalized = true;
    this.metadata.status = exitCode === 0 ? 'completed' : 'failed';
    this.metadata.exitCode = exitCode;
    this.metadata.finishedAt = new Date().toISOString();
    this.metadata.usage = { ...this.usage };
    if (this.metadata.status === 'failed' && !this.metadata.errorSummary) {
      this.metadata.errorSummary = { stage: 'process', message: `Exit code ${exitCode}` };
    }
    this.writeMetadata();
    this.appendLog(`\n[${new Date().toISOString()}] Session bridge completed (exit=${exitCode})\n`);
    this.emit(exitCode === 0 ? 'completed' : 'failed', exitCode);
    this.stop();
  }

  fail(error: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.metadata.status = 'failed';
    this.metadata.exitCode = 1;
    this.metadata.finishedAt = new Date().toISOString();
    this.metadata.usage = { ...this.usage };
    this.metadata.errorSummary = { stage: 'process', message: error.slice(0, 500) };
    this.writeMetadata();
    this.appendLog(`\n[ERROR] ${error}\n`);
    this.emit('failed', 1);
    this.stop();
  }

  cancel(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.metadata.status = 'cancelled';
    this.metadata.exitCode = null;
    this.metadata.finishedAt = new Date().toISOString();
    this.metadata.usage = { ...this.usage };
    this.metadata.errorSummary = null;
    this.writeMetadata();
    this.appendLog(`\n[${new Date().toISOString()}] Session bridge cancelled\n`);
    this.stop();
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private ownsThread(threadId: string): boolean {
    return this.boundThreadId !== null && threadId === this.boundThreadId;
  }

  private ownsTurn(threadId: string, turnId: string): boolean {
    return this.ownsThread(threadId)
      && this.boundTurnId !== null
      && turnId === this.boundTurnId;
  }

  private writeMetadata(): void {
    const tmp = `${this.metadataPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.metadata, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.metadataPath);
  }

  appendLog(text: string): void {
    this.logStream?.write(text);
    this.emit('log', text);
  }
}

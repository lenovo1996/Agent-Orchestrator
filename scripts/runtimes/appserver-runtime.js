#!/usr/bin/env node
'use strict';

/**
 * appserver-runtime.js — App-server runtime for dev-team agents.
 *
 * Connects to the codex app-server daemon via WebSocket, creates a thread,
 * sends the prompt as a turn, and streams events back.
 *
 * Usage: node appserver-runtime.js <prompt-file> <log-file> <work-dir> <cwd> <flow-id> <step>
 *
 * Environment variables:
 *   CODEX_APP_SERVER_URL  - WebSocket URL (default: ws://127.0.0.1:9876)
 *   AGENT_MODEL           - Model override
 *   AGENT_REASONING       - Reasoning effort
 *   DEVTEAM_SESSION_RUN_ID
 *   DEVTEAM_ATTEMPT_ID
 *   DEVTEAM_INNGEST_RUN_ID
 *   DEVTEAM_INNGEST_ATTEMPT
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// ─── Args ────────────────────────────────────────────────────────────────────

const [promptFile, logFile, workDir, cwd, flowId, step] = process.argv.slice(2);
if (!promptFile || !logFile || !workDir || !cwd || !flowId || !step) {
  console.error('Usage: appserver-runtime.js <prompt-file> <log-file> <work-dir> <cwd> <flow-id> <step>');
  process.exit(1);
}

const prompt = fs.readFileSync(promptFile, 'utf8');

// ─── App-server URL ──────────────────────────────────────────────────────────

function resolveAppServerUrl() {
  const envUrl = process.env.CODEX_APP_SERVER_URL;
  if (envUrl) return envUrl;
  return `ws://127.0.0.1:${process.env.CODEX_APP_SERVER_PORT || '9876'}`;
}

// ─── Minimal JSON-RPC over WebSocket ─────────────────────────────────────────

const SC_URL = resolveAppServerUrl();

let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  // Fallback: try native WebSocket (Node 22+)
  WebSocket = globalThis.WebSocket;
}

if (!WebSocket) {
  console.error('No WebSocket implementation available. Install ws: npm i ws');
  process.exit(1);
}

function onSocket(socket, event, handler) {
  if (typeof socket.on === 'function') {
    socket.on(event, handler);
    return;
  }
  socket.addEventListener(event, (value) => {
    if (event === 'message') handler(value.data);
    else if (event === 'error') handler(value.error || new Error('WebSocket error'));
    else handler(value);
  });
}

class JsonRpcClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const isUnix = this.url.startsWith('ws+unix://');
      let ws;
      if (isUnix) {
        // ws library supports unix sockets via ws+unix:///path
        ws = new WebSocket(this.url);
      } else {
        ws = new WebSocket(this.url);
      }
      this.ws = ws;

      onSocket(ws, 'open', () => resolve());
      onSocket(ws, 'error', (err) => reject(err));
      onSocket(ws, 'message', (data) => {
        let msg;
        try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString()); } catch { return; }
        this._handle(msg);
      });
      onSocket(ws, 'close', () => {
        for (const [, { reject: r }] of this.pending) r(new Error('closed'));
        this.pending.clear();
        this.emit('close');
      });
    });
  }

  async request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, 300_000);
    });
  }

  respond(id, result) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    }
  }

  notify(method, params = {}) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    }
  }

  close() {
    this.ws?.close();
  }

  _handle(msg) {
    if ('id' in msg && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if ('method' in msg && !('id' in msg)) {
      this.emit('notification', msg.method, msg.params || {});
      return;
    }
    if ('method' in msg && 'id' in msg) {
      this.emit('request', msg.id, msg.method, msg.params || {});
    }
  }
}

// ─── Session metadata ────────────────────────────────────────────────────────

const SCHEMA_VERSION = 2;
const sessionRunId = process.env.DEVTEAM_SESSION_RUN_ID || crypto.randomUUID();
const attemptId = process.env.DEVTEAM_ATTEMPT_ID || `manual-${flowId}-${step}`;
const inngestRunId = process.env.DEVTEAM_INNGEST_RUN_ID || `manual-${flowId}`;
const inngestAttempt = Number(process.env.DEVTEAM_INNGEST_ATTEMPT || '0');

const sessionDir = path.join(workDir, 'sessions', step);
fs.mkdirSync(sessionDir, { recursive: true });
const metadataPath = path.join(sessionDir, `${sessionRunId}.json`);

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

const metadata = {
  schemaVersion: SCHEMA_VERSION,
  runId: sessionRunId,
  attemptId,
  inngestRunId,
  inngestAttempt,
  flowId,
  step,
  threadId: null,
  turnId: null,
  status: 'starting',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  exitCode: null,
  usage: null,
  errorSummary: null,
};

atomicWrite(metadataPath, metadata);

// ─── Log file ────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(logFile), { recursive: true });
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function appendLog(text) {
  logStream.write(text);
}

appendLog(`Runtime: appserver\n`);
appendLog(`URL: ${SC_URL}\n`);
appendLog(`Model: ${process.env.AGENT_MODEL || 'default'}\n`);
appendLog(`Session: ${sessionRunId}\n`);

// ─── Main ────────────────────────────────────────────────────────────────────

let exitCode = 1;
let currentThreadId = null;
let currentTurnId = null;
let completedTurnStatus = null;
let interrupted = false;
let tokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};
let activeClient = null;
let stopWaiting = null;

async function interruptActiveTurn() {
  interrupted = true;
  exitCode = 143;
  if (activeClient && currentThreadId && currentTurnId) {
    await activeClient.request('turn/interrupt', {
      threadId: currentThreadId,
      turnId: currentTurnId,
    }).catch(() => undefined);
  }
  stopWaiting?.();
}

process.once('SIGTERM', () => { void interruptActiveTurn(); });
process.once('SIGINT', () => { void interruptActiveTurn(); });

async function main() {
  const client = new JsonRpcClient(SC_URL);

  // Handle approval requests (auto-approve)
  client.on('request', (id, method, params) => {
    if (method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval' ||
        method === 'item/permissions/requestApproval') {
      if (method === 'item/permissions/requestApproval') {
        const requested = params.permissions || {};
        const permissions = {};
        if (requested.network) permissions.network = requested.network;
        if (requested.fileSystem) permissions.fileSystem = requested.fileSystem;
        client.respond(id, { permissions, scope: 'session' });
      } else {
        client.respond(id, { decision: 'acceptForSession' });
      }
    } else {
      client.respond(id, { error: 'Not supported' });
    }
  });

  // Handle notifications
  client.on('notification', (method, params) => {
    switch (method) {
      case 'thread/started': {
        currentThreadId = params.thread?.id;
        metadata.threadId = currentThreadId;
        metadata.status = 'running';
        atomicWrite(metadataPath, metadata);
        appendLog(`\x1b[35m\x1b[3mthread\x1b[0m\x1b[0m\nThread: ${currentThreadId}\n`);
        break;
      }
      case 'turn/started': {
        currentTurnId = params.turn?.id;
        metadata.turnId = currentTurnId;
        atomicWrite(metadataPath, metadata);
        appendLog(`\n--- Turn ${currentTurnId} started ---\n`);
        break;
      }
      case 'turn/completed': {
        if (!currentTurnId && params.turn?.id) currentTurnId = params.turn.id;
        if (params.turn?.id === currentTurnId) {
          completedTurnStatus = params.turn.status || 'failed';
          exitCode = completedTurnStatus === 'completed' ? 0 : 1;
          stopWaiting?.();
        }
        appendLog(`\n--- Turn completed ---\n`);
        break;
      }
      case 'item/started': {
        if (params.item?.type === 'commandExecution') {
          appendLog(`\x1b[35m\x1b[3mexec\x1b[0m\x1b[0m\n$ ${params.item.command || ''}\n`);
        }
        break;
      }
      case 'item/completed': {
        if (params.item?.type === 'agentMessage') {
          appendLog(`\x1b[35m\x1b[3mcodex\x1b[0m\x1b[0m\n${params.item.text || ''}\n`);
        } else if (params.item?.type === 'commandExecution') {
          if (params.item.aggregatedOutput) appendLog(params.item.aggregatedOutput + '\n');
        }
        break;
      }
      case 'item/agentMessage/delta':
      case 'agentMessage/delta': {
        appendLog(params.delta || '');
        break;
      }
      case 'item/reasoning/summaryTextDelta': {
        appendLog(params.delta || '');
        break;
      }
      case 'thread/tokenUsage/updated': {
        if (params.threadId !== currentThreadId || params.turnId !== currentTurnId) break;
        const total = params.tokenUsage?.total;
        if (total) {
          tokenUsage = {
            inputTokens: Number(total.inputTokens || 0),
            cachedInputTokens: Number(total.cachedInputTokens || 0),
            outputTokens: Number(total.outputTokens || 0),
            reasoningOutputTokens: Number(total.reasoningOutputTokens || 0),
          };
          metadata.usage = { ...tokenUsage };
          atomicWrite(metadataPath, metadata);
        }
        break;
      }
      case 'item/commandExecution/outputDelta':
      case 'commandExecution/outputDelta':
      case 'commandExec/outputDelta': {
        appendLog(params.delta || '');
        break;
      }
      case 'error': {
        const msg = params.error?.message || 'Unknown error';
        metadata.errorSummary = { stage: currentThreadId ? 'turn' : 'before_thread', message: msg.slice(0, 500) };
        metadata.status = 'failed';
        atomicWrite(metadataPath, metadata);
        appendLog(`[ERROR] ${msg}\n`);
        if (params.turnId === currentTurnId) {
          exitCode = 1;
          stopWaiting?.();
        }
        break;
      }
    }
  });

  client.on('close', () => {
    appendLog(`[WARN] WebSocket closed\n`);
  });

  // Connect
  await client.connect();
  activeClient = client;

  // Initialize
  await client.request('initialize', {
    clientInfo: { name: 'devteam-runtime', title: 'DevTeam Runtime', version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  client.notify('initialized');

  // Create thread
  const runtimeWorkspaceRoots = [...new Set([path.resolve(cwd), path.resolve(workDir)])];
  const threadResult = await client.request('thread/start', {
    cwd,
    runtimeWorkspaceRoots,
    model: process.env.AGENT_MODEL || undefined,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    personality: 'pragmatic',
    ephemeral: false,
  });

  currentThreadId = threadResult.thread.id;
  metadata.threadId = currentThreadId;
  metadata.status = 'running';
  atomicWrite(metadataPath, metadata);

  // Start turn
  const turnResult = await client.request('turn/start', {
    threadId: currentThreadId,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
    cwd,
    runtimeWorkspaceRoots,
    sandboxPolicy: { type: 'dangerFullAccess' },
    model: process.env.AGENT_MODEL || undefined,
    effort: process.env.AGENT_REASONING || undefined,
    summary: process.env.AGENT_REASONING === 'none' ? 'none' : 'detailed',
  });

  currentTurnId = turnResult.turn.id;
  metadata.turnId = currentTurnId;
  atomicWrite(metadataPath, metadata);

  // Wait for turn completion
  await new Promise((resolve) => {
    let timer;
    stopWaiting = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    if (completedTurnStatus) {
      stopWaiting();
      return;
    }
    timer = setTimeout(() => {
      appendLog('[ERROR] Turn timed out after 6 hours\n');
      exitCode = 1;
      void client.request('turn/interrupt', {
        threadId: currentThreadId,
        turnId: currentTurnId,
      }).catch(() => undefined).finally(() => stopWaiting?.());
    }, 6 * 60 * 60 * 1000);
    timer.unref();
  });

  stopWaiting = null;
  await client.request('thread/unsubscribe', { threadId: currentThreadId }).catch(() => undefined);
  activeClient = null;
  client.close();
}

main().then(() => {
  // Write final token count
  appendLog(`tokens used\n${tokenUsage.outputTokens}\n`);

  metadata.status = interrupted ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed';
  metadata.exitCode = exitCode;
  metadata.finishedAt = new Date().toISOString();
  metadata.usage = { ...tokenUsage };
  if (metadata.status === 'failed' && !metadata.errorSummary) {
    metadata.errorSummary = { stage: 'process', message: `Exit code ${exitCode}` };
  }
  atomicWrite(metadataPath, metadata);

  logStream.end(() => {
    process.exit(exitCode);
  });
}).catch((err) => {
  appendLog(`[ERROR] ${err.message}\n`);

  metadata.status = 'failed';
  metadata.exitCode = 1;
  metadata.finishedAt = new Date().toISOString();
  metadata.errorSummary = { stage: 'before_thread', message: err.message.slice(0, 500) };
  atomicWrite(metadataPath, metadata);

  logStream.end(() => {
    process.exit(1);
  });
});

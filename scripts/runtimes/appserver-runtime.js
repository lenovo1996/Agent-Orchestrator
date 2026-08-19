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
 *   CODEX_APP_SERVER_URL  - WebSocket URL (default: ws://unix:~/.codex/app-server-control/app-server-control.sock)
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

  const sockPath = path.join(
    process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex'),
    'app-server-control', 'app-server-control.sock',
  );
  return `ws+unix://${sockPath}`;
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

      ws.on('open', () => resolve());
      ws.on('error', (err) => reject(err));
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        this._handle(msg);
      });
      ws.on('close', () => {
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

async function main() {
  const client = new JsonRpcClient(SC_URL);

  // Handle approval requests (auto-approve)
  client.on('request', (id, method, _params) => {
    if (method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval' ||
        method === 'item/permissions/requestApproval') {
      if (method === 'item/permissions/requestApproval') {
        client.respond(id, { permissions: { level: 'dangerFullAccess' }, scope: 'session' });
      } else {
        client.respond(id, 'acceptForSession');
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
        appendLog(`\n--- Turn ${currentTurnId} started ---\n`);
        break;
      }
      case 'turn/completed': {
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
      case 'agentMessage/delta': {
        appendLog(params.delta || '');
        break;
      }
      case 'commandExecution/outputDelta':
      case 'commandExec/outputDelta': {
        appendLog(params.delta || '');
        break;
      }
      case 'process/outputDelta': {
        try {
          appendLog(Buffer.from(params.deltaBase64 || '', 'base64').toString('utf8'));
        } catch { /* ignore */ }
        break;
      }
      case 'process/exited': {
        break;
      }
      case 'error': {
        const msg = params.error?.message || 'Unknown error';
        metadata.errorSummary = { stage: currentThreadId ? 'turn' : 'before_thread', message: msg.slice(0, 500) };
        metadata.status = 'failed';
        atomicWrite(metadataPath, metadata);
        appendLog(`[ERROR] ${msg}\n`);
        break;
      }
    }
  });

  client.on('close', () => {
    appendLog(`[WARN] WebSocket closed\n`);
  });

  // Connect
  await client.connect();

  // Initialize
  await client.request('initialize', {
    clientInfo: { name: 'devteam-runtime', title: 'DevTeam Runtime', version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });

  // Create thread
  const threadResult = await client.request('thread/start', {
    cwd,
    model: process.env.AGENT_MODEL || undefined,
    approvalPolicy: 'never',
    sandbox: { type: 'dangerFullAccess' },
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
    model: process.env.AGENT_MODEL || undefined,
  });

  currentTurnId = turnResult.turn.id;

  // Wait for turn completion
  await new Promise((resolve) => {
    const onNotif = (method, params) => {
      if (method === 'turn/completed' && params.turn?.id === currentTurnId) {
        client.removeListener('notification', onNotif);
        exitCode = 0;
        resolve();
      }
      if (method === 'error' && params.turnId === currentTurnId) {
        client.removeListener('notification', onNotif);
        exitCode = 1;
        resolve();
      }
    };
    client.on('notification', onNotif);

    // Timeout
    setTimeout(() => {
      client.removeListener('notification', onNotif);
      appendLog('[ERROR] Turn timed out after 6 hours\n');
      exitCode = 1;
      resolve();
    }, 6 * 60 * 60 * 1000);
  });

  client.close();
}

main().then(() => {
  // Write final token count
  appendLog(`tokens used\n0\n`);

  metadata.status = exitCode === 0 ? 'completed' : 'failed';
  metadata.exitCode = exitCode;
  metadata.finishedAt = new Date().toISOString();
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

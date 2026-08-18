#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const SCHEMA_VERSION = 2;
const MAX_ERROR_LENGTH = 500;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key?.startsWith('--') || rest[i + 1] === undefined) {
      throw new Error(`Invalid argument: ${key || '<missing>'}`);
    }
    values[key.slice(2)] = rest[i + 1];
  }
  return { command, values };
}

function requireValue(values, key) {
  const value = values[key];
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function validateSegment(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function metadataPath(values) {
  const workDir = path.resolve(requireValue(values, 'work-dir'));
  const step = validateSegment(requireValue(values, 'step'), 'step');
  const runId = validateSegment(requireValue(values, 'run-id'), 'run ID');
  return path.join(workDir, 'sessions', step, `${runId}.json`);
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function summarizeError(value) {
  const text = stripAnsi(
    typeof value === 'string'
      ? value
      : value?.message || value?.error?.message || value?.error || JSON.stringify(value || '')
  ).trim();
  return text.slice(-MAX_ERROR_LENGTH);
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readMetadata(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function extractUsage(event) {
  const usage = event?.usage || event?.info?.total_token_usage || event?.payload?.usage;
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
    cachedInputTokens: Number(usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
    reasoningOutputTokens: Number(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens ?? 0),
  };
}

function applyStreamEvent(metadata, event) {
  const type = event?.type;
  let changed = false;

  if (type === 'thread.started' && typeof event.thread_id === 'string') {
    metadata.threadId = event.thread_id;
    metadata.status = 'running';
    changed = true;
  }

  const usage = extractUsage(event);
  if (usage) {
    metadata.usage = usage;
    changed = true;
  }

  if (type === 'turn.failed' || type === 'error') {
    const message = summarizeError(event);
    if (message) {
      metadata.errorSummary = {
        stage: metadata.threadId ? 'turn' : 'before_thread',
        message,
      };
      changed = true;
    }
  }

  return changed;
}

function init(values) {
  const workDir = path.resolve(requireValue(values, 'work-dir'));
  const flowId = requireValue(values, 'flow-id');
  const step = validateSegment(requireValue(values, 'step'), 'step');
  const runId = validateSegment(values['run-id'] || crypto.randomUUID(), 'run ID');
  const attemptId = validateSegment(values['attempt-id'] || runId, 'attempt ID');
  const inngestRunId = validateSegment(values['inngest-run-id'] || runId, 'Inngest run ID');
  const inngestAttempt = Number.parseInt(values['inngest-attempt'] || '0', 10);
  const filePath = path.join(workDir, 'sessions', step, `${runId}.json`);
  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    attemptId,
    inngestRunId,
    inngestAttempt: Number.isFinite(inngestAttempt) ? inngestAttempt : 0,
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
  atomicWrite(filePath, metadata);
  process.stdout.write(runId);
}

async function stream(values) {
  const filePath = metadataPath(values);
  const metadata = readMetadata(filePath);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of input) {
    process.stdout.write(`${line}\n`);
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (applyStreamEvent(metadata, event)) atomicWrite(filePath, metadata);
    } catch {
      // Compatibility output can contain non-JSON lines; it remains in the log.
    }
  }
}

function finalize(values) {
  const filePath = metadataPath(values);
  const metadata = readMetadata(filePath);
  const exitCode = Number.parseInt(requireValue(values, 'exit-code'), 10);
  const stderrFile = values['stderr-file'];

  metadata.exitCode = Number.isFinite(exitCode) ? exitCode : 1;
  metadata.finishedAt = new Date().toISOString();
  metadata.status = metadata.exitCode === 0 && metadata.threadId ? 'completed' : 'failed';

  if (metadata.status === 'failed' && !metadata.errorSummary) {
    let message = '';
    if (stderrFile) {
      try {
        const lines = fs.readFileSync(stderrFile, 'utf8').split(/\r?\n/).filter(Boolean);
        message = summarizeError(lines.at(-1));
      } catch {
        // The process can fail before writing stderr.
      }
    }
    metadata.errorSummary = {
      stage: metadata.threadId ? 'process' : 'before_thread',
      message: message || `Codex exited with code ${metadata.exitCode}`,
    };
  }

  atomicWrite(filePath, metadata);
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === 'init') return init(values);
  if (command === 'stream') return stream(values);
  if (command === 'finalize') return finalize(values);
  throw new Error('Usage: session-capture.js <init|stream|finalize> [options]');
}

if (require.main === module) {
  Promise.resolve(main()).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  applyStreamEvent,
  atomicWrite,
  extractUsage,
  stripAnsi,
  summarizeError,
};

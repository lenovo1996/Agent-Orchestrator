import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { DashboardConfig } from '../config.js';
import { SessionService } from '../session/service.js';
import { sessionsRouter } from './sessions.js';

const threadA = '019fffff-1111-7222-8333-444444444444';
const threadB = '019fffff-1111-7222-8333-555555555555';
const runA = 'aaaaaaaa-1111-4222-8333-444444444444';
const runB = 'bbbbbbbb-1111-4222-8333-444444444444';

function attempt(runId: string, threadId: string | null, startedAt: string, status = 'completed') {
  return {
    schemaVersion: 1,
    runId,
    flowId: 'flow_001',
    step: 'implementer',
    threadId,
    status,
    startedAt,
    finishedAt: status === 'completed' ? '2026-08-17T00:01:00.000Z' : null,
    exitCode: status === 'completed' ? 0 : null,
    usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 25, reasoningOutputTokens: 10 },
    errorSummary: null,
  };
}

async function request(app: express.Express, url: string) {
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get('cache-control') };
  } finally {
    server.close();
  }
}

describe('session routes', () => {
  let root: string;
  let taskFlowsDir: string;
  let codexHome: string;
  let config: DashboardConfig;
  let app: express.Express;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-routes-'));
    taskFlowsDir = path.join(root, 'task-flows');
    codexHome = path.join(root, '.codex');
    fs.mkdirSync(taskFlowsDir, { recursive: true });
    fs.mkdirSync(path.join(codexHome, 'sessions', '2026', '08', '17'), { recursive: true });
    fs.mkdirSync(path.join(codexHome, 'archived_sessions'), { recursive: true });
    config = {
      port: 0,
      host: '127.0.0.1',
      corsOrigin: '*',
      repoRoot: root,
      taskFlowsDir,
      scriptDir: path.join(root, 'scripts'),
      clientDistPath: path.join(root, 'dist'),
      isProduction: false,
      codexHome,
      sessionViewerEnabled: true,
    };
    const service = new SessionService(config);
    app = express();
    app.use('/api', sessionsRouter(config, service));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function writeAttempt(workspace: string, value: ReturnType<typeof attempt>) {
    const directory = path.join(taskFlowsDir, workspace, 'flow_001', 'sessions', 'implementer');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${value.runId}.json`), JSON.stringify(value));
  }

  function writeRollout(threadId: string, records: object[], compressed = false) {
    const suffix = compressed ? '.jsonl.zst' : '.jsonl';
    const file = path.join(codexHome, 'sessions', '2026', '08', '17', `rollout-${threadId}${suffix}`);
    const content = Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(content) : content);
  }

  it('returns attempts in ascending order and isolates workspaces with the same flow ID', async () => {
    writeAttempt('workspace-a', attempt(runB, threadB, '2026-08-17T00:02:00.000Z'));
    writeAttempt('workspace-a', attempt(runA, threadA, '2026-08-17T00:00:00.000Z'));
    writeAttempt('workspace-b', { ...attempt('cccccccc-1111-4222-8333-444444444444', threadB, '2026-08-17T00:03:00.000Z'), flowId: 'flow_001' });

    const first = await request(app, '/api/flows/flow_001/sessions/implementer?workspaceName=workspace-a');
    const second = await request(app, '/api/flows/flow_001/sessions/implementer?workspaceName=workspace-b');
    expect(first.status).toBe(200);
    expect(first.cacheControl).toBe('no-store');
    expect(first.body.attempts.map((entry: any) => entry.runId)).toEqual([runA, runB]);
    expect(second.body.attempts).toHaveLength(1);
    expect(second.body.attempts[0].runId).toMatch(/^c/);
  });

  it('returns sanitized summaries and lazy detail only for an item in the selected attempt', async () => {
    writeAttempt('workspace-a', attempt(runA, threadA, '2026-08-17T00:00:00.000Z'));
    writeAttempt('workspace-a', attempt(runB, threadB, '2026-08-17T00:00:00.000Z'));
    writeRollout(threadA, [
      { timestamp: '2026-08-17T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { timestamp: '2026-08-17T00:00:00.000Z', cli_version: '0.147.0', cwd: '/private/home', base_instructions: 'secret' } },
      { timestamp: '2026-08-17T00:00:01.000Z', ordinal: 1, type: 'turn_context', payload: { model: 'gpt-5.5', cwd: '/private/home', turn_id: 'turn-a' } },
      { timestamp: '2026-08-17T00:00:02.000Z', ordinal: 2, type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-a', item: { type: 'CommandExecution', id: 'cmd-a', command: ['sh', '-lc', 'printf ok'], status: 'completed', aggregated_output: `full command output at ${codexHome}/sessions`, exit_code: 0 } } },
    ]);
    writeRollout(threadB, [
      { timestamp: '2026-08-17T00:00:02.000Z', ordinal: 2, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'cmd-b', command: ['sh'], status: 'completed', aggregated_output: 'other attempt' } } },
    ]);

    const snapshot = await request(app, `/api/flows/flow_001/sessions/implementer/${runA}?workspaceName=workspace-a`);
    expect(snapshot.status).toBe(200);
    expect(JSON.stringify(snapshot.body)).not.toContain('/private/home');
    expect(JSON.stringify(snapshot.body)).not.toContain('base_instructions');
    expect(JSON.stringify(snapshot.body)).not.toContain(codexHome);
    expect(snapshot.body.items[0].output).toBeUndefined();
    expect(snapshot.body.items[0].outputPreview).toBe('full command output at $CODEX_HOME/sessions');

    const itemId = snapshot.body.items[0].id;
    const detail = await request(app, `/api/flows/flow_001/sessions/implementer/${runA}/items/${encodeURIComponent(itemId)}?workspaceName=workspace-a`);
    expect(detail.body.output).toBe('full command output at $CODEX_HOME/sessions');

    const outside = await request(app, `/api/flows/flow_001/sessions/implementer/${runA}/items/command-cmd-b?workspaceName=workspace-a`);
    expect(outside.status).toBe(404);
  });

  it('returns an empty registry for historical flows and parses completed zstd rollouts', async () => {
    const historical = await request(app, '/api/flows/old_flow/sessions/clarifier');
    expect(historical.body.attempts).toEqual([]);

    writeAttempt('workspace-a', attempt(runA, threadA, '2026-08-17T00:00:00.000Z'));
    writeRollout(threadA, [
      { timestamp: '2026-08-17T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { timestamp: '2026-08-17T00:00:00.000Z' } },
      { timestamp: '2026-08-17T00:00:01.000Z', ordinal: 1, type: 'response_item', payload: { type: 'message', id: 'final', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'from zstd' }] } },
    ], true);
    const snapshot = await request(app, `/api/flows/flow_001/sessions/implementer/${runA}?workspaceName=workspace-a`);
    expect(snapshot.body.rolloutAvailable).toBe(true);
    expect(snapshot.body.items[0].text).toBe('from zstd');
  });
});

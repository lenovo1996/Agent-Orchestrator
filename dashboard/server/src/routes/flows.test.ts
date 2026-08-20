import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationRuntime } from '@devteam-dashboard/orchestration';
import type { DashboardConfig } from '../config.js';
import { createTestOrchestration } from '../test-helpers.js';
import { flowsRouter } from './flows.js';

const httpFetch = globalThis.fetch;

async function request(
  app: express.Express,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await httpFetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body: await response.json(),
    };
  } finally {
    server.close();
  }
}

describe('SQLite-backed flow REST API', () => {
  let root: string;
  let taskFlowsDir: string;
  let orchestration: ReturnType<typeof createTestOrchestration>;
  let runtime: OrchestrationRuntime;
  let app: express.Express;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-routes-'));
    taskFlowsDir = path.join(root, 'task-flows');
    orchestration = createTestOrchestration(root, taskFlowsDir, []);
    runtime = {
      config: orchestration.config,
      service: orchestration.service,
      stopFlow: async (flowId: string, idempotencyKey?: string) => {
        const command = orchestration.service.requestStop(flowId, idempotencyKey);
        orchestration.service.finishStop(flowId, command.commandId);
        return command;
      },
    } as unknown as OrchestrationRuntime;
    const config: DashboardConfig = {
      port: 0,
      host: '127.0.0.1',
      corsOrigin: '*',
      repoRoot: root,
      taskFlowsDir,
      scriptDir: path.join(root, 'scripts'),
      clientDistPath: path.join(root, 'dist'),
      isProduction: false,
      codexHome: path.join(root, '.codex'),
      sessionViewerEnabled: true,
    };
    app = express();
    app.use(express.json());
    app.use('/api', flowsRouter(config, runtime));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    orchestration.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function start(idempotencyKey = 'api-start') {
    return request(app, 'POST', '/api/flows', {
      workflowId: 'workflow-1',
      workspaceId: 'workspace-1',
      prompt: 'Implement through durable orchestration',
    }, { 'Idempotency-Key': idempotencyKey });
  }

  it('creates the durable command exactly once and serves DB state', async () => {
    orchestration.database.run(
      'INSERT INTO workspaces(id, name, path) VALUES (?, ?, ?)',
      'workspace-1', 'Workspace 1', path.join(root, 'workspace-1'),
    );
    const first = await start();
    const duplicate = await start();
    expect(first.status).toBe(202);
    expect(first.cacheControl).toBe('no-store');
    expect(duplicate.body).toEqual(first.body);
    expect(orchestration.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM flows')?.count).toBe(1);

    const detail = await request(app, 'GET', `/api/flows/${first.body.flowId}?workspaceId=workspace-1`);
    expect(detail.status).toBe(200);
    expect(detail.body.workflow).toMatchObject({ status: 'queued', revision: 0 });
    expect(detail.body.attempts).toEqual([]);
  });

  it('enforces retry, resume, stop, and delete state validation', async () => {
    orchestration.database.run(
      'INSERT INTO workspaces(id, name, path) VALUES (?, ?, ?)',
      'workspace-1', 'Workspace 1', path.join(root, 'workspace-1'),
    );
    const created = await start('state-start');
    const flowId = created.body.flowId;
    expect((await request(app, 'POST', `/api/flows/${flowId}/actions/retry`, { step: 'implementer' })).status).toBe(409);
    expect((await request(app, 'POST', `/api/flows/${flowId}/actions/resume`)).status).toBe(409);
    expect((await request(app, 'DELETE', `/api/flows/${flowId}`)).status).toBe(409);

    const stopped = await request(app, 'POST', `/api/flows/${flowId}/actions/stop`, undefined, {
      'Idempotency-Key': 'stop-command',
    });
    expect(stopped.status).toBe(202);
    expect(orchestration.service.getFlow(flowId).status).toBe('stopped');
    expect((await request(app, 'DELETE', `/api/flows/${flowId}`, undefined, {
      'Idempotency-Key': 'delete-command',
    })).status).toBe(202);
    expect((await request(app, 'GET', `/api/flows/${flowId}`)).status).toBe(404);
  });

  it('isolates detail reads by workspace ID', async () => {
    orchestration.database.run(
      'INSERT INTO workspaces(id, name, path) VALUES (?, ?, ?)',
      'workspace-1', 'Workspace 1', path.join(root, 'workspace-1'),
    );
    const flowId = (await start('isolation-start')).body.flowId;
    expect((await request(app, 'GET', `/api/flows/${flowId}?workspaceId=another-workspace`)).status).toBe(404);
  });

  it('returns 200 when Inngest and the worker health endpoint are ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input) === orchestration.config.inngestBaseUrl) {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({
        ready: true,
        runnerId: 'worker-1',
        status: 'connected',
        capacity: 4,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const response = await request(app, 'GET', '/api/orchestration/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ready: true,
      inngest: { ready: true, url: orchestration.config.inngestBaseUrl },
      worker: {
        ready: true,
        runnerId: 'worker-1',
        connectionStatus: 'connected',
        capacity: 4,
      },
    });
  });

  it('returns 503 when Inngest and the worker health endpoint are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input) === orchestration.config.inngestBaseUrl) {
        return new Response(null, { status: 503 });
      }
      return new Response(JSON.stringify({
        ready: false,
        runnerId: 'worker-1',
        status: 'connecting',
        capacity: 3,
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }));

    const response = await request(app, 'GET', '/api/orchestration/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ready: false,
      inngest: { ready: false, error: 'HTTP 503' },
      worker: {
        ready: false,
        runnerId: 'worker-1',
        connectionStatus: 'connecting',
        capacity: 3,
        error: 'HTTP 503',
      },
    });
  });
});

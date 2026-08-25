import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestOrchestration } from '../test-helpers.js';
import { agentsRouter } from './agents.js';

vi.mock('../services/agent-service.js', () => ({ syncAgentsToFileSystem: vi.fn() }));

const httpFetch = globalThis.fetch;

async function request(app: express.Express, method: string, pathname: string, body?: unknown) {
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await httpFetch(`http://127.0.0.1:${port}/api${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

describe('agent runtime permissions', () => {
  let root: string;
  let orchestration: ReturnType<typeof createTestOrchestration>;
  let app: express.Express;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-routes-'));
    orchestration = createTestOrchestration(root, path.join(root, 'task-flows'), []);
    app = express();
    app.use(express.json());
    app.use('/api', agentsRouter(orchestration.database));
  });

  afterEach(() => {
    orchestration.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates and updates agents without a tool allowlist', async () => {
    const create = await request(app, 'POST', '/agents', {
      id: 'reviewer',
      role: 'Reviewer',
      objective: 'Review changes',
      outputs: ['output/review.md'],
      runtime: 'appserver',
      instructions: 'Review safely.',
    });
    expect(create.status).toBe(201);
    expect(orchestration.database.get<{ tools: string }>(
      'SELECT tools FROM agents WHERE id = ?', 'reviewer',
    )?.tools).toBe('[]');

    const update = await request(app, 'PUT', '/agents/reviewer', {
      role: 'Reviewer',
      objective: 'Review changes independently',
      tools: ['read', 'exec'],
      outputs: ['output/review.md'],
      runtime: 'appserver',
      instructions: 'Review safely.',
    });
    expect(update.status).toBe(200);
    expect(orchestration.database.get<{ tools: string }>(
      'SELECT tools FROM agents WHERE id = ?', 'reviewer',
    )?.tools).toBe('[]');

    const list = await request(app, 'GET', '/agents');
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string; tools: string[] }>).find((agent) => agent.id === 'reviewer'))
      .toMatchObject({ tools: [] });
  });
});

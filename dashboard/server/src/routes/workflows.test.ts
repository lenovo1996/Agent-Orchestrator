import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestOrchestration } from '../test-helpers.js';
import { workflowsRouter } from './workflows.js';

const httpFetch = globalThis.fetch;

async function request(app: express.Express, body: unknown) {
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await httpFetch(`http://127.0.0.1:${port}/api/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

describe('workflow policies', () => {
  let root: string;
  let orchestration: ReturnType<typeof createTestOrchestration>;
  let app: express.Express;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-routes-'));
    orchestration = createTestOrchestration(root, path.join(root, 'task-flows'), []);
    orchestration.database.run(`
      INSERT INTO agents(id, role, objective, tools, outputs, runtime, instructions)
      VALUES ('verifier', 'Verifier', 'Verify', '[]', '["output/verification.md"]', 'appserver', 'Verify')
    `);
    app = express();
    app.use(express.json());
    app.use('/api', workflowsRouter(orchestration.database));
  });

  afterEach(() => {
    orchestration.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stores workflow context, version, and explicit NEEDS_FIX routing', async () => {
    const response = await request(app, {
      id: 'quality-flow',
      name: 'Quality Flow',
      description: 'test',
      context: 'Preserve behavior.',
      version: 2,
      steps: ['implementer', 'verifier'],
      needsFix: { verifier: 'implementer' },
    });

    expect(response.status).toBe(201);
    expect(orchestration.database.get<{
      context: string; version: number; needs_fix_map: string;
    }>('SELECT context, version, needs_fix_map FROM workflows WHERE id = ?', 'quality-flow')).toEqual({
      context: 'Preserve behavior.',
      version: 2,
      needs_fix_map: JSON.stringify({ verifier: 'implementer' }),
    });
  });

  it('rejects a NEEDS_FIX target that does not precede the quality gate', async () => {
    const response = await request(app, {
      id: 'invalid-flow',
      name: 'Invalid Flow',
      steps: ['verifier', 'implementer'],
      needsFix: { verifier: 'implementer' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('must be an earlier step');
  });
});

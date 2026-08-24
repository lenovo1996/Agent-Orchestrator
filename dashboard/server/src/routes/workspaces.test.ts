import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestOrchestration } from '../test-helpers.js';
import { workspacesRouter } from './workspaces.js';

const httpFetch = globalThis.fetch;

async function request(app: express.Express, method: string, url: string, body: unknown) {
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await httpFetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

describe('workspace path handling', () => {
  let root: string;
  let orchestration: ReturnType<typeof createTestOrchestration>;
  let app: express.Express;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-routes-'));
    orchestration = createTestOrchestration(root, path.join(root, 'task-flows'), []);
    app = express();
    app.use(express.json());
    app.use('/api', workspacesRouter(orchestration.database));
  });

  afterEach(() => {
    orchestration.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createWorkspace(workspacePath: string, id = 'workspace-1') {
    return request(app, 'POST', '/api/workspaces', { id, name: 'Workspace', path: workspacePath });
  }

  it('stores a normalized absolute path without checking whether it exists', async () => {
    const workspacePath = path.join(root, 'missing-parent', '..', 'missing-workspace');
    expect(fs.existsSync(workspacePath)).toBe(false);

    const response = await createWorkspace(workspacePath);

    expect(response.status).toBe(201);
    expect(orchestration.database.get<{ path: string }>('SELECT path FROM workspaces WHERE id = ?', 'workspace-1')?.path)
      .toBe(path.normalize(workspacePath));
  });

  it('accepts an absolute path outside the DevTeam project directory', async () => {
    const externalPath = path.join(os.tmpdir(), 'external-workspace-that-need-not-exist');

    const response = await createWorkspace(externalPath);

    expect(response.status).toBe(201);
  });

  it('rejects relative paths', async () => {
    const response = await createWorkspace('relative/project');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'invalid_workspace_path' });
    expect(response.body.error).toContain('absolute path');
  });

  it('updates to a missing absolute path without checking the filesystem', async () => {
    await createWorkspace(path.join(root, 'original-missing'));
    const replacement = path.join(os.tmpdir(), 'replacement-workspace-that-need-not-exist');

    const response = await request(app, 'PUT', '/api/workspaces/workspace-1', {
      name: 'Workspace', path: replacement,
    });

    expect(response.status).toBe(200);
    expect(orchestration.database.get<{ path: string }>('SELECT path FROM workspaces WHERE id = ?', 'workspace-1')?.path)
      .toBe(path.normalize(replacement));
  });
});

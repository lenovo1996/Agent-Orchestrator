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

describe('workspace path validation', () => {
  let root: string;
  let sharedRoot: string;
  let orchestration: ReturnType<typeof createTestOrchestration>;
  let app: express.Express;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-routes-'));
    sharedRoot = path.join(root, 'shared');
    fs.mkdirSync(sharedRoot);
    orchestration = createTestOrchestration(root, path.join(root, 'task-flows'), []);
    app = express();
    app.use(express.json());
    app.use('/api', workspacesRouter(orchestration.database, sharedRoot));
  });

  afterEach(() => {
    orchestration.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createWorkspace(workspacePath: string, id = 'workspace-1') {
    return request(app, 'POST', '/api/workspaces', { id, name: 'Workspace', path: workspacePath });
  }

  it('stores the canonical path of a readable directory inside the shared root', async () => {
    const directory = path.join(sharedRoot, 'project');
    fs.mkdirSync(directory);

    const response = await createWorkspace(path.join(directory, '.'));

    expect(response.status).toBe(201);
    expect(orchestration.database.get<{ path: string }>('SELECT path FROM workspaces WHERE id = ?', 'workspace-1')?.path)
      .toBe(fs.realpathSync(directory));
  });

  it('rejects relative paths', async () => {
    const response = await createWorkspace('relative/project');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'invalid_workspace_path' });
    expect(response.body.error).toContain('absolute path');
  });

  it('rejects missing directories', async () => {
    const response = await createWorkspace(path.join(sharedRoot, 'missing'));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'invalid_workspace_path' });
    expect(response.body.error).toContain('does not exist');
  });

  it('rejects files and directories outside the shared root', async () => {
    const file = path.join(sharedRoot, 'file.txt');
    const outside = path.join(root, 'outside');
    fs.writeFileSync(file, 'not a directory');
    fs.mkdirSync(outside);

    const fileResponse = await createWorkspace(file, 'workspace-file');
    const outsideResponse = await createWorkspace(outside, 'workspace-outside');

    expect(fileResponse.status).toBe(400);
    expect(fileResponse.body.error).toContain('must be a directory');
    expect(outsideResponse.status).toBe(400);
    expect(outsideResponse.body.error).toContain('must be inside shared root');
  });

  it('rejects a symlink inside the shared root when it resolves outside', async () => {
    const outside = path.join(root, 'outside');
    const link = path.join(sharedRoot, 'escaped-link');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, link);

    const response = await createWorkspace(link);

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('must be inside shared root');
  });

  it('validates updates and preserves the previous path after rejection', async () => {
    const original = path.join(sharedRoot, 'original');
    const replacement = path.join(sharedRoot, 'replacement');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(original);
    fs.mkdirSync(replacement);
    fs.mkdirSync(outside);
    await createWorkspace(original);

    const rejected = await request(app, 'PUT', '/api/workspaces/workspace-1', {
      name: 'Workspace', path: outside,
    });
    const accepted = await request(app, 'PUT', '/api/workspaces/workspace-1', {
      name: 'Workspace', path: replacement,
    });

    expect(rejected.status).toBe(400);
    expect(accepted.status).toBe(200);
    expect(orchestration.database.get<{ path: string }>('SELECT path FROM workspaces WHERE id = ?', 'workspace-1')?.path)
      .toBe(fs.realpathSync(replacement));
  });
});

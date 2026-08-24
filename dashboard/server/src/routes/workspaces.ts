import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { OrchestrationDatabase } from '@devteam-dashboard/orchestration';

class WorkspacePathValidationError extends Error {}

function normalizeWorkspacePath(candidate: unknown): string {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new WorkspacePathValidationError('Workspace path is required');
  }
  const requestedPath = candidate.trim();
  if (!path.isAbsolute(requestedPath)) {
    throw new WorkspacePathValidationError('Workspace path must be an absolute path');
  }
  return path.normalize(requestedPath);
}

export function workspacesRouter(database: OrchestrationDatabase): Router {
  const router = Router();

  router.get('/workspaces', (_req, res) => {
    res.json(database.all('SELECT * FROM workspaces ORDER BY name'));
  });

  router.post('/workspaces', (req, res) => {
    const { id, name, path: requestedPath } = req.body;
    if (!id || !name || !requestedPath) {
      res.status(400).json({ error: 'Invalid workspace data' });
      return;
    }
    let workspacePath: string;
    try {
      workspacePath = normalizeWorkspacePath(requestedPath);
    } catch (error) {
      if (error instanceof WorkspacePathValidationError) {
        res.status(400).json({ error: error.message, code: 'invalid_workspace_path' });
        return;
      }
      throw error;
    }
    try {
      database.run('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)', id, name, workspacePath);
      res.status(201).json({ success: true, id });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });

  router.put('/workspaces/:id', (req, res) => {
    const { name, path: requestedPath } = req.body;
    if (!name || !requestedPath) {
      res.status(400).json({ error: 'Invalid workspace data' });
      return;
    }
    let workspacePath: string;
    try {
      workspacePath = normalizeWorkspacePath(requestedPath);
    } catch (error) {
      if (error instanceof WorkspacePathValidationError) {
        res.status(400).json({ error: error.message, code: 'invalid_workspace_path' });
        return;
      }
      throw error;
    }
    const result = database.run(
      'UPDATE workspaces SET name = ?, path = ? WHERE id = ?',
      name, workspacePath, req.params.id,
    );
    if (!result.changes) res.status(404).json({ error: 'Workspace not found' });
    else res.json({ success: true });
  });

  router.delete('/workspaces/:id', (req, res) => {
    const workspace = database.get<{ path: string }>('SELECT path FROM workspaces WHERE id = ?', req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    try {
      database.run('DELETE FROM workspaces WHERE id = ?', req.params.id);
      if (req.body?.deleteDirectory === true) fs.rmSync(workspace.path, { recursive: true, force: true });
      res.json({ success: true });
    } catch {
      res.status(409).json({ error: 'Workspace has active or historical flows' });
    }
  });

  return router;
}

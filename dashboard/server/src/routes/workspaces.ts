import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { OrchestrationDatabase } from '@devteam-dashboard/orchestration';

class WorkspacePathValidationError extends Error {}

function canonicalDirectory(directory: string, label: string): string {
  if (!path.isAbsolute(directory)) {
    throw new WorkspacePathValidationError(`${label} must be an absolute path`);
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(directory);
  } catch {
    throw new WorkspacePathValidationError(`${label} does not exist`);
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw new WorkspacePathValidationError(`${label} must be a directory`);
  }
  try {
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new WorkspacePathValidationError(`${label} must be readable and traversable`);
  }
  return canonical;
}

function validateWorkspacePath(candidate: unknown, canonicalRoot: string): string {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new WorkspacePathValidationError('Workspace path is required');
  }
  const canonical = canonicalDirectory(candidate.trim(), 'Workspace path');
  const relative = path.relative(canonicalRoot, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkspacePathValidationError(`Workspace path must be inside shared root: ${canonicalRoot}`);
  }
  return canonical;
}

export function workspacesRouter(database: OrchestrationDatabase, workspaceRoot: string): Router {
  const router = Router();
  const canonicalRoot = canonicalDirectory(workspaceRoot, 'Shared workspace root');

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
      workspacePath = validateWorkspacePath(requestedPath, canonicalRoot);
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
      workspacePath = validateWorkspacePath(requestedPath, canonicalRoot);
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

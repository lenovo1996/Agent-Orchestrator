import fs from 'node:fs';
import { Router } from 'express';
import type { OrchestrationDatabase } from '@devteam-dashboard/orchestration';

export function workspacesRouter(database: OrchestrationDatabase): Router {
  const router = Router();

  router.get('/workspaces', (_req, res) => {
    res.json(database.all('SELECT * FROM workspaces ORDER BY name'));
  });

  router.post('/workspaces', (req, res) => {
    const { id, name, path } = req.body;
    if (!id || !name || !path) {
      res.status(400).json({ error: 'Invalid workspace data' });
      return;
    }
    try {
      database.run('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)', id, name, path);
      res.status(201).json({ success: true, id });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });

  router.put('/workspaces/:id', (req, res) => {
    const { name, path } = req.body;
    if (!name || !path) {
      res.status(400).json({ error: 'Invalid workspace data' });
      return;
    }
    const result = database.run('UPDATE workspaces SET name = ?, path = ? WHERE id = ?', name, path, req.params.id);
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

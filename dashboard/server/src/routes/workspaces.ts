import { Router } from 'express';
import { db } from '../db.js';
import type { Workspace } from '@devteam-dashboard/shared';
import fs from 'node:fs';

export function workspacesRouter() {
  const router = Router();

  // GET /api/workspaces
  router.get('/workspaces', (req, res) => {
    db.all('SELECT * FROM workspaces', [], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    });
  });

  // POST /api/workspaces
  router.post('/workspaces', (req, res) => {
    const { id, name, path } = req.body;

    if (!id || !name || !path) {
      return res.status(400).json({ error: 'Invalid workspace data' });
    }

    if (!fs.existsSync(path)) {
      return res.status(400).json({ error: 'Workspace path does not exist' });
    }

    const stmt = db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)');
    stmt.run([id, name, path], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.status(201).json({ success: true, id });
    });
    stmt.finalize();
  });

  // PUT /api/workspaces/:id
  router.put('/workspaces/:id', (req, res) => {
    const { id } = req.params;
    const { name, path } = req.body;

    if (!name || !path) {
      return res.status(400).json({ error: 'Invalid workspace data' });
    }

    if (!fs.existsSync(path)) {
      return res.status(400).json({ error: 'Workspace path does not exist' });
    }

    const stmt = db.prepare('UPDATE workspaces SET name = ?, path = ? WHERE id = ?');
    stmt.run([name, path, id], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Workspace not found' });
      }
      res.json({ success: true });
    });
    stmt.finalize();
  });

  // DELETE /api/workspaces/:id
  router.delete('/workspaces/:id', (req, res) => {
    const { id } = req.params;

    const stmt = db.prepare('DELETE FROM workspaces WHERE id = ?');
    stmt.run([id], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Workspace not found' });
      }
      res.json({ success: true });
    });
    stmt.finalize();
  });

  return router;
}

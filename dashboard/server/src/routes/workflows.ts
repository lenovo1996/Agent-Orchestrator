import { Router } from 'express';
import { db } from '../db.js';
import type { CustomWorkflow } from '@devteam-dashboard/shared';

export function workflowsRouter() {
  const router = Router();

  // GET /api/workflows
  router.get('/workflows', (req, res) => {
    db.all('SELECT * FROM workflows', [], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      const workflows: CustomWorkflow[] = rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        steps: JSON.parse(row.steps),
      }));
      res.json(workflows);
    });
  });

  // POST /api/workflows
  router.post('/workflows', (req, res) => {
    const { id, name, description, steps } = req.body;

    if (!id || !name || !steps || !Array.isArray(steps)) {
      return res.status(400).json({ error: 'Invalid workflow data' });
    }

    const stmt = db.prepare('INSERT INTO workflows (id, name, description, steps) VALUES (?, ?, ?, ?)');
    stmt.run([id, name, description, JSON.stringify(steps)], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.status(201).json({ success: true, id });
    });
    stmt.finalize();
  });

  // PUT /api/workflows/:id
  router.put('/workflows/:id', (req, res) => {
    const { id } = req.params;
    const { name, description, steps } = req.body;

    if (!name || !steps || !Array.isArray(steps)) {
      return res.status(400).json({ error: 'Invalid workflow data' });
    }

    const stmt = db.prepare('UPDATE workflows SET name = ?, description = ?, steps = ? WHERE id = ?');
    stmt.run([name, description, JSON.stringify(steps), id], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Workflow not found' });
      }
      res.json({ success: true });
    });
    stmt.finalize();
  });

  // DELETE /api/workflows/:id
  router.delete('/workflows/:id', (req, res) => {
    const { id } = req.params;

    const stmt = db.prepare('DELETE FROM workflows WHERE id = ?');
    stmt.run([id], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Workflow not found' });
      }
      res.json({ success: true });
    });
    stmt.finalize();
  });

  return router;
}

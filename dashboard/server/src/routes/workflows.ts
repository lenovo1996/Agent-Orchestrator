import { Router } from 'express';
import type { OrchestrationDatabase } from '@devteam-dashboard/orchestration';
import type { CustomWorkflow } from '@devteam-dashboard/shared';

export function workflowsRouter(database: OrchestrationDatabase): Router {
  const router = Router();

  router.get('/workflows', (_req, res) => {
    const workflows = database.all<{ id: string; name: string; description: string | null; steps: string }>(
      'SELECT * FROM workflows ORDER BY name',
    ).map((row): CustomWorkflow => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      steps: JSON.parse(row.steps) as string[],
    }));
    res.json(workflows);
  });

  router.post('/workflows', (req, res) => {
    const { id, name, description, steps } = req.body;
    if (!id || !name || !Array.isArray(steps) || !steps.length) {
      res.status(400).json({ error: 'Invalid workflow data' });
      return;
    }
    try {
      database.run(
        'INSERT INTO workflows (id, name, description, steps) VALUES (?, ?, ?, ?)',
        id, name, description || '', JSON.stringify(steps),
      );
      res.status(201).json({ success: true, id });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });

  router.put('/workflows/:id', (req, res) => {
    const { name, description, steps } = req.body;
    if (!name || !Array.isArray(steps) || !steps.length) {
      res.status(400).json({ error: 'Invalid workflow data' });
      return;
    }
    const result = database.run(
      'UPDATE workflows SET name = ?, description = ?, steps = ? WHERE id = ?',
      name, description || '', JSON.stringify(steps), req.params.id,
    );
    if (!result.changes) res.status(404).json({ error: 'Workflow not found' });
    else res.json({ success: true });
  });

  router.delete('/workflows/:id', (req, res) => {
    try {
      const result = database.run('DELETE FROM workflows WHERE id = ?', req.params.id);
      if (!result.changes) res.status(404).json({ error: 'Workflow not found' });
      else res.json({ success: true });
    } catch {
      res.status(409).json({ error: 'Workflow is referenced by one or more flows' });
    }
  });

  return router;
}

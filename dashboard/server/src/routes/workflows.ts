import { Router } from 'express';
import type { OrchestrationDatabase } from '@devteam-dashboard/orchestration';
import type { CustomWorkflow } from '@devteam-dashboard/shared';

function validateNeedsFix(steps: string[], value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('needsFix must be an object');
  }
  const needsFix = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [gate, target] of Object.entries(needsFix)) {
    const gateIndex = steps.indexOf(gate);
    if (gateIndex < 0 || typeof target !== 'string') throw new Error(`Invalid NEEDS_FIX policy for ${gate}`);
    if (target !== 'block') {
      const targetIndex = steps.indexOf(target);
      if (targetIndex < 0 || targetIndex >= gateIndex) {
        throw new Error(`NEEDS_FIX target for ${gate} must be an earlier step`);
      }
    }
    result[gate] = target;
  }
  return result;
}

export function workflowsRouter(database: OrchestrationDatabase): Router {
  const router = Router();

  router.get('/workflows', (_req, res) => {
    const workflows = database.all<{
      id: string; name: string; description: string | null; steps: string;
      context: string; needs_fix_map: string; version: number;
    }>(
      'SELECT * FROM workflows ORDER BY name',
    ).map((row): CustomWorkflow => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      steps: JSON.parse(row.steps) as string[],
      context: row.context,
      needsFix: JSON.parse(row.needs_fix_map) as Record<string, string>,
      version: Number(row.version),
    }));
    res.json(workflows);
  });

  router.post('/workflows', (req, res) => {
    const { id, name, description, steps, context, needsFix, version } = req.body;
    if (!id || !name || !Array.isArray(steps) || !steps.length) {
      res.status(400).json({ error: 'Invalid workflow data' });
      return;
    }
    try {
      const validatedNeedsFix = validateNeedsFix(steps, needsFix);
      database.run(
        `INSERT INTO workflows (id, name, description, steps, context, needs_fix_map, version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, name, description || '', JSON.stringify(steps), context || '',
        JSON.stringify(validatedNeedsFix), Number(version) > 0 ? Number(version) : 1,
      );
      res.status(201).json({ success: true, id });
    } catch (error) {
      const message = (error as Error).message;
      res.status(message.includes('NEEDS_FIX') || message.includes('needsFix') ? 400 : 409)
        .json({ error: message });
    }
  });

  router.put('/workflows/:id', (req, res) => {
    const { name, description, steps, context, needsFix, version } = req.body;
    if (!name || !Array.isArray(steps) || !steps.length) {
      res.status(400).json({ error: 'Invalid workflow data' });
      return;
    }
    try {
      const validatedNeedsFix = validateNeedsFix(steps, needsFix);
      const result = database.run(
        `UPDATE workflows SET name = ?, description = ?, steps = ?, context = ?,
         needs_fix_map = ?, version = ? WHERE id = ?`,
        name, description || '', JSON.stringify(steps), context || '',
        JSON.stringify(validatedNeedsFix), Number(version) > 0 ? Number(version) : 1, req.params.id,
      );
      if (!result.changes) res.status(404).json({ error: 'Workflow not found' });
      else res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
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

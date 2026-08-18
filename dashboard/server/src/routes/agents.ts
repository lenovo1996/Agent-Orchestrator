import fs from 'fs';
import { Router } from 'express';
import path from 'path';
import type { OrchestrationDatabase } from '@devteam-dashboard/orchestration';

import { fileURLToPath } from 'url';
import type { AgentConfig } from '@devteam-dashboard/shared';
import { syncAgentsToFileSystem } from '../services/agent-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbDir = path.resolve(__dirname, '../../../../'); // Agent-Orchestrator root (not dashboard)

export function agentsRouter(db: OrchestrationDatabase) {
  const router = Router();

  // GET /api/agents
  router.get('/agents', (req, res) => {
      const agents: AgentConfig[] = db.all<any>('SELECT * FROM agents ORDER BY id').map((row) => ({
        id: row.id,
        role: row.role,
        objective: row.objective,
        model: row.model,
        thinking: row.thinking,
        tools: JSON.parse(row.tools),
        outputs: JSON.parse(row.outputs),
        runtime: row.runtime,
        runtimeCommand: row.runtime_command || undefined,
        instructions: row.instructions,
      }));
      res.json(agents);
  });

  // POST /api/agents
  router.post('/agents', (req, res) => {
    const { id, role, objective, model, thinking, tools, outputs, runtime, runtimeCommand, instructions } = req.body;

    if (!id || !role || !objective || !tools || !outputs || !instructions) {
      return res.status(400).json({ error: 'Missing required agent data' });
    }

    try {
      db.run(
        'INSERT INTO agents (id, role, objective, model, thinking, tools, outputs, runtime, runtime_command, instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, role, objective, model || '', thinking || '', JSON.stringify(tools), JSON.stringify(outputs), runtime || '', runtimeCommand || null, instructions,
      );
      syncAgentsToFileSystem(dbDir, db);
      res.status(201).json({ success: true, id });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });

  // PUT /api/agents/:id
  router.put('/agents/:id', (req, res) => {
    const { id } = req.params;
    const { role, objective, model, thinking, tools, outputs, runtime, runtimeCommand, instructions } = req.body;

    if (!role || !objective || !tools || !outputs || !instructions) {
      return res.status(400).json({ error: 'Missing required agent data' });
    }

    const result = db.run(
      'UPDATE agents SET role = ?, objective = ?, model = ?, thinking = ?, tools = ?, outputs = ?, runtime = ?, runtime_command = ?, instructions = ? WHERE id = ?',
      role, objective, model || '', thinking || '', JSON.stringify(tools), JSON.stringify(outputs), runtime || '', runtimeCommand || null, instructions, id,
    );
      if (!result.changes) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      syncAgentsToFileSystem(dbDir, db);
      res.json({ success: true });
  });

  // DELETE /api/agents/:id
  router.delete('/agents/:id', (req, res) => {
    const { id } = req.params;

    try {
      const result = db.run('DELETE FROM agents WHERE id = ?', id);
      if (!result.changes) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      // Also delete from filesystem
      try {
        const promptPath = path.join(dbDir, 'prompts', `${id}.md`);
        if (fs.existsSync(promptPath)) {
          fs.unlinkSync(promptPath);
        }
      } catch (e) {
        console.error('Error removing prompt file', e);
      }

      syncAgentsToFileSystem(dbDir, db);
      res.json({ success: true });
    } catch {
      res.status(409).json({ error: 'Agent is referenced by an existing flow snapshot' });
    }
  });

  return router;
}

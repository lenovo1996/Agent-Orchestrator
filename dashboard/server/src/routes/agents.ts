import { Router } from 'express';
import { db } from '../db.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { AgentConfig } from '@devteam-dashboard/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbDir = path.resolve(__dirname, '../../../');

const PROJECT_CONTEXT_MARKER = `## MANDATORY: Read Project Context First

**Before doing anything else, read these files to understand the project:**

1. \`{{REPO_ROOT}}/AGENTS.md\` — project overview, conventions, agent guidelines
2. \`{{REPO_ROOT}}/.agents/rules/\` — any rule files if present
3. \`{{REPO_ROOT}}/.tasks/{{TASK_ID}}/summary.md\` — previous knowledge about this task (if exists)
4. \`{{REPO_ROOT}}/.tasks/{{TASK_ID}}/active-context.md\` — compact context from prior steps (if exists, read FIRST)

Use \`read\` tool to load these files. Do not skip this step.
If \`.tasks/{{TASK_ID}}/summary.md\` exists, use it to understand prior decisions, progress, and context from previous runs.
If \`.tasks/{{TASK_ID}}/active-context.md\` exists, it contains a compact summary of all prior agents' work — prefer this over reading full output files unless you need specific details.`;

const INPUT_MARKER = `## Input

- Repo root: \`{{REPO_ROOT}}\`
- Previous steps outputs
- Associated workspace or worktree path`;

const STATUS_MARKER = `## IMPORTANT: Status Marker

Your output file MUST include this section near the top:

\`\`\`markdown
## Status
DONE
\`\`\`

If blocked (missing context, access, environment, or decision), write:

\`\`\`markdown
## Status
BLOCKED
\`\`\`

If you cannot complete due to technical error, write:

\`\`\`markdown
## Status
FAILED
\`\`\`

**Status meanings:**
- \`DONE\`: Step complete, can proceed
- \`BLOCKED\`: Missing info/access/env, needs human intervention
- \`FAILED\`: Technical error, will retry

Do not omit the status marker.`;

export function agentsRouter() {
  const router = Router();

  // Helper to sync to team.json and prompts/
  function syncAgentsToFileSystem() {
    db.all('SELECT * FROM agents', [], (err, rows: any[]) => {
      if (err) {
        console.error('Failed to sync agents to filesystem', err);
        return;
      }

      try {
        const teamJsonPath = path.join(dbDir, 'team.json');
        let teamConfig: any = { members: {} };
        if (fs.existsSync(teamJsonPath)) {
          teamConfig = JSON.parse(fs.readFileSync(teamJsonPath, 'utf8'));
        }

        teamConfig.members = {};

        const promptsDir = path.join(dbDir, 'prompts');
        if (!fs.existsSync(promptsDir)) {
          fs.mkdirSync(promptsDir, { recursive: true });
        }

        for (const row of rows) {
          teamConfig.members[row.id] = {
            role: row.role,
            objective: row.objective,
            model: row.model || undefined,
            thinking: row.thinking || undefined,
            tools: JSON.parse(row.tools),
            outputs: JSON.parse(row.outputs),
            runtime: row.runtime || undefined,
          };

          let finalInstructions = row.instructions;

          if (!finalInstructions.includes('Read Project Context First')) {
            finalInstructions += '\n\n' + PROJECT_CONTEXT_MARKER + '\n';
          }

          if (!finalInstructions.includes('## Input')) {
            finalInstructions += '\n\n' + INPUT_MARKER + '\n';
          }

          if (!finalInstructions.includes('## IMPORTANT: Status Marker')) {
            finalInstructions += '\n\n' + STATUS_MARKER + '\n';
          }

          if (!finalInstructions.includes('## Output Format')) {
            const outputs: string[] = JSON.parse(row.outputs);
            const outputFiles = outputs && outputs.length > 0 ? outputs.join(', ') : 'output.md';
            const outputFormatMarker = `## Output Format\n\nWrite to \`${outputFiles}\`:\n\n\`\`\`markdown\n# Output\n\n[Your content here]\n\`\`\`\n`;
            finalInstructions += '\n' + outputFormatMarker + '\n';
          }

          const promptPath = path.join(promptsDir, `${row.id}.md`);
          fs.writeFileSync(promptPath, finalInstructions, 'utf8');
        }

        fs.writeFileSync(teamJsonPath, JSON.stringify(teamConfig, null, 2), 'utf8');
      } catch (e) {
        console.error('Error syncing agents', e);
      }
    });
  }

  // GET /api/agents
  router.get('/agents', (req, res) => {
    db.all('SELECT * FROM agents', [], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      const agents: AgentConfig[] = rows.map((row: any) => ({
        id: row.id,
        role: row.role,
        objective: row.objective,
        model: row.model,
        thinking: row.thinking,
        tools: JSON.parse(row.tools),
        outputs: JSON.parse(row.outputs),
        runtime: row.runtime,
        instructions: row.instructions,
      }));
      res.json(agents);
    });
  });

  // POST /api/agents
  router.post('/agents', (req, res) => {
    const { id, role, objective, model, thinking, tools, outputs, runtime, instructions } = req.body;

    if (!id || !role || !objective || !tools || !outputs || !instructions) {
      return res.status(400).json({ error: 'Missing required agent data' });
    }

    const stmt = db.prepare('INSERT INTO agents (id, role, objective, model, thinking, tools, outputs, runtime, instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    stmt.run([
      id, role, objective, model || '', thinking || '', JSON.stringify(tools), JSON.stringify(outputs), runtime || '', instructions
    ], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      syncAgentsToFileSystem();
      res.status(201).json({ success: true, id });
    });
    stmt.finalize();
  });

  // PUT /api/agents/:id
  router.put('/agents/:id', (req, res) => {
    const { id } = req.params;
    const { role, objective, model, thinking, tools, outputs, runtime, instructions } = req.body;

    if (!role || !objective || !tools || !outputs || !instructions) {
      return res.status(400).json({ error: 'Missing required agent data' });
    }

    const stmt = db.prepare('UPDATE agents SET role = ?, objective = ?, model = ?, thinking = ?, tools = ?, outputs = ?, runtime = ?, instructions = ? WHERE id = ?');
    stmt.run([
      role, objective, model || '', thinking || '', JSON.stringify(tools), JSON.stringify(outputs), runtime || '', instructions, id
    ], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      syncAgentsToFileSystem();
      res.json({ success: true });
    });
    stmt.finalize();
  });

  // DELETE /api/agents/:id
  router.delete('/agents/:id', (req, res) => {
    const { id } = req.params;

    const stmt = db.prepare('DELETE FROM agents WHERE id = ?');
    stmt.run([id], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Agent not found' });
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

      syncAgentsToFileSystem();
      res.json({ success: true });
    });
    stmt.finalize();
  });

  return router;
}

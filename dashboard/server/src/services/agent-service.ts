import fs from 'node:fs';
import path from 'node:path';
import type { OrchestrationDatabase } from '@devteam-dashboard/orchestration';

const PROJECT_CONTEXT_MARKER = `## MANDATORY: Read Project Context First

**Before doing anything else, read these files to understand the project:**

1. \`{{REPO_ROOT}}/AGENTS.md\` — project overview, conventions, agent guidelines
2. \`{{REPO_ROOT}}/.agents/rules/\` — any rule files if present
3. \`{{REPO_ROOT}}/.tasks/{{TASK_ID}}/summary.md\` — previous knowledge about this task (if exists)
4. \`{{REPO_ROOT}}/.tasks/{{TASK_ID}}/active-context.md\` — compact context from prior steps (if exists, read FIRST)

Use \`read\` tool to load these files. Do not skip this step.
If \`.tasks/{{TASK_ID}}/summary.md\` exists, use it to understand prior decisions, progress, and context from previous runs.
If \`.tasks/{{TASK_ID}}/active-context.md\` exists, it contains a compact summary of all prior agents' work — prefer this over reading full output files unless you need specific details.`;

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

export function syncAgentsToFileSystem(dbDir: string, db: OrchestrationDatabase) {
  const rows = db.all<any>('SELECT * FROM agents ORDER BY rowid');
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
          runtimeCommand: row.runtime_command || undefined,
        };

        let finalInstructions = row.instructions;

        if (!finalInstructions.includes('Read Project Context First')) {
          finalInstructions += '\n\n' + PROJECT_CONTEXT_MARKER + '\n';
        }

        if (!finalInstructions.includes('## Input')) {
          const allAgents = Object.keys(teamConfig.members);
          const thisIndex = allAgents.indexOf(row.id);
          let prevOutputs: string[] = [];
          if (thisIndex > 0) {
            const prevAgents = allAgents.slice(0, thisIndex);
            prevAgents.forEach(id => {
              const outputs = teamConfig.members[id].outputs;
              if (outputs && outputs.length > 0) {
                outputs.forEach((out: string) => {
                  prevOutputs.push(`- \`${out.replace('output/', '')}\` from ${teamConfig.members[id].role}`);
                });
              }
            });
          }

          let inputMarkerStr = `## Input\n\n`;
          if (prevOutputs.length > 0) {
            inputMarkerStr += prevOutputs.join('\n') + '\n';
          }
          inputMarkerStr += `- Repo root: \`{{REPO_ROOT}}\`\n- Associated workspace or worktree path`;

          finalInstructions += '\n\n' + inputMarkerStr + '\n';
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
}

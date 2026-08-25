import fs from 'node:fs';
import path from 'node:path';
import type { OrchestrationDatabase } from '@devteam-dashboard/orchestration';

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

      const activePromptFiles = new Set(rows.map((row) => `${row.id}.md`));
      for (const filename of fs.readdirSync(promptsDir)) {
        if (filename.endsWith('.md') && !activePromptFiles.has(filename)) {
          fs.unlinkSync(path.join(promptsDir, filename));
        }
      }

      for (const row of rows) {
        teamConfig.members[row.id] = {
          role: row.role,
          objective: row.objective,
          model: row.model || undefined,
          thinking: row.thinking || undefined,
          outputs: JSON.parse(row.outputs),
          runtime: row.runtime || undefined,
          runtimeCommand: row.runtime_command || undefined,
        };

        const promptPath = path.join(promptsDir, `${row.id}.md`);
        fs.writeFileSync(promptPath, `${row.instructions.trim()}\n`, 'utf8');
      }

      fs.writeFileSync(teamJsonPath, JSON.stringify(teamConfig, null, 2), 'utf8');
    } catch (e) {
      console.error('Error syncing agents', e);
    }
}

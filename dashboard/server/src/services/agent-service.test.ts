import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestOrchestration } from '../test-helpers.js';
import { syncAgentsToFileSystem } from './agent-service.js';

describe('agent filesystem projection', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes exact database instructions and removes orphaned prompts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-projection-'));
    roots.push(root);
    const orchestration = createTestOrchestration(root, path.join(root, 'task-flows'), []);
    try {
      const promptsDir = path.join(root, 'prompts');
      fs.mkdirSync(promptsDir);
      fs.writeFileSync(path.join(promptsDir, 'orphan.md'), 'old prompt');

      syncAgentsToFileSystem(root, orchestration.database);

      expect(fs.readFileSync(path.join(promptsDir, 'implementer.md'), 'utf8')).toBe('Implement\n');
      expect(fs.existsSync(path.join(promptsDir, 'orphan.md'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'team.json'), 'utf8')).members.implementer)
        .toMatchObject({ role: 'Implementer', runtime: 'generic' });
    } finally {
      orchestration.database.close();
    }
  });
});

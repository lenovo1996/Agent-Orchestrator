import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeamCatalog, resetTeamCatalog } from './catalog.js';
import { createFlow, createTestService } from './test-helpers.js';

let context: ReturnType<typeof createTestService> | null = null;
afterEach(() => {
  context?.close();
  context = null;
});

describe('team catalog', () => {
  it('loads the versioned catalog and replaces old runtime/configuration rows', () => {
    const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(sourceDirectory, '../../..');
    const catalog = loadTeamCatalog(repoRoot);
    expect(catalog.agents).toHaveLength(12);
    expect(catalog.workflows).toHaveLength(12);

    context = createTestService();
    createFlow(context.service);
    const result = resetTeamCatalog(context.database, catalog);

    expect(result).toEqual({ agents: 12, workflows: 12, workspacesPreserved: 1 });
    expect(context.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM flows')?.count).toBe(0);
    expect(context.database.get('SELECT id FROM agents WHERE id = ?', 'verifier')).toBeUndefined();
    expect(context.database.get<{ runtime: string }>(
      'SELECT runtime FROM agents WHERE id = ?', 'implementer',
    )?.runtime).toBe('appserver');
    expect(context.database.get<{ tools: string }>(
      'SELECT tools FROM agents WHERE id = ?', 'implementer',
    )?.tools).toBe('[]');
    expect(context.database.get<{ needs_fix_map: string }>(
      'SELECT needs_fix_map FROM workflows WHERE id = ?', 'pr_audit',
    )?.needs_fix_map).toBe(JSON.stringify({ code_reviewer: 'block', qa_verifier: 'block' }));
  });
});

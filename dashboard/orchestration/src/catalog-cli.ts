import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeamCatalog, resetTeamCatalog } from './catalog.js';
import { OrchestrationDatabase } from './database.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(sourceDirectory, '../../..');
const requestedDbPath = argument('--db');
const dbPath = requestedDbPath
  ? path.resolve(repoRoot, requestedDbPath)
  : path.join(repoRoot, 'workflows.db');
const database = new OrchestrationDatabase(dbPath);

try {
  const catalog = loadTeamCatalog(repoRoot);
  const result = resetTeamCatalog(database, catalog, {
    preserveWorkspaces: !process.argv.includes('--clear-workspaces'),
  });
  process.stdout.write(`${JSON.stringify({ database: dbPath, ...result }, null, 2)}\n`);
} finally {
  database.close();
}

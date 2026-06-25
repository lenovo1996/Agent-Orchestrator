import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface DashboardConfig {
  port: number;
  host: string;
  corsOrigin: string;
  repoRoot: string;
  taskFlowsDir: string;
  scriptDir: string;
  clientDistPath: string;
  isProduction: boolean;
}

/**
 * Find the repository root by walking up from the dashboard server directory
 * looking for the `team.json` file.
 */
function findRepoRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Start from the server/src directory and walk up.
  // Require both team.json AND a scripts/ directory so we skip
  // intermediate dirs (e.g. dashboard/) that may contain their own team.json.
  let current = __dirname;
  const root = path.parse(current).root;

  while (current !== root) {
    const candidate = path.join(current, 'team.json');
    if (fs.existsSync(candidate) && fs.existsSync(path.join(current, 'scripts'))) {
      return current;
    }
    current = path.dirname(current);
  }

  throw new Error(
    '[config] Cannot find repository root: no team.json found in parent directories'
  );
}

/**
 * Load dashboard configuration from team.json and environment variables.
 *
 * - Reads `team.json` to determine outputRoot path for task-flows directory.
 * - Loads env vars: DASHBOARD_PORT, DASHBOARD_HOST, DASHBOARD_CORS_ORIGIN.
 * - Creates task-flows directory if it doesn't exist, logs a warning.
 */
export function loadConfig(): DashboardConfig {
  const repoRoot = findRepoRoot();

  const teamConfigPath = path.join(repoRoot, 'team.json');

  let teamConfig: { outputRoot?: string };
  try {
    teamConfig = JSON.parse(fs.readFileSync(teamConfigPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `[config] Failed to read team.json at ${teamConfigPath}: ${(err as Error).message}`
    );
  }

  const outputRoot = path.resolve(repoRoot, teamConfig.outputRoot || 'task-flows');

  // Ensure task-flows directory exists (Requirement 1.4)
  if (!fs.existsSync(outputRoot)) {
    fs.mkdirSync(outputRoot, { recursive: true });
    console.warn(`[WARN] Created missing task-flows directory: ${outputRoot}`);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  return {
    port: parseInt(process.env.DASHBOARD_PORT || '3001', 10),
    host: process.env.DASHBOARD_HOST || '127.0.0.1',
    corsOrigin: process.env.DASHBOARD_CORS_ORIGIN || '*',
    repoRoot,
    taskFlowsDir: outputRoot,
    scriptDir: path.join(repoRoot, 'scripts'),
    clientDistPath: path.resolve(__dirname, '../../client/dist'),
    isProduction: process.env.NODE_ENV === 'production',
  };
}

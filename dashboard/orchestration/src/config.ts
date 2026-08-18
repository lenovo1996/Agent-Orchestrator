import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OrchestrationConfig {
  repoRoot: string;
  dbPath: string;
  taskFlowsDir: string;
  codexHome: string;
  runnerId: string;
  agentConcurrency: number;
  agentTimeoutMs: number;
  blockedTtl: string;
  blockedTtlMs: number;
  inngestBaseUrl: string;
  inngestGatewayUrl: string;
  workerHeartbeatMs: number;
  workerStaleMs: number;
}

function defaultRepoRoot(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(directory, '../../..');
}

export function parseDuration(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/i.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

export function loadOrchestrationConfig(
  overrides: Partial<OrchestrationConfig> & { repoRoot?: string } = {},
): OrchestrationConfig {
  const repoRoot = path.resolve(overrides.repoRoot || process.env.DEVTEAM_REPO_ROOT || defaultRepoRoot());
  const timeout = process.env.DEVTEAM_AGENT_TIMEOUT || '6h';
  const blockedTtl = process.env.DEVTEAM_BLOCKED_TTL || '30d';
  const concurrency = Number(process.env.DEVTEAM_AGENT_CONCURRENCY || 3);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('DEVTEAM_AGENT_CONCURRENCY must be a positive integer');
  }

  return {
    repoRoot,
    dbPath: path.resolve(overrides.dbPath || process.env.DEVTEAM_DB_PATH || path.join(repoRoot, 'workflows.db')),
    taskFlowsDir: path.resolve(
      overrides.taskFlowsDir || process.env.DEVTEAM_TASK_FLOWS_DIR || path.join(repoRoot, 'task-flows'),
    ),
    codexHome: path.resolve(
      overrides.codexHome || process.env.DASHBOARD_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    ),
    runnerId: overrides.runnerId || process.env.DEVTEAM_RUNNER_ID || os.hostname(),
    agentConcurrency: overrides.agentConcurrency || concurrency,
    agentTimeoutMs: overrides.agentTimeoutMs || parseDuration(timeout),
    blockedTtl: overrides.blockedTtl || blockedTtl,
    blockedTtlMs: overrides.blockedTtlMs || parseDuration(blockedTtl),
    inngestBaseUrl: overrides.inngestBaseUrl || process.env.INNGEST_BASE_URL || 'http://127.0.0.1:8288',
    inngestGatewayUrl: overrides.inngestGatewayUrl || process.env.INNGEST_GATEWAY_URL || 'ws://127.0.0.1:8289/v0/connect',
    workerHeartbeatMs: overrides.workerHeartbeatMs || 5_000,
    workerStaleMs: overrides.workerStaleMs || 15_000,
  };
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OrchestrationConfig {
  repoRoot: string;
  workspaceRoot: string;
  dbPath: string;
  taskFlowsDir: string;
  worktreesDir: string;
  codexHome: string;
  runnerId: string;
  agentConcurrency: number;
  agentTimeoutMs: number;
  blockedTtl: string;
  blockedTtlMs: number;
  inngestBaseUrl: string;
  inngestGatewayUrl: string;
  workerHealthUrl: string;
  expectedUid?: number;
  expectedGid?: number;
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

function parseOptionalId(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function validateWritableDirectory(directory: string, name: string, create: boolean): void {
  try {
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o775 });
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) throw new Error('path is not a directory');
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
    const gid = typeof process.getgid === 'function' ? process.getgid() : 'unknown';
    throw new Error(
      `${name} is not writable by UID:GID ${uid}:${gid}: ${directory} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export function validateRuntimeFilesystem(config: OrchestrationConfig): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  if (config.expectedUid !== undefined && uid !== config.expectedUid) {
    throw new Error(`DEVTEAM_HOST_UID=${config.expectedUid} does not match process UID ${uid ?? 'unknown'}`);
  }
  if (config.expectedGid !== undefined && gid !== config.expectedGid) {
    throw new Error(`DEVTEAM_HOST_GID=${config.expectedGid} does not match process GID ${gid ?? 'unknown'}`);
  }

  validateWritableDirectory(config.workspaceRoot, 'DEVTEAM_WORKSPACE_ROOT', false);
  validateWritableDirectory(config.taskFlowsDir, 'DEVTEAM_TASK_FLOWS_DIR', true);
  validateWritableDirectory(config.worktreesDir, 'DEVTEAM_WORKTREES_DIR', true);
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
    workspaceRoot: path.resolve(
      overrides.workspaceRoot || process.env.DEVTEAM_WORKSPACE_ROOT || path.dirname(repoRoot),
    ),
    dbPath: path.resolve(overrides.dbPath || process.env.DEVTEAM_DB_PATH || path.join(repoRoot, 'workflows.db')),
    taskFlowsDir: path.resolve(
      overrides.taskFlowsDir || process.env.DEVTEAM_TASK_FLOWS_DIR || path.join(repoRoot, 'task-flows'),
    ),
    worktreesDir: path.resolve(
      overrides.worktreesDir || process.env.DEVTEAM_WORKTREES_DIR || path.join(repoRoot, '.worktrees'),
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
    workerHealthUrl: overrides.workerHealthUrl || process.env.DEVTEAM_WORKER_HEALTH_URL || 'http://127.0.0.1:3011',
    expectedUid: overrides.expectedUid ?? parseOptionalId(
      process.env.DEVTEAM_HOST_UID || process.env.HOST_UID,
      'DEVTEAM_HOST_UID',
    ),
    expectedGid: overrides.expectedGid ?? parseOptionalId(
      process.env.DEVTEAM_HOST_GID || process.env.HOST_GID,
      'DEVTEAM_HOST_GID',
    ),
  };
}

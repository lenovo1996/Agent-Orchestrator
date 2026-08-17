import fs from 'node:fs';
import path from 'node:path';
import type { SessionAttemptSummary } from '@devteam-dashboard/shared';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function resolveFlowDirectory(
  taskFlowsDir: string,
  flowId: string,
  workspaceName?: string | null,
): string {
  const safeFlowId = safeSegment(flowId, 'flow ID');
  const root = path.resolve(taskFlowsDir);
  if (workspaceName) {
    return path.join(root, safeSegment(workspaceName, 'workspace name'), safeFlowId);
  }

  const direct = path.join(root, safeFlowId);
  if (fs.existsSync(direct)) return direct;

  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) continue;
      const candidate = path.join(root, entry.name, safeFlowId);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // The caller will return an empty registry or a normal not-found response.
  }
  return direct;
}

function isUsage(value: unknown): value is SessionAttemptSummary['usage'] {
  if (!value || typeof value !== 'object') return value === null;
  const usage = value as Record<string, unknown>;
  return ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']
    .every((key) => Number.isFinite(usage[key]));
}

export function sanitizeAttempt(value: unknown): SessionAttemptSummary | null {
  if (!value || typeof value !== 'object') return null;
  const attempt = value as Record<string, unknown>;
  if (
    attempt.schemaVersion !== 1 ||
    typeof attempt.runId !== 'string' ||
    !RUN_ID.test(attempt.runId) ||
    typeof attempt.flowId !== 'string' ||
    typeof attempt.step !== 'string' ||
    !['starting', 'running', 'completed', 'failed'].includes(String(attempt.status)) ||
    typeof attempt.startedAt !== 'string' ||
    !(attempt.threadId === null || typeof attempt.threadId === 'string') ||
    !(attempt.finishedAt === null || typeof attempt.finishedAt === 'string') ||
    !(attempt.exitCode === null || Number.isInteger(attempt.exitCode)) ||
    !isUsage(attempt.usage)
  ) return null;

  const error = attempt.errorSummary;
  const errorSummary = error && typeof error === 'object'
    && ['before_thread', 'turn', 'process'].includes(String((error as Record<string, unknown>).stage))
    && typeof (error as Record<string, unknown>).message === 'string'
    ? {
        stage: (error as SessionAttemptSummary['errorSummary'] & object).stage,
        message: String((error as Record<string, unknown>).message).slice(0, 500),
      }
    : null;

  return {
    schemaVersion: 1,
    runId: attempt.runId,
    flowId: attempt.flowId,
    step: attempt.step,
    threadId: attempt.threadId as string | null,
    status: attempt.status as SessionAttemptSummary['status'],
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt as string | null,
    exitCode: attempt.exitCode as number | null,
    usage: attempt.usage as SessionAttemptSummary['usage'],
    errorSummary,
  };
}

export function getAttemptPath(
  taskFlowsDir: string,
  flowId: string,
  step: string,
  runId: string,
  workspaceName?: string | null,
): string {
  const flowDir = resolveFlowDirectory(taskFlowsDir, flowId, workspaceName);
  return path.join(
    flowDir,
    'sessions',
    safeSegment(step, 'step'),
    `${safeSegment(runId, 'run ID')}.json`,
  );
}

export function readAttempt(filePath: string): SessionAttemptSummary | null {
  try {
    return sanitizeAttempt(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

export function listAttempts(
  taskFlowsDir: string,
  flowId: string,
  step: string,
  workspaceName?: string | null,
): SessionAttemptSummary[] {
  const flowDir = resolveFlowDirectory(taskFlowsDir, flowId, workspaceName);
  const registryDir = path.join(flowDir, 'sessions', safeSegment(step, 'step'));
  let names: string[];
  try {
    names = fs.readdirSync(registryDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  return names
    .map((name) => readAttempt(path.join(registryDir, name)))
    .filter((attempt): attempt is SessionAttemptSummary => Boolean(
      attempt && attempt.flowId === flowId && attempt.step === step,
    ))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

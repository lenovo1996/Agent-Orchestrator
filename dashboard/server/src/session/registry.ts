import fs from 'node:fs';
import type { SessionAttemptSummary } from '@devteam-dashboard/shared';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

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
    ![1, 2].includes(Number(attempt.schemaVersion)) ||
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

  if (attempt.schemaVersion === 2 && (
    typeof attempt.attemptId !== 'string'
    || typeof attempt.inngestRunId !== 'string'
    || !Number.isInteger(attempt.inngestAttempt)
  )) return null;

  return {
    schemaVersion: attempt.schemaVersion as 1 | 2,
    runId: attempt.runId,
    ...(attempt.schemaVersion === 2 ? {
      attemptId: attempt.attemptId as string,
      inngestRunId: attempt.inngestRunId as string,
      inngestAttempt: attempt.inngestAttempt as number,
    } : {}),
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

export function readAttempt(filePath: string): SessionAttemptSummary | null {
  try {
    return sanitizeAttempt(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Router } from 'express';
import {
  DomainError,
  type OrchestrationRuntime,
} from '@devteam-dashboard/orchestration';
import type { CreateFlowRequest, RetryFlowRequest } from '@devteam-dashboard/shared';
import type { DashboardConfig } from '../config.js';
import { readOutputContent } from '../flow-reader.js';

const MAX_LOG_CONTEXT_LINES = 3_000;

function sendError(res: import('express').Response, error: unknown): void {
  if (error instanceof DomainError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code, details: error.details });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

function tokenValues(content: string): number[] {
  const values: number[] = [];
  const lines = content.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').split('\n');
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index].trim() !== 'tokens used') continue;
    const value = Number.parseInt(lines[index + 1].replace(/[,\.\s]/g, ''), 10);
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  return values;
}

interface WorkerHealthPayload {
  ready?: boolean;
  runnerId?: string;
  status?: string;
  capacity?: number;
}

async function checkInngest(url: string): Promise<{ ready: boolean; error?: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? { ready: true } : { ready: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkWorker(
  url: string,
  fallbackCapacity: number,
): Promise<{
  ready: boolean;
  runnerId: string | null;
  connectionStatus: string | null;
  capacity: number;
  error?: string;
}> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    let payload: WorkerHealthPayload = {};
    try {
      payload = await response.json() as WorkerHealthPayload;
    } catch {
      if (response.ok) return {
        ready: false,
        runnerId: null,
        connectionStatus: null,
        capacity: fallbackCapacity,
        error: 'Invalid worker health response',
      };
    }

    const worker = {
      ready: response.ok && payload.ready === true,
      runnerId: typeof payload.runnerId === 'string' ? payload.runnerId : null,
      connectionStatus: typeof payload.status === 'string' ? payload.status : null,
      capacity: Number.isInteger(payload.capacity) && Number(payload.capacity) > 0
        ? Number(payload.capacity)
        : fallbackCapacity,
    };
    if (!response.ok) return { ...worker, error: `HTTP ${response.status}` };
    if (!worker.ready) return { ...worker, error: 'Worker not ready' };
    return worker;
  } catch (error) {
    return {
      ready: false,
      runnerId: null,
      connectionStatus: null,
      capacity: fallbackCapacity,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function flowsRouter(config: DashboardConfig, runtime: OrchestrationRuntime): Router {
  const { service } = runtime;
  const router = Router();
  router.use(['/flows', '/flows/*', '/orchestration/*'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/flows', (req, res) => {
    try {
      const command = service.createFlow(req.body as CreateFlowRequest, req.header('Idempotency-Key'));
      res.status(202).json(command);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/flows', (req, res) => {
    try {
      const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
      res.json({ flows: service.listFlows(workspaceId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/flows/:flowId', (req, res) => {
    try {
      const flow = service.getFlow(req.params.flowId);
      if (typeof req.query.workspaceId === 'string' && flow.workspaceId !== req.query.workspaceId) {
        res.status(404).json({ error: 'Flow not found' });
        return;
      }
      const { workspacePath: _workspacePath, worktreePath: _worktreePath, ...workflow } = flow;
      res.json({ workflow, attempts: service.listAttempts(flow.flowId), revision: flow.revision });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/flows/:flowId/actions/retry', (req, res) => {
    try {
      const command = service.retryFlow(
        req.params.flowId,
        req.body as RetryFlowRequest,
        req.header('Idempotency-Key'),
      );
      res.status(202).json(command);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/flows/:flowId/actions/resume', (req, res) => {
    try {
      const command = service.resumeFlow(req.params.flowId, req.header('Idempotency-Key'));
      res.status(202).json(command);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/flows/:flowId/actions/stop', async (req, res) => {
    try {
      const command = await runtime.stopFlow(req.params.flowId, req.header('Idempotency-Key'));
      res.status(202).json(command);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/flows/:flowId', (req, res) => {
    try {
      const command = service.deleteFlow(req.params.flowId, req.header('Idempotency-Key'));
      res.status(202).json(command);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/flows/:flowId/logs/:step', (req, res) => {
    try {
      const flow = service.getFlow(req.params.flowId);
      const detail = flow.stepDetails.find((candidate) => candidate.step === req.params.step);
      if (!detail) throw new DomainError(`Step is not part of this flow: ${req.params.step}`, 'invalid_step');
      const logPath = path.join(service.artifactDirectory(flow), 'logs', `${detail.step}.log`);
      if (!fs.existsSync(logPath)) {
        res.json({ lines: [] });
        return;
      }
      const lines = fs.readFileSync(logPath, 'utf8').split('\n');
      res.json({ lines: lines.slice(-MAX_LOG_CONTEXT_LINES) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/flows/:flowId/output/:step', (req, res) => {
    try {
      const result = readOutputContent(service.outputFile(req.params.flowId, req.params.step));
      if (!result) {
        res.json({ content: null, exists: false });
        return;
      }
      res.json({ content: result.content, exists: true, metadata: result.metadata });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/flows/:flowId/tokens', (req, res) => {
    try {
      const flow = service.getFlow(req.params.flowId);
      const artifactDirectory = service.artifactDirectory(flow);
      const tokens: Record<string, number> = {};
      const outputTimes: Record<string, string | null> = {};
      let total = 0;
      for (const step of flow.stepDetails) {
        try {
          const log = fs.readFileSync(path.join(artifactDirectory, 'logs', `${step.step}.log`), 'utf8');
          tokens[step.step] = tokenValues(log).reduce((sum, value) => sum + value, 0);
        } catch {
          tokens[step.step] = 0;
        }
        total += tokens[step.step];
        try {
          outputTimes[step.step] = fs.statSync(service.outputFile(flow.flowId, step.step)).mtime.toISOString();
        } catch {
          outputTimes[step.step] = null;
        }
      }
      res.json({ tokens, total, outputTimes });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/orchestration/health', async (_req, res) => {
    const [inngest, worker] = await Promise.all([
      checkInngest(runtime.config.inngestBaseUrl),
      checkWorker(runtime.config.workerHealthUrl, runtime.config.agentConcurrency),
    ]);
    const ready = worker.ready && inngest.ready;
    res.status(ready ? 200 : 503).json({
      ready,
      inngest: { ready: inngest.ready, url: runtime.config.inngestBaseUrl, ...(inngest.error ? { error: inngest.error } : {}) },
      worker,
    });
  });

  router.get('/git/status', (_req, res) => {
    try {
      const repoRoot = path.resolve(config.repoRoot, '..');
      const repos = fs.readdirSync(repoRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('jinjer_'));
      res.json({ repos: repos.map((entry) => {
        const cwd = path.join(repoRoot, entry.name);
        try {
          const branch = execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8', timeout: 5_000 }).trim();
          const files = execFileSync('git', ['status', '--short'], { cwd, encoding: 'utf8', timeout: 10_000 })
            .trim().split('\n').filter(Boolean);
          return { repo: entry.name, branch, files };
        } catch (error) {
          return { repo: entry.name, branch: '', files: [], error: error instanceof Error ? error.message : String(error) };
        }
      }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

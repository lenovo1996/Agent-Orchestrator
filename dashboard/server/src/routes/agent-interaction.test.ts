import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from '@devteam-dashboard/orchestration';
import { createTestOrchestration, insertTestAttempt } from '../test-helpers.js';
import { agentInteractionRouter } from './agent-interaction.js';

async function request(app: express.Express, body: unknown) {
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/flows/flow_001/steps/implementer/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

describe('agent interaction REST API', () => {
  let root: string;
  let taskFlowsDir: string;
  let orchestration: ReturnType<typeof createTestOrchestration>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-interaction-'));
    taskFlowsDir = path.join(root, 'task-flows');
    orchestration = createTestOrchestration(root, taskFlowsDir, [{
      flowId: 'flow_001',
      workspaceId: 'workspace-1',
    }]);
  });

  afterEach(() => {
    orchestration.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function metadata(runId: string, status: 'running' | 'completed', turnId: string | null) {
    const sessionDir = path.join(
      orchestration.service.artifactDirectory('flow_001'),
      'sessions',
      'implementer',
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, `${runId}.json`), JSON.stringify({
      schemaVersion: 2,
      runId,
      attemptId: `attempt-${runId}`,
      inngestRunId: `inngest-${runId}`,
      inngestAttempt: 0,
      flowId: 'flow_001',
      step: 'implementer',
      threadId: `thread-${runId}`,
      turnId,
      status,
      startedAt: '2026-08-17T00:00:00.000Z',
      finishedAt: status === 'completed' ? '2026-08-17T00:01:00.000Z' : null,
      exitCode: status === 'completed' ? 0 : null,
      usage: null,
      errorSummary: null,
    }));
  }

  it('queues a retry that resumes the selected finished attempt with the message', async () => {
    const runId = 'finished-session';
    insertTestAttempt(orchestration.database, {
      attemptId: `attempt-${runId}`,
      flowId: 'flow_001',
      runId,
      startedAt: '2026-08-17T00:00:00.000Z',
      status: 'completed',
    });
    metadata(runId, 'completed', 'turn-finished');
    orchestration.database.run(`
      UPDATE flows SET status = 'completed', current_step = NULL,
        custom_prompt = 'Original flow prompt', finished_at = updated_at
      WHERE id = 'flow_001'
    `);
    orchestration.database.run(`
      UPDATE flow_steps SET status = 'done', finished_at = updated_at
      WHERE flow_id = 'flow_001' AND step = 'implementer'
    `);
    const app = express();
    app.use(express.json());
    app.use('/api', agentInteractionRouter(
      orchestration.service,
      { appServerClient: null } as unknown as AgentRunner,
    ));

    const response = await request(app, { message: 'Continue this exact session', runId });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ success: true, method: 'resume-queued', runId });
    expect(orchestration.service.getFlow('flow_001')).toMatchObject({
      status: 'queued',
      currentStep: 'implementer',
      customPrompt: 'Original flow prompt',
    });
    expect(orchestration.service.latestRetryCommand('flow_001')).toMatchObject({
      step: 'implementer',
      resumeThread: true,
      sessionRunId: runId,
      followUpMessage: 'Continue this exact session',
    });
  });

  it('steers the active turn belonging to the selected attempt', async () => {
    const runId = 'running-session';
    insertTestAttempt(orchestration.database, {
      attemptId: `attempt-${runId}`,
      flowId: 'flow_001',
      runId,
      startedAt: '2026-08-17T00:00:00.000Z',
      status: 'running',
    });
    metadata(runId, 'running', 'turn-running');
    orchestration.database.run("UPDATE agents SET runtime = 'appserver' WHERE id = 'implementer'");
    const steerTurn = vi.fn(async () => ({ turnId: 'turn-running', status: 'inProgress' }));
    const app = express();
    app.use(express.json());
    app.use('/api', agentInteractionRouter(
      orchestration.service,
      { appServerClient: { connected: true, steerTurn } } as unknown as AgentRunner,
    ));

    const response = await request(app, { message: 'Adjust while working', runId });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, method: 'steer' });
    expect(steerTurn).toHaveBeenCalledWith(
      `thread-${runId}`,
      'turn-running',
      'Adjust while working',
    );
  });
});

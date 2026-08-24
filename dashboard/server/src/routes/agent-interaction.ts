import path from 'node:path';
import fs from 'node:fs';
import { Router } from 'express';
import type { AgentRunner, OrchestrationService, StepAttemptRecord } from '@devteam-dashboard/orchestration';

function sendError(res: import('express').Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes('not found') ? 404 : message.includes('not running') ? 409 : 500;
  res.status(status).json({ error: message });
}

function findRunningAttempt(service: OrchestrationService, flowId: string, step: string) {
  return service.runningAttempts(flowId).find((a) => a.step === step) || null;
}

function findAttempt(
  service: OrchestrationService,
  flowId: string,
  step: string,
  runId?: string,
): StepAttemptRecord | null {
  if (!runId) return findRunningAttempt(service, flowId, step);
  return service.listAttempts(flowId, step).find((attempt) => attempt.sessionRunId === runId) || null;
}

function getAgentRuntime(service: OrchestrationService, step: string): string {
  try {
    const agent = service.getAgent(step);
    return agent.runtime || 'appserver';
  } catch {
    return 'codex';
  }
}

/**
 * Queue a follow-up message to a file for agents using codex runtime.
 * The message will be picked up on the next turn (after current completes).
 */
function queueFollowUpMessage(
  service: OrchestrationService,
  flowId: string,
  step: string,
  message: string,
): { queued: boolean; queuePath: string } {
  const flow = service.getFlow(flowId);
  const artifactDir = service.artifactDirectory(flow);
  const queueDir = path.join(artifactDir, 'follow-ups');
  fs.mkdirSync(queueDir, { recursive: true });
  const queuePath = path.join(queueDir, `${step}.json`);

  let queue: Array<{ message: string; timestamp: string }> = [];
  try {
    queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch { /* empty queue */ }

  queue.push({ message, timestamp: new Date().toISOString() });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');

  return { queued: true, queuePath };
}

export function agentInteractionRouter(
  service: OrchestrationService,
  runner: AgentRunner,
): Router {
  const router = Router();

  /**
   * POST /flows/:flowId/steps/:step/send-message
   * Send a follow-up message to the selected agent session.
   *
   * - finished session: queue an orchestration retry that resumes the selected attempt
   * - running appserver session: send directly via WebSocket (steerTurn/startTurn)
   * - running CLI session: queue the message for delivery after the current turn
   */
  router.post('/flows/:flowId/steps/:step/send-message', async (req, res) => {
    const { flowId, step } = req.params;
    const { message, runId } = req.body as { message?: string; runId?: string };

    if (!message?.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    try {
      const flow = service.getFlow(flowId);
      const attempt = findAttempt(service, flowId, step, runId);
      if (!attempt) {
        res.status(runId ? 404 : 409).json({
          error: runId ? 'Session attempt not found' : `Step ${step} is not running`,
        });
        return;
      }

      if (attempt.status !== 'running') {
        const command = service.retryFlow(flowId, {
          step,
          followUpMessage: message.trim(),
          resumeThread: true,
          sessionRunId: attempt.sessionRunId,
        });
        res.status(202).json({
          success: true,
          method: 'resume-queued',
          commandId: command.commandId,
          runId: attempt.sessionRunId,
        });
        return;
      }

      const artifactDir = service.artifactDirectory(flow);
      const metadataPath = path.join(
        artifactDir, 'sessions', step, `${attempt.sessionRunId}.json`,
      );
      let metadata: { threadId?: string; turnId?: string };
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      } catch {
        res.status(409).json({ error: 'Session metadata not found' });
        return;
      }

      if (!metadata.threadId) {
        res.status(409).json({ error: 'Thread not yet started' });
        return;
      }

      const runtime = getAgentRuntime(service, step);

      if (runtime === 'appserver') {
        // App-server runtime: send directly via WebSocket
        const client = runner.appServerClient;
        if (!client?.connected) {
          res.status(503).json({ error: 'App-server not connected' });
          return;
        }
        try {
          if (metadata.turnId) {
            const result = await client.steerTurn(metadata.threadId, metadata.turnId, message.trim());
            res.json({ success: true, turnId: result.turnId, method: 'steer' });
          } else {
            const result = await client.startTurn(metadata.threadId, message.trim());
            res.json({ success: true, turnId: result.turnId, method: 'new-turn' });
          }
        } catch {
          const result = await client.startTurn(metadata.threadId, message.trim());
          res.json({ success: true, turnId: result.turnId, method: 'new-turn' });
        }
      } else {
        // Codex CLI runtime: queue message (thread is locked by running process)
        const result = queueFollowUpMessage(service, flowId, step, message.trim());
        res.json({
          success: true,
          method: 'queued',
          info: 'Message queued. It will be delivered when the current turn completes. For real-time follow-up, use appserver runtime.',
        });
      }
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * GET /flows/:flowId/steps/:step/follow-ups
   * List queued follow-up messages for a step.
   */
  router.get('/flows/:flowId/steps/:step/follow-ups', (req, res) => {
    const { flowId, step } = req.params;
    try {
      const flow = service.getFlow(flowId);
      const artifactDir = service.artifactDirectory(flow);
      const queuePath = path.join(artifactDir, 'follow-ups', `${step}.json`);
      let queue: Array<{ message: string; timestamp: string }> = [];
      try {
        queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      } catch { /* empty */ }
      res.json({ messages: queue });
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * POST /flows/:flowId/steps/:step/interrupt
   * Interrupt a running agent session.
   */
  router.post('/flows/:flowId/steps/:step/interrupt', async (req, res) => {
    const { flowId, step } = req.params;

    try {
      const flow = service.getFlow(flowId);
      const attempt = findRunningAttempt(service, flowId, step);
      if (!attempt) {
        res.status(409).json({ error: `Step ${step} is not running` });
        return;
      }

      const artifactDir = service.artifactDirectory(flow);
      const metadataPath = path.join(
        artifactDir, 'sessions', step, `${attempt.sessionRunId}.json`,
      );
      let metadata: { threadId?: string };
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      } catch {
        res.status(409).json({ error: 'Session metadata not found' });
        return;
      }

      if (!metadata.threadId) {
        res.status(409).json({ error: 'Thread not yet started' });
        return;
      }

      const runtime = getAgentRuntime(service, step);

      if (runtime === 'appserver') {
        const client = runner.appServerClient;
        if (client?.connected) {
          await client.archiveThread(metadata.threadId);
        }
      }
      // For codex runtime, stopping the flow will kill the process group
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

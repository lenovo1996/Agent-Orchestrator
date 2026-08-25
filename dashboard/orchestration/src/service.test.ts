import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from './errors.js';
import { createFlow, createTestService } from './test-helpers.js';

let context: ReturnType<typeof createTestService>;
beforeEach(() => { context = createTestService(); });
afterEach(() => context.close());

describe('OrchestrationService commands and transitions', () => {
  it('atomically creates flow, steps, command, outbox, and domain event', () => {
    const command = createFlow(context.service, 'start-1');
    expect(context.service.getFlow(command.flowId)).toMatchObject({
      status: 'queued', stepOrder: ['implementer', 'verifier'], generation: 1, revision: 0,
    });
    expect(context.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM flow_steps')?.count).toBe(2);
    expect(context.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM flow_commands')?.count).toBe(1);
    expect(context.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM event_outbox')?.count).toBe(1);
    expect(context.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM domain_events')?.count).toBe(1);
  });

  it('returns the original response for a duplicate start idempotency key', () => {
    const first = createFlow(context.service, 'same-start');
    const second = context.service.createFlow({
      workflowId: 'workflow-1', workspaceId: 'workspace-1', prompt: 'different payload',
    }, 'same-start');
    expect(second).toEqual(first);
    expect(context.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM flows')?.count).toBe(1);
  });

  it('rejects reusing an idempotency key for another operation', () => {
    const flow = createFlow(context.service, 'shared-key');
    expect(() => context.service.requestStop(flow.flowId, 'shared-key')).toThrow(ConflictError);
  });

  it('projects DONE and NEEDS_FIX with a new business cycle', () => {
    const command = createFlow(context.service);
    context.service.claimCoordinator(command.commandId, command.flowId, 'run-1', 'test-runner');
    context.service.queueStep(command.flowId, 'implementer');
    expect(context.service.projectAgentResult(command.flowId, 'implementer', {
      status: 'DONE', attemptId: 'attempt-1',
    }).outcome).toBe('continue');
    context.service.queueStep(command.flowId, 'verifier');
    const result = context.service.projectAgentResult(command.flowId, 'verifier', {
      status: 'NEEDS_FIX', attemptId: 'attempt-2',
    });
    expect(result).toMatchObject({ outcome: 'rewind', nextIndex: 0 });
    expect(context.service.getFlow(command.flowId).stepDetails).toEqual([
      expect.objectContaining({ step: 'implementer', status: 'waiting', cycle: 2 }),
      expect.objectContaining({ step: 'verifier', status: 'waiting', cycle: 2, needsFixCount: 1 }),
    ]);
  });

  it('snapshots workflow context and routes NEEDS_FIX to the configured step', () => {
    context.database.run(`
      UPDATE workflows SET context = ?, needs_fix_map = ? WHERE id = 'workflow-1'
    `, 'Preserve the approved workflow policy.', JSON.stringify({ verifier: 'implementer' }));
    const command = createFlow(context.service);
    const flow = context.service.getFlow(command.flowId);
    expect(flow.workflowContext).toBe('Preserve the approved workflow policy.');
    expect(flow.stepDetails[1]).toMatchObject({ step: 'verifier', onNeedsFix: 'implementer' });

    context.service.claimCoordinator(command.commandId, command.flowId, 'run-policy', 'test-runner');
    context.service.queueStep(command.flowId, 'implementer');
    context.service.projectAgentResult(command.flowId, 'implementer', {
      status: 'DONE', attemptId: 'implementation',
    });
    context.service.queueStep(command.flowId, 'verifier');
    expect(context.service.projectAgentResult(command.flowId, 'verifier', {
      status: 'NEEDS_FIX', attemptId: 'verification',
    })).toMatchObject({ outcome: 'rewind', nextIndex: 0 });
  });

  it('blocks a read-only audit when its NEEDS_FIX policy is block', () => {
    context.database.run(`
      UPDATE workflows SET needs_fix_map = ? WHERE id = 'workflow-1'
    `, JSON.stringify({ verifier: 'block' }));
    const command = createFlow(context.service);
    context.service.claimCoordinator(command.commandId, command.flowId, 'run-audit', 'test-runner');
    context.service.queueStep(command.flowId, 'implementer');
    context.service.projectAgentResult(command.flowId, 'implementer', {
      status: 'DONE', attemptId: 'review',
    });
    context.service.queueStep(command.flowId, 'verifier');

    expect(context.service.projectAgentResult(command.flowId, 'verifier', {
      status: 'NEEDS_FIX', attemptId: 'audit',
    })).toMatchObject({ outcome: 'blocked', nextIndex: 1 });
    expect(context.service.getFlow(command.flowId)).toMatchObject({
      status: 'blocked',
      blockedReason: 'Quality gate verifier requires changes',
    });
    expect(context.service.getFlow(command.flowId).stepDetails[1]).toMatchObject({
      status: 'needs_fix', needsFixCount: 1,
    });
  });

  it('uses separate concurrency keys for isolated worktrees in the same workspace', () => {
    const first = context.service.createFlow({
      workflowId: 'workflow-1', workspaceId: 'workspace-1', prompt: 'first', useWorktree: true,
    }, 'worktree-first');
    const second = context.service.createFlow({
      workflowId: 'workflow-1', workspaceId: 'workspace-1', prompt: 'second', useWorktree: true,
    }, 'worktree-second');
    context.service.claimCoordinator(first.commandId, first.flowId, 'run-first', 'test-runner');
    context.service.claimCoordinator(second.commandId, second.flowId, 'run-second', 'test-runner');
    expect(context.service.queueStep(first.flowId, 'implementer').workspaceKey)
      .toBe(`worktree:${first.flowId}`);
    expect(context.service.queueStep(second.flowId, 'implementer').workspaceKey)
      .toBe(`worktree:${second.flowId}`);
  });

  it('keeps direct flows in the same workspace on one concurrency key', () => {
    const first = context.service.createFlow({
      workflowId: 'workflow-1', workspaceId: 'workspace-1', prompt: 'first', useWorktree: false,
    }, 'direct-first');
    const second = context.service.createFlow({
      workflowId: 'workflow-1', workspaceId: 'workspace-1', prompt: 'second', useWorktree: false,
    }, 'direct-second');
    context.service.claimCoordinator(first.commandId, first.flowId, 'run-first', 'test-runner');
    context.service.claimCoordinator(second.commandId, second.flowId, 'run-second', 'test-runner');
    expect(context.service.queueStep(first.flowId, 'implementer').workspaceKey).toBe('workspace:workspace-1');
    expect(context.service.queueStep(second.flowId, 'implementer').workspaceKey).toBe('workspace:workspace-1');
  });

  it('blocks after the fifth NEEDS_FIX result', () => {
    const command = createFlow(context.service);
    context.service.claimCoordinator(command.commandId, command.flowId, 'run-1', 'test-runner');
    for (let index = 0; index < 5; index += 1) {
      context.service.queueStep(command.flowId, 'verifier');
      context.service.projectAgentResult(command.flowId, 'verifier', {
        status: 'NEEDS_FIX', attemptId: `attempt-${index}`,
      });
    }
    expect(context.service.getFlow(command.flowId)).toMatchObject({ status: 'blocked' });
  });

  it('resumes a blocked flow in place and an expired flow as a new generation', () => {
    const command = createFlow(context.service);
    context.service.claimCoordinator(command.commandId, command.flowId, 'run-1', 'test-runner');
    context.service.queueStep(command.flowId, 'implementer');
    context.service.projectAgentResult(command.flowId, 'implementer', {
      status: 'BLOCKED', attemptId: 'blocked-attempt',
    });
    const resume = context.service.resumeFlow(command.flowId, 'resume-blocked');
    expect(context.service.claimResume(resume.commandId, command.flowId)).toBe(true);
    expect(context.service.getFlow(command.flowId)).toMatchObject({ status: 'running', generation: 1 });

    context.service.blockFlow(command.flowId, 'blocked again');
    context.service.expireBlockedFlow(command.flowId);
    expect(context.service.command(command.commandId).status).toBe('failed');
    const expiredResume = context.service.resumeFlow(command.flowId, 'resume-expired');
    expect(expiredResume.status).toBe('queued');
    expect(context.service.getFlow(command.flowId)).toMatchObject({ status: 'queued', generation: 2 });
  });

  it('terminalizes the command and publishes failure when an agent reports FAILED', () => {
    const command = createFlow(context.service);
    context.service.claimCoordinator(command.commandId, command.flowId, 'run-1', 'test-runner');
    context.service.queueStep(command.flowId, 'implementer');
    const result = context.service.projectAgentResult(command.flowId, 'implementer', {
      status: 'FAILED', attemptId: 'attempt-failed',
    }, command.commandId);
    expect(result.outcome).toBe('failed');
    expect(context.service.command(command.commandId).status).toBe('failed');
    expect(context.database.get<{ event_type: string }>(`
      SELECT event_type FROM event_outbox WHERE event_id = ?
    `, `${command.commandId}:failed`)?.event_type).toBe('devteam/flow.failed');
  });

  it('redacts local roots from persisted domain event payloads', () => {
    const command = createFlow(context.service);
    context.service.failFlow(
      command.flowId,
      `Cannot read ${context.config.codexHome}/sessions/private.json`,
      undefined,
      command.commandId,
    );
    const event = context.database.get<{ payload_json: string }>(`
      SELECT payload_json FROM domain_events WHERE event_type = 'flow.failed'
    `);
    expect(event?.payload_json).toContain('$CODEX_HOME/sessions/private.json');
    expect(event?.payload_json).not.toContain(context.config.codexHome);
  });

  it('makes stop idempotent and refuses active deletion', async () => {
    const command = createFlow(context.service);
    expect(() => context.service.deleteFlow(command.flowId)).toThrow(ConflictError);
    const stop = context.service.requestStop(command.flowId, 'stop-1');
    expect(context.service.stoppingCommands()).toEqual([{ flowId: command.flowId, commandId: stop.commandId }]);
    context.service.finishStop(command.flowId, stop.commandId);
    expect(context.service.stoppingCommands()).toEqual([]);
    expect(context.service.getFlow(command.flowId).status).toBe('stopped');
    expect(context.service.requestStop(command.flowId, 'stop-1')).toEqual(stop);
  });

  it('does not let a late runner overwrite a cancelled attempt', () => {
    const command = createFlow(context.service);
    context.service.claimCoordinator(command.commandId, command.flowId, 'run-1', 'test-runner');
    context.service.queueStep(command.flowId, 'implementer');
    context.service.createAttempt({
      id: 'attempt-race', flowId: command.flowId, step: 'implementer', cycle: 1,
      technicalAttempt: 0, inngestRunId: 'child-race', inngestAttempt: 0,
      sessionRunId: 'session-race', runnerId: 'test-runner',
    });
    context.service.markAttemptRunning('attempt-race', 999_999, 999_999);
    const stop = context.service.requestStop(command.flowId, 'stop-race');
    context.service.finishStop(command.flowId, stop.commandId);

    context.service.finishAttempt('attempt-race', 'failed', 143, {
      stage: 'process', message: 'late process close', retriable: true,
    });

    expect(context.service.attempt('attempt-race').status).toBe('cancelled');
    expect(context.service.getFlow(command.flowId).status).toBe('stopped');
  });

  it('creates a manual retry generation while preserving prior attempts', () => {
    const command = createFlow(context.service);
    context.service.claimCoordinator(command.commandId, command.flowId, 'run-1', 'test-runner');
    context.service.queueStep(command.flowId, 'implementer');
    context.service.createAttempt({
      id: 'attempt-old', flowId: command.flowId, step: 'implementer', cycle: 1,
      technicalAttempt: 0, inngestRunId: 'child-old', inngestAttempt: 0,
      sessionRunId: 'session-old', runnerId: 'test-runner',
    });
    context.service.failFlow(command.flowId, 'permanent failure', 'implementer', command.commandId);
    const retry = context.service.retryFlow(command.flowId, { step: 'implementer' }, 'manual-retry');
    expect(retry.status).toBe('queued');
    expect(context.service.getFlow(command.flowId)).toMatchObject({
      status: 'queued', generation: 2, currentStep: 'implementer',
    });
    expect(context.service.listAttempts(command.flowId).map((attempt) => attempt.id)).toEqual(['attempt-old']);
  });

  it('resumes the exact session attempt selected by a retry message', () => {
    const command = createFlow(context.service);
    context.service.claimCoordinator(command.commandId, command.flowId, 'run-1', 'test-runner');
    context.service.queueStep(command.flowId, 'implementer');
    for (const [id, runId, technicalAttempt] of [
      ['attempt-old', 'session-old', 0],
      ['attempt-new', 'session-new', 1],
    ] as const) {
      context.service.createAttempt({
        id,
        flowId: command.flowId,
        step: 'implementer',
        cycle: 1,
        technicalAttempt,
        inngestRunId: `child-${id}`,
        inngestAttempt: technicalAttempt,
        sessionRunId: runId,
        runnerId: 'test-runner',
      });
      context.service.markAttemptRunning(id, 0, 0);
      context.service.finishAttempt(id, 'completed', 0);
    }
    context.service.failFlow(command.flowId, 'finished for retry', 'implementer', command.commandId);

    const retry = context.service.retryFlow(command.flowId, {
      step: 'implementer',
      followUpMessage: 'Continue the older attempt',
      resumeThread: true,
      sessionRunId: 'session-old',
    });
    expect(context.service.latestRetryCommand(command.flowId)).toEqual({
      step: 'implementer',
      clearOutput: false,
      resumeThread: true,
      sessionRunId: 'session-old',
      followUpMessage: 'Continue the older attempt',
    });
    expect(context.service.getFlow(command.flowId).customPrompt).toBe('Implement the test task');
    context.service.claimCoordinator(retry.commandId, command.flowId, 'run-2', 'test-runner');
    const queued = context.service.queueStep(command.flowId, 'implementer');
    const resumed = context.service.resumeAttempt(
      command.flowId,
      'implementer',
      queued.cycle,
      'child-resume',
      0,
      'test-runner',
      'session-old',
    );

    expect(resumed).toMatchObject({ id: 'attempt-old', sessionRunId: 'session-old', status: 'running' });
    expect(context.service.attempt('attempt-new').status).toBe('completed');
  });

  it('rejects deleting a terminal dependency while a dependent flow exists', () => {
    const dependency = createFlow(context.service, 'dependency-start');
    const dependent = context.service.createFlow({
      workflowId: 'workflow-1', workspaceId: 'workspace-1', prompt: 'dependent',
      dependsOn: [dependency.flowId],
    }, 'dependent-start');
    expect(context.service.getFlow(dependent.flowId).dependencies).toEqual([dependency.flowId]);
    const stop = context.service.requestStop(dependency.flowId, 'dependency-stop');
    context.service.finishStop(dependency.flowId, stop.commandId);
    expect(() => context.service.deleteFlow(dependency.flowId)).toThrow(ConflictError);
  });
});

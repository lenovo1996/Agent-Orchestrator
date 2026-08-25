import fs from 'node:fs';
import { Inngest, NonRetriableError } from 'inngest';
import type { OrchestrationConfig } from './config.js';
import { PermanentAgentError } from './errors.js';
import type { OrchestrationService } from './service.js';
import type { AgentRunner } from './agent-runner.js';
import { parseOutputStatus } from './output-parser.js';
import type { WorktreeManager } from './worktree.js';

export interface FlowCommandEvent {
  commandId: string;
  flowId: string;
}

export interface AgentInvocationEvent {
  flowId: string;
  step: string;
  cycle: number;
  runnerId: string;
  workspaceKey: string;
}

export interface WorktreeFinalizationEvent {
  flowId: string;
  workspaceKey: string;
}

function commandData(event: { data?: unknown }): FlowCommandEvent {
  const data = event.data as Partial<FlowCommandEvent> | undefined;
  if (!data || typeof data.commandId !== 'string' || typeof data.flowId !== 'string') {
    throw new NonRetriableError('Invalid flow command event');
  }
  return { commandId: data.commandId, flowId: data.flowId };
}

function agentData(event: { data?: unknown }): AgentInvocationEvent {
  const data = event.data as Partial<AgentInvocationEvent> | undefined;
  if (!data || typeof data.flowId !== 'string' || typeof data.step !== 'string'
    || typeof data.cycle !== 'number' || typeof data.runnerId !== 'string'
    || typeof data.workspaceKey !== 'string') {
    throw new NonRetriableError('Invalid agent invocation event');
  }
  return data as AgentInvocationEvent;
}

function worktreeFinalizationData(event: { data?: unknown }): WorktreeFinalizationEvent {
  const data = event.data as Partial<WorktreeFinalizationEvent> | undefined;
  if (!data || typeof data.flowId !== 'string' || typeof data.workspaceKey !== 'string') {
    throw new NonRetriableError('Invalid worktree finalization event');
  }
  return data as WorktreeFinalizationEvent;
}

function expressionForFlow(flowId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(flowId)) throw new NonRetriableError('Invalid flow ID');
  return `async.data.flowId == "${flowId}"`;
}

function failureFlowId(event: { data?: unknown }): string | null {
  const data = event.data as Record<string, unknown> | undefined;
  const original = data?.event as { data?: { flowId?: unknown } } | undefined;
  return typeof original?.data?.flowId === 'string' ? original.data.flowId : null;
}

export function createInngestRuntime(dependencies: {
  service: OrchestrationService;
  runner: AgentRunner;
  worktrees: WorktreeManager;
  config: OrchestrationConfig;
}) {
  const { service, runner, worktrees, config } = dependencies;
  const client = new Inngest({
    id: 'devteam-agent-orchestrator',
    baseUrl: config.inngestBaseUrl,
    eventKey: process.env.INNGEST_EVENT_KEY,
  });

  const runAgentStep = client.createFunction(
    {
      id: 'run-agent-step',
      retries: 3,
      concurrency: [
        { scope: 'env', key: 'event.data.runnerId', limit: config.agentConcurrency },
        { scope: 'env', key: 'event.data.workspaceKey', limit: 1 },
      ],
      cancelOn: [{ event: 'devteam/flow.cancel-requested', match: 'data.flowId' }],
      timeouts: { finish: '8h' },
    },
    async ({ event, runId, attempt }) => {
      const data = agentData(event);
      try {
        return await runner.execute({
          flowId: data.flowId,
          step: data.step,
          cycle: data.cycle,
          inngestRunId: runId,
          inngestAttempt: attempt,
          runnerId: data.runnerId,
        });
      } catch (error) {
        if (error instanceof PermanentAgentError) throw new NonRetriableError(error.message, { cause: error });
        throw error;
      }
    },
  );

  const finalizeWorktree = client.createFunction(
    {
      id: 'finalize-worktree',
      retries: 3,
      concurrency: [{ scope: 'env', key: 'event.data.workspaceKey', limit: 1 }],
      cancelOn: [{ event: 'devteam/flow.cancel-requested', match: 'data.flowId' }],
      timeouts: { finish: '30m' },
    },
    async ({ event }) => {
      const data = worktreeFinalizationData(event);
      const result = await worktrees.finalize(data.flowId);
      return { success: result.success, conflictCount: result.conflicts.length };
    },
  );

  const coordinator = client.createFunction(
    {
      id: 'devteam-flow-coordinator',
      retries: 0,
      triggers: [
        { event: 'devteam/flow.requested' },
        { event: 'devteam/flow.retry-requested' },
        { event: 'devteam/flow.resume-requested' },
      ],
      cancelOn: [{ event: 'devteam/flow.cancel-requested', match: 'data.flowId' }],
      onFailure: async ({ event }) => {
        const flowId = failureFlowId(event);
        const failure = event.data as { event?: { data?: { commandId?: unknown } } } | undefined;
        const commandId = failure?.event?.data?.commandId;
        if (flowId) service.failFlow(
          flowId,
          'Coordinator failed permanently',
          undefined,
          typeof commandId === 'string' ? commandId : undefined,
        );
      },
    },
    async ({ event, step, runId }) => {
      const data = commandData(event);
      const claim = await step.run('claim-command', () => service.claimCoordinator(
        data.commandId, data.flowId, runId, config.runnerId,
      ));
      if (!claim.claimed) return { status: 'noop', reason: claim.reason };

      const definition = await step.run('load-definition', () => service.coordinatorDefinition(data.flowId));
      const dependencyStates = await step.run('load-dependencies', () => service.dependencyStates(data.flowId));
      const invalidDependency = dependencyStates.find((dependency) =>
        ['failed', 'stopped', 'expired'].includes(dependency.status));
      if (invalidDependency) {
        await step.run('project-dependency-failure', () => service.failFlow(
          data.flowId,
          `Dependency ${invalidDependency.flowId} is ${invalidDependency.status}`,
          undefined,
          data.commandId,
        ));
        return { status: 'failed', reason: 'dependency' };
      }
      const pendingDependencies = dependencyStates.filter((dependency) => dependency.status !== 'completed');
      if (pendingDependencies.length) {
        await step.run('mark-pending-dependencies', () => service.markPendingDependencies(data.flowId));
        await Promise.all(pendingDependencies.map(async (dependency) => Promise.race([
          step.waitForEvent(`dependency:${dependency.flowId}:completed`, {
            event: 'devteam/flow.completed',
            if: expressionForFlow(dependency.flowId),
            timeout: config.blockedTtl,
          }),
          step.waitForEvent(`dependency:${dependency.flowId}:failed`, {
            event: 'devteam/flow.failed',
            if: expressionForFlow(dependency.flowId),
            timeout: config.blockedTtl,
          }),
        ])));
        const refreshed = await step.run('reload-dependencies', () => service.dependencyStates(data.flowId));
        const failed = refreshed.find((dependency) => dependency.status !== 'completed');
        if (failed) {
          await step.run('project-dependency-terminal', () => service.failFlow(
            data.flowId,
            `Dependency ${failed.flowId} did not complete (${failed.status})`,
            undefined,
            data.commandId,
          ));
          return { status: 'failed', reason: 'dependency' };
        }
        await step.run('mark-coordinator-running', () => service.markCoordinatorRunning(data.flowId));
      }

      if (definition.useWorktree) {
        await step.run('prepare-worktree', async () => {
          const prepared = await worktrees.prepare(data.flowId);
          return { ready: prepared.ready, branch: prepared.branch };
        });
      }

      let checkpoints = await step.run('load-step-checkpoints', () => {
        const flow = service.getFlow(data.flowId);
        return Object.fromEntries(flow.stepDetails.map((detail) => [detail.step, {
          status: detail.status,
          cycle: detail.cycle,
        }]));
      });
      let index = 0;
      while (index < definition.steps.length) {
        const stepName = definition.steps[index];
        const checkpoint = checkpoints[stepName];
        if (!checkpoint) throw new NonRetriableError(`Missing step state: ${stepName}`);
        if (checkpoint.status === 'done') {
          index += 1;
          continue;
        }

        const queued = await step.run(`project:${stepName}:cycle:${checkpoint.cycle}:queue`, () =>
          service.queueStep(data.flowId, stepName));
        let result;
        try {
          result = await step.invoke(`agent:${stepName}:cycle:${queued.cycle}`, {
            function: runAgentStep,
            data: {
              flowId: data.flowId,
              step: stepName,
              cycle: queued.cycle,
              runnerId: config.runnerId,
              workspaceKey: queued.workspaceKey,
            },
            timeout: '8h',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await step.run(`project:${stepName}:cycle:${queued.cycle}:technical-failure`, () =>
            service.failFlow(data.flowId, message, stepName, data.commandId));
          return { status: 'failed', step: stepName };
        }

        const projection = await step.run(`project:${stepName}:cycle:${queued.cycle}:result`, () =>
          service.projectAgentResult(data.flowId, stepName, result, data.commandId));
        if (projection.outcome === 'failed') return { status: 'failed', step: stepName };
        if (projection.outcome === 'rewind') {
          checkpoints = await step.run(`reload-checkpoints:${stepName}:cycle:${queued.cycle}`, () => {
            const flow = service.getFlow(data.flowId);
            return Object.fromEntries(flow.stepDetails.map((detail) => [detail.step, {
              status: detail.status,
              cycle: detail.cycle,
            }]));
          });
          index = projection.nextIndex;
          continue;
        }
        if (projection.outcome === 'blocked') {
          const resumed = await step.waitForEvent(`resume:${stepName}:cycle:${queued.cycle}`, {
            event: 'devteam/flow.resume-requested',
            if: expressionForFlow(data.flowId),
            timeout: config.blockedTtl,
          });
          if (!resumed) {
            await step.run(`expire:${stepName}:cycle:${queued.cycle}`, () => service.expireBlockedFlow(data.flowId));
            return { status: 'expired', step: stepName };
          }
          const resumeData = commandData(resumed);
          const resumedClaim = await step.run(`claim-resume:${resumeData.commandId}`, () =>
            service.claimResume(resumeData.commandId, data.flowId));
          if (!resumedClaim) return { status: 'noop', reason: 'resume_not_claimed' };
          checkpoints = await step.run(`reload-resume-checkpoints:${resumeData.commandId}`, () => {
            const flow = service.getFlow(data.flowId);
            return Object.fromEntries(flow.stepDetails.map((detail) => [detail.step, {
              status: detail.status,
              cycle: detail.cycle,
            }]));
          });
          index = projection.nextIndex;
          continue;
        }
        checkpoints[stepName] = { status: 'done', cycle: queued.cycle };
        index = projection.nextIndex;
      }

      const validation = await step.run('validate-all-outputs', () => {
        const flow = service.getFlow(data.flowId);
        for (const detail of flow.stepDetails) {
          if (detail.status !== 'done' || !detail.outputPath) continue;
          const file = service.outputFile(data.flowId, detail.step);
          try {
            if (!fs.existsSync(file)) continue;
            if (parseOutputStatus(fs.readFileSync(file, 'utf8'), file) !== 'DONE') {
              return { valid: false, step: detail.step };
            }
          } catch {
            continue;
          }
        }
        return { valid: true, step: null };
      });
      if (!validation.valid) {
        await step.run('project-invalid-completion', () => service.failFlow(
          data.flowId, `Completion validation failed at ${validation.step}`, validation.step || undefined, data.commandId,
        ));
        return { status: 'failed', reason: 'invalid_completion' };
      }

      if (definition.useWorktree) {
        let finalizeCycle = 1;
        while (true) {
          const finalized = await step.invoke(`finalize-worktree:cycle:${finalizeCycle}`, {
            function: finalizeWorktree,
            data: {
              flowId: data.flowId,
              workspaceKey: `workspace:${definition.workspaceId}`,
            },
            timeout: '30m',
          });
          if (finalized.success) break;
          await step.run(`project-merge-conflict:cycle:${finalizeCycle}`, () => service.blockFlow(
            data.flowId, `Worktree merge has ${finalized.conflictCount} conflict(s)`,
          ));
          const resumed = await step.waitForEvent(`resume:worktree:cycle:${finalizeCycle}`, {
            event: 'devteam/flow.resume-requested',
            if: expressionForFlow(data.flowId),
            timeout: config.blockedTtl,
          });
          if (!resumed) {
            await step.run(`expire:worktree:cycle:${finalizeCycle}`, () => service.expireBlockedFlow(data.flowId));
            return { status: 'expired', reason: 'merge_conflict' };
          }
          const resumeData = commandData(resumed);
          const resumedClaim = await step.run(`claim-worktree-resume:${resumeData.commandId}`, () =>
            service.claimResume(resumeData.commandId, data.flowId, false));
          if (!resumedClaim) return { status: 'noop', reason: 'resume_not_claimed' };
          finalizeCycle += 1;
        }
      }

      await step.run('complete-flow', () => service.completeFlow(data.flowId, data.commandId));
      return { status: 'completed' };
    },
  );

  const cancelledCleanup = client.createFunction(
    {
      id: 'devteam-cancelled-cleanup',
      retries: 3,
      triggers: [{ event: 'inngest/function.cancelled' }],
    },
    async ({ event, step }) => {
      const runId = typeof event.data?.run_id === 'string' ? event.data.run_id : null;
      const flowId = runId ? service.flowIdForInngestRun(runId) : null;
      if (!flowId) return { cleaned: false };
      await step.run('terminate-process-group', () => runner.supervisor.terminateFlow(flowId));
      await step.run('finalize-stop-command', () => {
        const stopping = service.stoppingCommands().find((command) => command.flowId === flowId);
        if (stopping) service.finishStop(flowId, stopping.commandId);
      });
      return { cleaned: true };
    },
  );

  return {
    client,
    functions: [coordinator, runAgentStep, finalizeWorktree, cancelledCleanup],
    coordinator,
    runAgentStep,
    finalizeWorktree,
    cancelledCleanup,
  };
}

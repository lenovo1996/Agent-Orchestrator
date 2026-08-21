import fs from 'node:fs';
import path from 'node:path';
import { InngestTestEngine, mockCtx } from '@inngest/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from './agent-runner.js';
import { createInngestRuntime } from './inngest.js';
import { createFlow, createTestService } from './test-helpers.js';
import type { WorktreeManager } from './worktree.js';

let context: ReturnType<typeof createTestService>;
beforeEach(() => { context = createTestService(); });
afterEach(() => context.close());

function writeDone(flowId: string, step: string): void {
  const filename = context.service.outputFile(flowId, step);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, '## Status\nDONE\n\nTests: 4 passed, 0 failed\n');
}

describe('Inngest coordinator', () => {
  it('cancels an invoked agent step when its flow is stopped', () => {
    const { runAgentStep } = createInngestRuntime({
      service: context.service,
      runner: { supervisor: { terminateFlow: async () => undefined } } as unknown as AgentRunner,
      worktrees: {} as WorktreeManager,
      config: context.config,
    });

    expect(runAgentStep.opts.cancelOn).toEqual([
      { event: 'devteam/flow.cancel-requested', match: 'data.flowId' },
    ]);
  });

  it('maps the real cancellation run_id back to the flow before terminating it', async () => {
    const command = createFlow(context.service, 'cancelled-cleanup');
    context.service.claimCoordinator(
      command.commandId,
      command.flowId,
      'inngest-coordinator-run',
      'test-runner',
    );
    const terminateFlow = vi.fn(async () => undefined);
    const { cancelledCleanup } = createInngestRuntime({
      service: context.service,
      runner: { supervisor: { terminateFlow } } as unknown as AgentRunner,
      worktrees: {} as WorktreeManager,
      config: context.config,
    });
    const stop = context.service.requestStop(command.flowId, 'stop-after-cancellation');
    const engine = new InngestTestEngine({ function: cancelledCleanup });

    const { result } = await engine.execute({
      events: [{
        id: 'cancel-event',
        name: 'inngest/function.cancelled',
        data: {
          function_id: 'devteam-flow-coordinator',
          run_id: 'inngest-coordinator-run',
        },
        ts: Date.now(),
      }],
    });

    expect(result).toEqual({ cleaned: true });
    expect(terminateFlow).toHaveBeenCalledWith(command.flowId);
    expect(context.service.getFlow(command.flowId).status).toBe('stopped');
    expect(context.service.command(stop.commandId).status).toBe('completed');
  });

  it('runs a dynamic DONE sequence to completion with stable step IDs', async () => {
    const command = createFlow(context.service);
    const invoked: string[] = [];
    const fakeRunner = { supervisor: { terminateFlow: async () => undefined } } as unknown as AgentRunner;
    const fakeWorktrees = {} as WorktreeManager;
    const { coordinator } = createInngestRuntime({
      service: context.service,
      runner: fakeRunner,
      worktrees: fakeWorktrees,
      config: context.config,
    });
    const engine = new InngestTestEngine({ function: coordinator });
    const { result } = await engine.execute({
      events: [{
        id: command.commandId,
        name: 'devteam/flow.requested',
        data: { commandId: command.commandId, flowId: command.flowId },
        ts: Date.now(),
      }],
      steps: [
        {
          id: 'agent:implementer:cycle:1',
          handler: () => {
            invoked.push('agent:implementer:cycle:1');
            writeDone(command.flowId, 'implementer');
            return { status: 'DONE', attemptId: 'attempt-implementer' };
          },
        },
        {
          id: 'agent:verifier:cycle:1',
          handler: () => {
            invoked.push('agent:verifier:cycle:1');
            writeDone(command.flowId, 'verifier');
            return { status: 'DONE', attemptId: 'attempt-verifier' };
          },
        },
      ],
    });

    expect(result).toEqual({ status: 'completed' });
    expect(context.service.getFlow(command.flowId)).toMatchObject({
      status: 'completed', currentStep: null,
    });
    expect(invoked).toEqual(['agent:implementer:cycle:1', 'agent:verifier:cycle:1']);
  });

  it('rewinds NEEDS_FIX to a fresh cycle instead of replaying memoized steps', async () => {
    const command = createFlow(context.service);
    const invoked: string[] = [];
    const { coordinator } = createInngestRuntime({
      service: context.service,
      runner: { supervisor: { terminateFlow: async () => undefined } } as unknown as AgentRunner,
      worktrees: {} as WorktreeManager,
      config: context.config,
    });
    const engine = new InngestTestEngine({ function: coordinator });
    const { result } = await engine.execute({
      events: [{
        id: command.commandId,
        name: 'devteam/flow.requested',
        data: { commandId: command.commandId, flowId: command.flowId },
        ts: Date.now(),
      }],
      steps: [
        {
          id: 'agent:implementer:cycle:1',
          handler: () => {
            invoked.push('agent:implementer:cycle:1');
            writeDone(command.flowId, 'implementer');
            return { status: 'DONE', attemptId: 'implementer-1' };
          },
        },
        {
          id: 'agent:verifier:cycle:1',
          handler: () => {
            invoked.push('agent:verifier:cycle:1');
            return { status: 'NEEDS_FIX', attemptId: 'verifier-1' };
          },
        },
        {
          id: 'agent:implementer:cycle:2',
          handler: () => {
            invoked.push('agent:implementer:cycle:2');
            writeDone(command.flowId, 'implementer');
            return { status: 'DONE', attemptId: 'implementer-2' };
          },
        },
        {
          id: 'agent:verifier:cycle:2',
          handler: () => {
            invoked.push('agent:verifier:cycle:2');
            writeDone(command.flowId, 'verifier');
            return { status: 'DONE', attemptId: 'verifier-2' };
          },
        },
      ],
    });

    expect(result).toEqual({ status: 'completed' });
    expect(invoked).toEqual([
      'agent:implementer:cycle:1',
      'agent:verifier:cycle:1',
      'agent:implementer:cycle:2',
      'agent:verifier:cycle:2',
    ]);
    expect(context.service.getFlow(command.flowId).stepDetails).toEqual([
      expect.objectContaining({ step: 'implementer', status: 'done', cycle: 2 }),
      expect.objectContaining({ step: 'verifier', status: 'done', cycle: 2, needsFixCount: 1 }),
    ]);
  });

  it('resumes BLOCKED at the same step with a fresh cycle', async () => {
    const command = createFlow(context.service);
    const { coordinator } = createInngestRuntime({
      service: context.service,
      runner: { supervisor: { terminateFlow: async () => undefined } } as unknown as AgentRunner,
      worktrees: {} as WorktreeManager,
      config: context.config,
    });
    const engine = new InngestTestEngine({
      function: coordinator,
      transformCtx: (raw) => {
        const transformed = mockCtx(raw);
        transformed.step.waitForEvent = vi.fn(async () => {
          const resume = context.service.resumeFlow(command.flowId, 'resume-from-test');
          return {
            id: resume.commandId,
            name: 'devteam/flow.resume-requested',
            data: { commandId: resume.commandId, flowId: command.flowId },
            ts: Date.now(),
          };
        }) as typeof transformed.step.waitForEvent;
        return transformed;
      },
    });
    const { result } = await engine.execute({
      events: [{
        id: command.commandId,
        name: 'devteam/flow.requested',
        data: { commandId: command.commandId, flowId: command.flowId },
        ts: Date.now(),
      }],
      steps: [
        {
          id: 'agent:implementer:cycle:1',
          handler: () => ({ status: 'BLOCKED', attemptId: 'blocked-1' }),
        },
        {
          id: 'agent:implementer:cycle:2',
          handler: () => {
            writeDone(command.flowId, 'implementer');
            return { status: 'DONE', attemptId: 'implementer-2' };
          },
        },
        {
          id: 'agent:verifier:cycle:1',
          handler: () => {
            writeDone(command.flowId, 'verifier');
            return { status: 'DONE', attemptId: 'verifier-1' };
          },
        },
      ],
    });

    expect(result).toEqual({ status: 'completed' });
    expect(context.service.getFlow(command.flowId).stepDetails[0]).toMatchObject({
      step: 'implementer', status: 'done', cycle: 2,
    });
  });

  it('expires when a BLOCKED wait reaches its timeout', async () => {
    const command = createFlow(context.service);
    const { coordinator } = createInngestRuntime({
      service: context.service,
      runner: { supervisor: { terminateFlow: async () => undefined } } as unknown as AgentRunner,
      worktrees: {} as WorktreeManager,
      config: context.config,
    });
    const engine = new InngestTestEngine({
      function: coordinator,
      transformCtx: (raw) => {
        const transformed = mockCtx(raw);
        transformed.step.waitForEvent = vi.fn(async () => null) as typeof transformed.step.waitForEvent;
        return transformed;
      },
    });
    const { result } = await engine.execute({
      events: [{
        id: command.commandId,
        name: 'devteam/flow.requested',
        data: { commandId: command.commandId, flowId: command.flowId },
        ts: Date.now(),
      }],
      steps: [{
        id: 'agent:implementer:cycle:1',
        handler: () => ({ status: 'BLOCKED', attemptId: 'blocked-1' }),
      }],
    });

    expect(result).toEqual({ status: 'expired', step: 'implementer' });
    expect(context.service.getFlow(command.flowId).status).toBe('expired');
  });

  it('waits for multiple dependencies concurrently before running agents', async () => {
    const firstDependency = createFlow(context.service, 'dependency-1');
    const secondDependency = createFlow(context.service, 'dependency-2');
    const commands = new Map([
      [firstDependency.flowId, firstDependency.commandId],
      [secondDependency.flowId, secondDependency.commandId],
    ]);
    const command = context.service.createFlow({
      workflowId: 'workflow-1',
      workspaceId: 'workspace-1',
      prompt: 'dependent flow',
      dependsOn: [firstDependency.flowId, secondDependency.flowId],
    }, 'dependent-command');
    const waited: string[] = [];
    const { coordinator } = createInngestRuntime({
      service: context.service,
      runner: { supervisor: { terminateFlow: async () => undefined } } as unknown as AgentRunner,
      worktrees: {} as WorktreeManager,
      config: context.config,
    });
    const engine = new InngestTestEngine({
      function: coordinator,
      transformCtx: (raw) => {
        const transformed = mockCtx(raw);
        transformed.step.waitForEvent = vi.fn((id: string) => {
          waited.push(id);
          if (id.endsWith(':failed')) return new Promise(() => undefined);
          const dependencyId = id.slice('dependency:'.length, -':completed'.length);
          context.database.run(
            "UPDATE flow_steps SET status = 'done' WHERE flow_id = ?", dependencyId,
          );
          context.database.run(
            "UPDATE flows SET status = 'running' WHERE id = ?", dependencyId,
          );
          context.service.completeFlow(dependencyId, commands.get(dependencyId) as string);
          return Promise.resolve({
            name: 'devteam/flow.completed',
            data: { commandId: commands.get(dependencyId), flowId: dependencyId },
          });
        }) as typeof transformed.step.waitForEvent;
        return transformed;
      },
    });
    const { result } = await engine.execute({
      events: [{
        id: command.commandId,
        name: 'devteam/flow.requested',
        data: { commandId: command.commandId, flowId: command.flowId },
        ts: Date.now(),
      }],
      steps: [
        {
          id: 'agent:implementer:cycle:1',
          handler: () => {
            writeDone(command.flowId, 'implementer');
            return { status: 'DONE', attemptId: 'dependent-implementer' };
          },
        },
        {
          id: 'agent:verifier:cycle:1',
          handler: () => {
            writeDone(command.flowId, 'verifier');
            return { status: 'DONE', attemptId: 'dependent-verifier' };
          },
        },
      ],
    });

    expect(result).toEqual({ status: 'completed' });
    expect(waited).toEqual(expect.arrayContaining([
      `dependency:${firstDependency.flowId}:completed`,
      `dependency:${firstDependency.flowId}:failed`,
      `dependency:${secondDependency.flowId}:completed`,
      `dependency:${secondDependency.flowId}:failed`,
    ]));
    expect(context.service.dependencyStates(command.flowId).every((dependency) => dependency.status === 'completed')).toBe(true);
  });
});

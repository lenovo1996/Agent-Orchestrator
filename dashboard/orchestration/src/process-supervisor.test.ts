import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppServerClient } from './appserver-client.js';
import { ProcessSupervisor } from './process-supervisor.js';
import type { OrchestrationService } from './service.js';
import { createFlow, createTestService } from './test-helpers.js';

describe('ProcessSupervisor', () => {
  it('escalates to SIGKILL for a process group that ignores SIGTERM', async () => {
    const child = spawn('/usr/bin/bash', ['-c', "trap '' TERM; sleep 30 & wait"], {
      detached: true,
      stdio: 'ignore',
    });
    expect(child.pid).toBeTypeOf('number');
    const supervisor = new ProcessSupervisor({} as OrchestrationService);
    await supervisor.terminateGroup(child.pid as number, 100);
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('close', () => resolve());
    });
    expect(supervisor.isGroupAlive(child.pid as number)).toBe(false);
  });

  it('keeps an app-server turn registered when interruption fails so reconciliation can retry', async () => {
    const service = {
      runningAttempts: vi.fn(() => []),
      attemptTurn: vi.fn(() => null),
    } as unknown as OrchestrationService;
    const interruptTurn = vi.fn()
      .mockRejectedValueOnce(new Error('transport failed'))
      .mockResolvedValueOnce(undefined);
    const client = { connected: true, interruptTurn } as unknown as AppServerClient;
    const supervisor = new ProcessSupervisor(service);
    supervisor.setAppServerClient(client);
    supervisor.registerActiveThread('flow-1', 'implementer', 'attempt-1', 'thread-1', 'turn-1');

    await expect(supervisor.terminateFlow('flow-1')).rejects.toThrow('Failed to stop flow flow-1');
    await supervisor.terminateFlow('flow-1');

    expect(interruptTurn).toHaveBeenCalledTimes(2);
  });

  it('recovers a durable app-server turn when the stopping worker has no in-memory registration', async () => {
    const context = createTestService(['implementer']);
    try {
      const command = createFlow(context.service, 'durable-turn-stop');
      context.service.queueStep(command.flowId, 'implementer');
      const attempt = context.service.createAttempt({
        id: 'aaaaaaaa-1111-4222-8333-444444444444',
        flowId: command.flowId,
        step: 'implementer',
        cycle: 1,
        technicalAttempt: 0,
        inngestRunId: 'inngest-agent-run',
        inngestAttempt: 0,
        sessionRunId: 'bbbbbbbb-1111-4222-8333-444444444444',
        runnerId: 'original-worker',
      });
      context.service.markAttemptRunning(attempt.id, 0, 0);
      const sessionDirectory = path.join(
        context.service.artifactDirectory(command.flowId),
        'sessions',
        'implementer',
      );
      fs.mkdirSync(sessionDirectory, { recursive: true });
      fs.writeFileSync(path.join(sessionDirectory, `${attempt.sessionRunId}.json`), JSON.stringify({
        threadId: 'thread-durable',
        turnId: 'turn-durable',
      }));
      const interruptTurn = vi.fn(async () => undefined);
      const supervisor = new ProcessSupervisor(context.service);
      supervisor.setAppServerClient({ connected: true, interruptTurn } as unknown as AppServerClient);

      await supervisor.terminateFlow(command.flowId);

      expect(interruptTurn).toHaveBeenCalledWith('thread-durable', 'turn-durable');
    } finally {
      context.close();
    }
  });
});

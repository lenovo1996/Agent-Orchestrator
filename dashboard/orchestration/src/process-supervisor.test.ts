import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ProcessSupervisor } from './process-supervisor.js';
import type { OrchestrationService } from './service.js';

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
});

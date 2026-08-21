import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestrationRuntime } from './runtime.js';
import { createFlow, createTestService } from './test-helpers.js';

describe('OrchestrationRuntime stop ownership', () => {
  let context: ReturnType<typeof createTestService>;
  let serverRuntime: OrchestrationRuntime;
  let workerRuntime: OrchestrationRuntime;

  beforeEach(() => {
    context = createTestService(['implementer']);
    serverRuntime = new OrchestrationRuntime(context.config);
    workerRuntime = new OrchestrationRuntime(context.config);
  });

  afterEach(() => {
    workerRuntime.close();
    serverRuntime.close();
    context.close();
  });

  it('keeps the flow stopping until the worker runtime terminates it', async () => {
    const command = createFlow(context.service);
    const serverTerminate = vi.spyOn(serverRuntime.runner.supervisor, 'terminateFlow');
    const workerTerminate = vi.spyOn(workerRuntime.runner.supervisor, 'terminateFlow');

    const stop = await serverRuntime.stopFlow(command.flowId, 'stop-command');

    expect(stop.status).toBe('queued');
    expect(serverTerminate).not.toHaveBeenCalled();
    expect(context.service.getFlow(command.flowId).status).toBe('stopping');

    await workerRuntime.reconcileStoppingFlows();

    expect(workerTerminate).toHaveBeenCalledWith(command.flowId);
    expect(context.service.getFlow(command.flowId).status).toBe('stopped');
  });
});

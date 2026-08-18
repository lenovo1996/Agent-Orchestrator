import type { FlowCommandResponse } from '@devteam-dashboard/shared';
import { AgentRunner } from './agent-runner.js';
import { loadOrchestrationConfig, type OrchestrationConfig } from './config.js';
import { OrchestrationDatabase } from './database.js';
import { InngestDriver, OutboxDispatcher } from './driver.js';
import { createInngestRuntime } from './inngest.js';
import { OrchestrationService } from './service.js';
import { WorktreeManager } from './worktree.js';

export class OrchestrationRuntime {
  readonly database: OrchestrationDatabase;
  readonly service: OrchestrationService;
  readonly runner: AgentRunner;
  readonly worktrees: WorktreeManager;
  readonly inngest: ReturnType<typeof createInngestRuntime>;
  readonly driver: InngestDriver;
  readonly outbox: OutboxDispatcher;

  constructor(readonly config: OrchestrationConfig) {
    this.database = new OrchestrationDatabase(config.dbPath);
    this.service = new OrchestrationService(this.database, config);
    this.runner = new AgentRunner(this.service);
    this.worktrees = new WorktreeManager(this.service);
    this.inngest = createInngestRuntime({
      service: this.service,
      runner: this.runner,
      worktrees: this.worktrees,
      config,
    });
    this.driver = new InngestDriver(this.inngest.client);
    this.outbox = new OutboxDispatcher(this.service, this.driver);
  }

  async stopFlow(flowId: string, idempotencyKey?: string): Promise<FlowCommandResponse> {
    const command = this.service.requestStop(flowId, idempotencyKey);
    await this.runner.supervisor.terminateFlow(flowId);
    this.service.finishStop(flowId, command.commandId);
    return command;
  }

  async reconcileStoppingFlows(): Promise<void> {
    for (const command of this.service.stoppingCommands()) {
      await this.runner.supervisor.terminateFlow(command.flowId);
      this.service.finishStop(command.flowId, command.commandId);
    }
  }

  close(): void {
    this.outbox.stop();
    this.database.close();
  }
}

export function createOrchestrationRuntime(
  overrides: Partial<OrchestrationConfig> & { repoRoot?: string } = {},
): OrchestrationRuntime {
  return new OrchestrationRuntime(loadOrchestrationConfig(overrides));
}

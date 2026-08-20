import path from 'node:path';
import {
  OrchestrationDatabase,
  OrchestrationService,
  type OrchestrationConfig,
} from '@devteam-dashboard/orchestration';

export function createTestOrchestration(
  root: string,
  taskFlowsDir: string,
  flows: Array<{ flowId: string; workspaceId: string; workspaceName?: string }>,
) {
  const config: OrchestrationConfig = {
    repoRoot: root,
    dbPath: path.join(root, 'workflows.db'),
    taskFlowsDir,
    codexHome: path.join(root, '.codex'),
    runnerId: 'server-test',
    agentConcurrency: 3,
    agentTimeoutMs: 2_000,
    blockedTtl: '30d',
    blockedTtlMs: 30 * 86_400_000,
    inngestBaseUrl: 'http://127.0.0.1:8288',
    inngestGatewayUrl: 'ws://127.0.0.1:8289/v0/connect',
    workerHealthUrl: 'http://127.0.0.1:3011',
  };
  const database = new OrchestrationDatabase(config.dbPath);
  database.run(`
    INSERT INTO agents(id, role, objective, model, thinking, tools, outputs, runtime, instructions)
    VALUES ('implementer', 'Implementer', 'Implement', NULL, NULL, '[]', '["output/implementation.md"]', 'generic', 'Implement')
  `);
  database.run(`
    INSERT INTO workflows(id, name, description, steps)
    VALUES ('workflow-1', 'Workflow', 'test', '["implementer"]')
  `);
  const timestamp = new Date().toISOString();
  for (const flow of flows) {
    if (!database.get('SELECT id FROM workspaces WHERE id = ?', flow.workspaceId)) {
      database.run(
        'INSERT INTO workspaces(id, name, path) VALUES (?, ?, ?)',
        flow.workspaceId, flow.workspaceName || flow.workspaceId, path.join(root, flow.workspaceId),
      );
    }
    database.run(`
      INSERT INTO flows(
        id, workspace_id, workflow_id, step_order_json, status, current_step,
        generation, revision, use_worktree, created_at, updated_at
      ) VALUES (?, ?, 'workflow-1', '["implementer"]', 'running', 'implementer', 1, 0, 0, ?, ?)
    `, flow.flowId, flow.workspaceId, timestamp, timestamp);
    database.run(`
      INSERT INTO flow_steps(
        flow_id, step, position, status, cycle, technical_retry_count,
        needs_fix_count, output_path, updated_at
      ) VALUES (?, 'implementer', 0, 'running', 1, 0, 0, 'output/implementation.md', ?)
    `, flow.flowId, timestamp);
  }
  return { database, service: new OrchestrationService(database, config), config };
}

export function insertTestAttempt(
  database: OrchestrationDatabase,
  input: {
    attemptId: string;
    flowId: string;
    runId: string;
    startedAt: string;
    status?: 'running' | 'completed';
    ordinal?: number;
  },
): void {
  const status = input.status || 'completed';
  const ordinal = input.ordinal || 0;
  database.run(`
    INSERT INTO step_attempts(
      id, flow_id, step, cycle, technical_attempt, inngest_run_id, inngest_attempt,
      session_run_id, runner_id, exit_code, status, created_at, started_at, finished_at, updated_at
    ) VALUES (?, ?, 'implementer', 1, ?, ?, ?, ?, 'server-test', ?, ?, ?, ?, ?, ?)
  `,
  input.attemptId, input.flowId, ordinal, `inngest-${input.attemptId}`, ordinal,
  input.runId, status === 'completed' ? 0 : null, status,
  input.startedAt, input.startedAt, status === 'completed' ? '2026-08-17T00:01:00.000Z' : null,
  input.startedAt);
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OrchestrationConfig } from './config.js';
import { OrchestrationDatabase } from './database.js';
import { OrchestrationService } from './service.js';

export function createTestService(steps = ['implementer', 'verifier']): {
  root: string;
  database: OrchestrationDatabase;
  service: OrchestrationService;
  config: OrchestrationConfig;
  close: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-orchestration-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const config: OrchestrationConfig = {
    repoRoot: root,
    dbPath: path.join(root, 'workflows.db'),
    taskFlowsDir: path.join(root, 'task-flows'),
    codexHome: path.join(root, 'codex-home'),
    runnerId: 'test-runner',
    agentConcurrency: 3,
    agentTimeoutMs: 2_000,
    blockedTtl: '30d',
    blockedTtlMs: 30 * 86_400_000,
    inngestBaseUrl: 'http://127.0.0.1:8288',
    inngestGatewayUrl: 'ws://127.0.0.1:8289/v0/connect',
    workerHeartbeatMs: 50,
    workerStaleMs: 150,
  };
  const database = new OrchestrationDatabase(config.dbPath);
  database.run(
    'INSERT INTO workspaces(id, name, path) VALUES (?, ?, ?)',
    'workspace-1', 'Workspace 1', workspace,
  );
  for (const step of steps) {
    database.run(`
      INSERT INTO agents(id, role, objective, model, thinking, tools, outputs, runtime, instructions)
      VALUES (?, ?, ?, NULL, NULL, '[]', ?, 'generic', ?)
    `, step, step, `Run ${step}`, JSON.stringify([`output/${step}.md`]), `Do ${step}`);
  }
  database.run(
    'INSERT INTO workflows(id, name, description, steps) VALUES (?, ?, ?, ?)',
    'workflow-1', 'Workflow 1', 'test', JSON.stringify(steps),
  );
  const service = new OrchestrationService(database, config);
  return {
    root,
    database,
    service,
    config,
    close: () => {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function createFlow(service: OrchestrationService, key = crypto.randomUUID()) {
  return service.createFlow({
    workflowId: 'workflow-1',
    workspaceId: 'workspace-1',
    prompt: 'Implement the test task',
  }, key);
}

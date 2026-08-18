import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OrchestrationDatabase } from '@devteam-dashboard/orchestration';

describe('durable flow MCP tools', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(directory, '..');
  let root;
  let dbPath;
  let client;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-mcp-'));
    dbPath = path.join(root, 'workflows.db');
    const database = new OrchestrationDatabase(dbPath);
    database.run(
      'INSERT INTO workspaces(id, name, path) VALUES (?, ?, ?)',
      'workspace-1', 'Workspace', path.join(root, 'workspace'),
    );
    database.run(`
      INSERT INTO agents(id, role, objective, model, thinking, tools, outputs, runtime, instructions)
      VALUES ('implementer', 'Implementer', 'Implement', NULL, NULL, '[]', '["output/implementation.md"]', 'generic', 'Implement')
    `);
    database.run(`
      INSERT INTO workflows(id, name, description, steps)
      VALUES ('workflow-1', 'Workflow', 'test', '["implementer"]')
    `);
    database.close();

    client = new Client({ name: 'devteam-mcp-test', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packageRoot, 'dist', 'index.js')],
      cwd: packageRoot,
      stderr: 'pipe',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
        DEVTEAM_DB_PATH: dbPath,
        DEVTEAM_REPO_ROOT: root,
      },
    });
    await client.connect(transport);
  });

  after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('publishes only validated flow command tools', async () => {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      'start_flow',
      'list_flows',
      'get_flow',
      'retry_flow_step',
      'resume_flow',
      'stop_flow',
      'delete_flow',
    ]);
  });

  test('start_flow writes a durable command and ID-only outbox event', async () => {
    const result = await client.callTool({
      name: 'start_flow',
      arguments: {
        workflowId: 'workflow-1',
        workspaceId: 'workspace-1',
        prompt: 'sensitive prompt must remain in SQLite',
        idempotencyKey: 'mcp-start-1',
      },
    });
    assert.equal(result.isError, undefined);
    const response = JSON.parse(result.content[0].text);
    assert.equal(response.status, 'queued');

    const database = new OrchestrationDatabase(dbPath);
    const command = database.get('SELECT * FROM flow_commands WHERE id = ?', response.commandId);
    const flow = database.get('SELECT custom_prompt FROM flows WHERE id = ?', response.flowId);
    const outbox = database.get('SELECT event_id, event_type, payload_json FROM event_outbox WHERE command_id = ?', response.commandId);
    assert.equal(command.type, 'start');
    assert.equal(flow.custom_prompt, 'sensitive prompt must remain in SQLite');
    assert.equal(outbox.event_id, response.commandId);
    assert.equal(outbox.event_type, 'devteam/flow.requested');
    assert.deepEqual(JSON.parse(outbox.payload_json), {
      commandId: response.commandId,
      flowId: response.flowId,
    });
    assert.equal(outbox.payload_json.includes('sensitive prompt'), false);
    database.close();
  });
});

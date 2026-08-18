'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { after, before, describe, test } = require('node:test');

describe('SQLite flow-state compatibility utilities', () => {
  let root;
  let previousDb;
  let previousOutput;
  let state;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-flow-state-'));
    const dbPath = path.join(root, 'workflows.db');
    const outputRoot = path.join(root, 'artifacts');
    const database = new DatabaseSync(dbPath);
    database.exec(`
      CREATE TABLE flows (
        id TEXT PRIMARY KEY, workspace_id TEXT, workflow_id TEXT, jira_key TEXT,
        custom_prompt TEXT, step_order_json TEXT, status TEXT, current_step TEXT,
        generation INTEGER, revision INTEGER
      );
      CREATE TABLE flow_steps (
        flow_id TEXT, step TEXT, position INTEGER, status TEXT, cycle INTEGER,
        technical_retry_count INTEGER, needs_fix_count INTEGER, output_path TEXT
      );
      CREATE TABLE agents (id TEXT PRIMARY KEY, role TEXT, objective TEXT, outputs TEXT);
      INSERT INTO agents VALUES ('implementer', 'Implementer', 'Implement', '["output/result.md"]');
      INSERT INTO flows VALUES (
        'flow-test', 'workspace-test', 'workflow-test', 'TASK-1', 'Prompt',
        '["implementer"]', 'running', 'implementer', 2, 7
      );
      INSERT INTO flow_steps VALUES (
        'flow-test', 'implementer', 0, 'running', 3, 1, 0, 'output/result.md'
      );
    `);
    database.close();
    previousDb = process.env.DEVTEAM_DB_PATH;
    previousOutput = process.env.DEVTEAM_TASK_FLOWS_DIR;
    process.env.DEVTEAM_DB_PATH = dbPath;
    process.env.DEVTEAM_TASK_FLOWS_DIR = outputRoot;
    const modulePath = require.resolve('../../utils/flow-state');
    delete require.cache[modulePath];
    state = require(modulePath);
  });

  after(() => {
    if (previousDb === undefined) delete process.env.DEVTEAM_DB_PATH;
    else process.env.DEVTEAM_DB_PATH = previousDb;
    if (previousOutput === undefined) delete process.env.DEVTEAM_TASK_FLOWS_DIR;
    else process.env.DEVTEAM_TASK_FLOWS_DIR = previousOutput;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('loads checkpoint and step state only from SQLite', () => {
    assert.deepEqual(state.loadWorkflow('flow-test'), {
      flowId: 'flow-test',
      workspaceId: 'workspace-test',
      workflowId: 'workflow-test',
      jiraKey: 'TASK-1',
      customPrompt: 'Prompt',
      steps: ['implementer'],
      stepStates: {
        implementer: {
          status: 'running', cycle: 3, technicalRetryCount: 1,
          needsFixCount: 0, outputPath: 'output/result.md',
        },
      },
      agents: {
        implementer: {
          role: 'Implementer', objective: 'Implement', outputs: ['output/result.md'],
        },
      },
      status: 'running',
      currentStep: 'implementer',
      generation: 2,
      revision: 7,
    });
  });

  test('resolves artifacts through DEVTEAM_TASK_FLOWS_DIR without workflow.json', () => {
    assert.equal(
      state.resolveWorkDir('flow-test'),
      path.join(root, 'artifacts', 'workspace-test', 'flow-test'),
    );
    assert.equal(fs.existsSync(path.join(root, 'artifacts', 'workspace-test', 'flow-test', 'workflow.json')), false);
  });
});

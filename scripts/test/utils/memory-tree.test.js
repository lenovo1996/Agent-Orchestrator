'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

test('memory tree parses current agent output and generates context for renamed steps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-memory-tree-'));
  try {
    const dbPath = path.join(root, 'workflows.db');
    const outputRoot = path.join(root, 'artifacts');
    const memoryRoot = path.join(root, 'memory');
    const flowId = 'flow-current-agents';
    const taskId = 'TASK-42';
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
      INSERT INTO agents VALUES (
        'requirements_analyst', 'Requirements Analyst', 'Clarify requirements',
        '["output/requirements.md"]'
      );
      INSERT INTO agents VALUES (
        'solution_architect', 'Solution Architect', 'Design the solution',
        '["output/architecture.md"]'
      );
      INSERT INTO flows VALUES (
        '${flowId}', 'workspace-1', 'workflow-1', '${taskId}', 'Add a safe feature',
        '["requirements_analyst","solution_architect"]', 'running',
        'solution_architect', 1, 0
      );
      INSERT INTO flow_steps VALUES (
        '${flowId}', 'requirements_analyst', 0, 'done', 1, 0, 0,
        'output/requirements.md'
      );
      INSERT INTO flow_steps VALUES (
        '${flowId}', 'solution_architect', 1, 'running', 1, 0, 0,
        'output/architecture.md'
      );
    `);
    database.close();

    const workDir = path.join(outputRoot, 'workspace-1', flowId);
    fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'output', 'requirements.md'), `## Status
**DONE**

## Summary

Users need a tenant-safe export.

## Requirements

### Facts

- Company scope is mandatory.

### Decisions

- D1. Reuse the existing authorization boundary.

## Acceptance Criteria

- Cross-company export is rejected.
`);

    const script = path.resolve(__dirname, '../../utils/memory-tree.js');
    const env = {
      ...process.env,
      DEVTEAM_DB_PATH: dbPath,
      DEVTEAM_TASK_FLOWS_DIR: outputRoot,
      DEVTEAM_TASK_MEMORY_DIR: memoryRoot,
    };
    for (const args of [
      ['init', flowId],
      ['update', flowId, 'requirements_analyst'],
      ['generate', flowId, 'solution_architect'],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    const tree = JSON.parse(fs.readFileSync(
      path.join(memoryRoot, taskId, 'flows', flowId, 'tree.json'),
      'utf8',
    ));
    assert.equal(tree.nodes.requirements_analyst.status, 'DONE');
    assert.match(tree.nodes.requirements_analyst.summary, /tenant-safe export/);
    assert.ok(tree.nodes.requirements_analyst.key_facts.includes('Company scope is mandatory.'));
    assert.ok(tree.nodes.requirements_analyst.key_facts.includes('Cross-company export is rejected.'));
    assert.deepEqual(tree.nodes.requirements_analyst.decisions, [
      { what: 'D1. Reuse the existing authorization boundary.' },
    ]);

    const activeContext = fs.readFileSync(
      path.join(memoryRoot, taskId, 'active-context.md'),
      'utf8',
    );
    assert.match(activeContext, /### Requirements Analyst/);
    assert.match(activeContext, /Users need a tenant-safe export/);
    assert.match(activeContext, /Company scope is mandatory/);
    assert.match(activeContext, /D1\. Reuse the existing authorization boundary/);
    assert.match(activeContext, /## Current Step: solution_architect/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

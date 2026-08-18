#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEVTEAM_ROOT = path.resolve(__dirname, '..', '..');
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(DEVTEAM_ROOT, 'team.json'), 'utf8'));
const DB_PATH = path.resolve(process.env.DEVTEAM_DB_PATH || path.join(DEVTEAM_ROOT, 'workflows.db'));
const OUTPUT_ROOT = path.resolve(
  process.env.DEVTEAM_TASK_FLOWS_DIR || path.join(DEVTEAM_ROOT, TEAM_CONFIG.outputRoot || 'task-flows')
);

function withDatabase(operation) {
  if (!fs.existsSync(DB_PATH)) throw new Error(`Orchestration database not found: ${DB_PATH}`);
  const database = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    return operation(database);
  } finally {
    database.close();
  }
}

function loadWorkflow(flowId) {
  return withDatabase((database) => {
    const flow = database.prepare(`
      SELECT id, workspace_id, workflow_id, jira_key, custom_prompt,
             step_order_json, status, current_step, generation, revision
      FROM flows WHERE id = ?
    `).get(flowId);
    if (!flow) throw new Error(`Flow not found: ${flowId}`);
    const stepRows = database.prepare(`
      SELECT step, status, cycle, technical_retry_count, needs_fix_count, output_path
      FROM flow_steps WHERE flow_id = ? ORDER BY position
    `).all(flowId);
    const agentRows = database.prepare(`
      SELECT agents.id, agents.role, agents.objective, agents.outputs
      FROM agents
      JOIN flow_steps ON flow_steps.step = agents.id
      WHERE flow_steps.flow_id = ?
    `).all(flowId);
    return {
      flowId: flow.id,
      workspaceId: flow.workspace_id,
      workflowId: flow.workflow_id,
      jiraKey: flow.jira_key,
      customPrompt: flow.custom_prompt,
      steps: JSON.parse(flow.step_order_json),
      stepStates: Object.fromEntries(stepRows.map((row) => [row.step, {
        status: row.status,
        cycle: row.cycle,
        technicalRetryCount: row.technical_retry_count,
        needsFixCount: row.needs_fix_count,
        outputPath: row.output_path,
      }])),
      agents: Object.fromEntries(agentRows.map((row) => [row.id, {
        role: row.role,
        objective: row.objective,
        outputs: JSON.parse(row.outputs),
      }])),
      status: flow.status,
      currentStep: flow.current_step,
      generation: flow.generation,
      revision: flow.revision,
    };
  });
}

function getSteps(workflow) {
  return Array.isArray(workflow.steps) ? workflow.steps : [];
}

function resolveWorkDir(flowId) {
  const workflow = loadWorkflow(flowId);
  return path.join(OUTPUT_ROOT, workflow.workspaceId, workflow.flowId);
}

function listFlowIds() {
  return withDatabase((database) => database.prepare(
    'SELECT id FROM flows ORDER BY created_at, id',
  ).all().map((row) => row.id));
}

module.exports = { DB_PATH, OUTPUT_ROOT, getSteps, listFlowIds, loadWorkflow, resolveWorkDir };

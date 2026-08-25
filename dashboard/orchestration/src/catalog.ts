import fs from 'node:fs';
import path from 'node:path';
import type { AgentConfig, CustomWorkflow } from '@devteam-dashboard/shared';
import { OrchestrationDatabase } from './database.js';

interface TeamFile {
  members: Record<string, Omit<AgentConfig, 'id' | 'instructions' | 'tools'> & { tools?: string[] }>;
}

interface WorkflowCatalogFile {
  workflows: CustomWorkflow[];
}

export interface TeamCatalog {
  agents: AgentConfig[];
  workflows: CustomWorkflow[];
}

export interface CatalogResetResult {
  agents: number;
  workflows: number;
  workspacesPreserved: number;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function readJson<T>(filename: string): T {
  return JSON.parse(fs.readFileSync(filename, 'utf8')) as T;
}

export function loadTeamCatalog(repoRoot: string): TeamCatalog {
  const team = readJson<TeamFile>(path.join(repoRoot, 'team.json'));
  const workflowCatalog = readJson<WorkflowCatalogFile>(path.join(repoRoot, 'workflow-catalog.json'));
  const agents = Object.entries(team.members).map(([id, config]): AgentConfig => ({
    id,
    ...config,
    tools: config.tools || [],
    instructions: fs.readFileSync(path.join(repoRoot, 'prompts', `${id}.md`), 'utf8').trim(),
  }));
  const agentIds = new Set(agents.map((agent) => agent.id));

  for (const agent of agents) {
    if (!SAFE_ID.test(agent.id)) throw new Error(`Invalid agent ID: ${agent.id}`);
    if (!agent.role || !agent.objective || !agent.instructions || !agent.outputs.length) {
      throw new Error(`Incomplete agent configuration: ${agent.id}`);
    }
    if (!agent.outputs[0].startsWith('output/') || path.isAbsolute(agent.outputs[0])) {
      throw new Error(`Unsafe output path for agent ${agent.id}`);
    }
  }

  const workflowIds = new Set<string>();
  for (const workflow of workflowCatalog.workflows) {
    if (!SAFE_ID.test(workflow.id) || workflowIds.has(workflow.id)) {
      throw new Error(`Invalid or duplicate workflow ID: ${workflow.id}`);
    }
    workflowIds.add(workflow.id);
    if (!workflow.name || !workflow.description || !workflow.context || workflow.version < 1) {
      throw new Error(`Incomplete workflow configuration: ${workflow.id}`);
    }
    if (!workflow.steps.length || new Set(workflow.steps).size !== workflow.steps.length) {
      throw new Error(`Workflow ${workflow.id} must have unique steps`);
    }
    for (const step of workflow.steps) {
      if (!agentIds.has(step)) throw new Error(`Workflow ${workflow.id} references unknown agent ${step}`);
    }
    for (const [gate, target] of Object.entries(workflow.needsFix)) {
      const gateIndex = workflow.steps.indexOf(gate);
      if (gateIndex < 0) throw new Error(`Workflow ${workflow.id} has an unknown NEEDS_FIX gate ${gate}`);
      if (target !== 'block') {
        const targetIndex = workflow.steps.indexOf(target);
        if (targetIndex < 0 || targetIndex >= gateIndex) {
          throw new Error(`Workflow ${workflow.id} has an invalid NEEDS_FIX target for ${gate}`);
        }
      }
    }
  }

  return { agents, workflows: workflowCatalog.workflows };
}

export function resetTeamCatalog(
  database: OrchestrationDatabase,
  catalog: TeamCatalog,
  options: { preserveWorkspaces?: boolean } = {},
): CatalogResetResult {
  const preserveWorkspaces = options.preserveWorkspaces ?? true;
  database.transaction(() => {
    database.run('DELETE FROM flow_dependencies');
    database.run('DELETE FROM step_attempts');
    database.run('DELETE FROM orchestration_runs');
    database.run('DELETE FROM flow_steps');
    database.run('DELETE FROM flows');
    database.run('DELETE FROM flow_commands');
    database.run('DELETE FROM event_outbox');
    database.run('DELETE FROM domain_events');
    database.run('DELETE FROM orchestrator_workers');
    database.run("DELETE FROM sqlite_sequence WHERE name = 'domain_events'");
    database.run('DELETE FROM workflows');
    database.run('DELETE FROM agents');
    if (!preserveWorkspaces) database.run('DELETE FROM workspaces');

    for (const agent of catalog.agents) {
      database.run(`
        INSERT INTO agents(
          id, role, objective, model, thinking, tools, outputs, runtime, runtime_command, instructions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      agent.id, agent.role, agent.objective, agent.model || null, agent.thinking || null,
      JSON.stringify(agent.tools), JSON.stringify(agent.outputs), agent.runtime || 'appserver',
      agent.runtimeCommand || null, agent.instructions);
    }

    for (const workflow of catalog.workflows) {
      database.run(`
        INSERT INTO workflows(id, name, description, steps, context, needs_fix_map, version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      workflow.id, workflow.name, workflow.description, JSON.stringify(workflow.steps),
      workflow.context, JSON.stringify(workflow.needsFix), workflow.version);
    }
  });

  return {
    agents: catalog.agents.length,
    workflows: catalog.workflows.length,
    workspacesPreserved: Number(database.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM workspaces',
    )?.count || 0),
  };
}

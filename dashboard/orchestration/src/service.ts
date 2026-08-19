import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CreateFlowRequest,
  FlowCommandResponse,
  FlowStatus,
  FlowSummary,
  FlowStepState,
  RetryFlowRequest,
  StepStatus,
  WorkflowState,
} from '@devteam-dashboard/shared';
import type { OrchestrationConfig } from './config.js';
import { ConflictError, DomainError, NotFoundError } from './errors.js';
import { OrchestrationDatabase, type DatabaseRow } from './database.js';
import type {
  AgentRecord,
  AgentStepResult,
  CoordinatorDefinition,
  FlowCommandRecord,
  FlowCommandType,
  FlowRecord,
  ProjectionResult,
  StepAttemptRecord,
} from './types.js';

interface FlowRow extends DatabaseRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_path: string;
  workflow_id: string;
  jira_key: string | null;
  custom_prompt: string | null;
  step_order_json: string;
  status: FlowStatus;
  current_step: string | null;
  generation: number;
  revision: number;
  use_worktree: number;
  worktree_path: string | null;
  worktree_branch: string | null;
  blocked_summary: string | null;
  error_summary: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface StepRow extends DatabaseRow {
  flow_id: string;
  step: string;
  position: number;
  status: StepStatus;
  cycle: number;
  technical_retry_count: number;
  needs_fix_count: number;
  output_path: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

const TERMINAL: readonly FlowStatus[] = ['completed', 'failed', 'stopped', 'expired'];
const ACTIVE_STEP_STATUSES: readonly StepStatus[] = ['queued', 'running', 'retrying'];

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function commandEvent(type: FlowCommandType): string | null {
  const events: Record<FlowCommandType, string | null> = {
    start: 'devteam/flow.requested',
    retry: 'devteam/flow.retry-requested',
    resume: 'devteam/flow.resume-requested',
    stop: 'devteam/flow.cancel-requested',
    delete: null,
  };
  return events[type];
}

function assertSafeRelative(value: string, label: string): string {
  const normalized = path.normalize(value);
  if (!value || path.isAbsolute(value) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new DomainError(`Invalid ${label}`, 'invalid_path', 400);
  }
  return normalized;
}

function newFlowId(): string {
  const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `flow_${timestamp}_${crypto.randomBytes(4).toString('hex')}`;
}

function stepFromRow(row: StepRow): FlowStepState {
  return {
    step: row.step,
    position: Number(row.position),
    status: row.status,
    cycle: Number(row.cycle),
    technicalRetryCount: Number(row.technical_retry_count),
    needsFixCount: Number(row.needs_fix_count),
    outputPath: row.output_path,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

export class OrchestrationService {
  constructor(
    readonly database: OrchestrationDatabase,
    readonly config: OrchestrationConfig,
  ) {}

  private existingCommand(
    idempotencyKey: string | undefined,
    expectedType: FlowCommandType,
    expectedFlowId?: string,
  ): FlowCommandResponse | null {
    if (!idempotencyKey) return null;
    const existing = this.database.get<{ id: string; flow_id: string; type: FlowCommandType }>(
      'SELECT id, flow_id, type FROM flow_commands WHERE idempotency_key = ?', idempotencyKey,
    );
    if (!existing) return null;
    if (existing.type !== expectedType || (expectedFlowId && existing.flow_id !== expectedFlowId)) {
      throw new ConflictError('Idempotency key was already used for another command');
    }
    return { flowId: existing.flow_id, commandId: existing.id, status: 'queued' };
  }

  private flowRow(flowId: string): FlowRow {
    const row = this.database.get<FlowRow>(`
      SELECT f.*, w.name AS workspace_name, w.path AS workspace_path
      FROM flows f
      JOIN workspaces w ON w.id = f.workspace_id
      WHERE f.id = ?
    `, flowId);
    if (!row) throw new NotFoundError('Flow', flowId);
    return row;
  }

  private flowFromRow(row: FlowRow): FlowRecord {
    const stepRows = this.database.all<StepRow>(
      'SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY position', row.id,
    );
    const stepDetails = stepRows.map(stepFromRow);
    const steps = Object.fromEntries(stepDetails.map((step) => [step.step, step.status]));
    const dependencies = this.database.all<{ dependency_flow_id: string }>(
      'SELECT dependency_flow_id FROM flow_dependencies WHERE flow_id = ? ORDER BY dependency_flow_id', row.id,
    ).map((dependency) => dependency.dependency_flow_id);
    return {
      flowId: row.id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      workspacePath: row.workspace_path,
      workflowId: row.workflow_id,
      jiraKey: row.jira_key,
      customPrompt: row.custom_prompt || undefined,
      stepOrder: parseJson<string[]>(row.step_order_json, []),
      status: row.status,
      currentStep: row.current_step,
      generation: Number(row.generation),
      revision: Number(row.revision),
      useWorktree: Boolean(row.use_worktree),
      worktreePath: row.worktree_path,
      worktreeBranch: row.worktree_branch,
      blockedReason: row.blocked_summary,
      errorSummary: row.error_summary,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      steps,
      stepDetails,
      dependencies,
    };
  }

  getFlow(flowId: string): FlowRecord {
    return this.flowFromRow(this.flowRow(flowId));
  }

  listFlows(workspaceId?: string): FlowSummary[] {
    const rows = workspaceId
      ? this.database.all<FlowRow>(`
          SELECT f.*, w.name AS workspace_name, w.path AS workspace_path
          FROM flows f JOIN workspaces w ON w.id = f.workspace_id
          WHERE f.workspace_id = ? ORDER BY f.created_at DESC
        `, workspaceId)
      : this.database.all<FlowRow>(`
          SELECT f.*, w.name AS workspace_name, w.path AS workspace_path
          FROM flows f JOIN workspaces w ON w.id = f.workspace_id
          ORDER BY f.created_at DESC
        `);
    return rows.map((row) => {
      const steps = this.database.all<StepRow>('SELECT * FROM flow_steps WHERE flow_id = ?', row.id);
      return {
        flowId: row.id,
        workspaceId: row.workspace_id,
        workflowId: row.workflow_id,
        jiraKey: row.jira_key,
        status: row.status,
        currentStep: row.current_step,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        completedSteps: steps.filter((step) => step.status === 'done').length,
        totalSteps: steps.length,
        generation: Number(row.generation),
        revision: Number(row.revision),
      };
    });
  }

  listFlowStates(workspaceId?: string): Record<string, WorkflowState> {
    const summaries = this.listFlows(workspaceId);
    return Object.fromEntries(summaries.map((summary) => {
      const flow = this.getFlow(summary.flowId);
      const { workspacePath: _workspacePath, worktreePath: _worktreePath, ...state } = flow;
      return [summary.flowId, state];
    }));
  }

  artifactDirectory(flowOrId: string | FlowRecord): string {
    const flow = typeof flowOrId === 'string' ? this.getFlow(flowOrId) : flowOrId;
    return path.join(this.config.taskFlowsDir, assertSafeRelative(flow.workspaceId, 'workspace ID'), assertSafeRelative(flow.flowId, 'flow ID'));
  }

  outputFile(flowId: string, step: string): string {
    const flow = this.getFlow(flowId);
    const detail = flow.stepDetails.find((candidate) => candidate.step === step);
    if (!detail?.outputPath) throw new DomainError(`No output configured for step: ${step}`, 'missing_output_config');
    return path.join(this.artifactDirectory(flow), assertSafeRelative(detail.outputPath, 'output path'));
  }

  private emitDomainEvent(flowId: string, eventType: string, payload: Record<string, unknown>): number {
    const flow = this.database.get<{ workspace_id: string; workspace_path: string }>(`
      SELECT flows.workspace_id, workspaces.path AS workspace_path
      FROM flows JOIN workspaces ON workspaces.id = flows.workspace_id
      WHERE flows.id = ?
    `, flowId);
    const redactions = [
      [this.config.codexHome, '$CODEX_HOME'],
      [this.config.taskFlowsDir, '$TASK_FLOWS'],
      [flow?.workspace_path || '', '$WORKSPACE'],
      [this.config.repoRoot, '$DEVTEAM_ROOT'],
    ].filter(([source]) => source).sort((left, right) => right[0].length - left[0].length);
    const sanitized = JSON.parse(JSON.stringify(payload, (_key, value: unknown) => {
      if (typeof value !== 'string') return value;
      return redactions.reduce(
        (result, [source, replacement]) => result.split(source).join(replacement),
        value,
      );
    })) as Record<string, unknown>;
    const result = this.database.run(`
      INSERT INTO domain_events(workspace_id, flow_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, flow?.workspace_id || null, flowId, eventType, JSON.stringify(sanitized), now());
    return Number(result.lastInsertRowid);
  }

  private insertCommand(
    flowId: string,
    type: FlowCommandType,
    payload: Record<string, unknown>,
    idempotencyKey: string = crypto.randomUUID(),
    initialStatus: 'pending' | 'completed' = 'pending',
  ): string {
    const existing = this.database.get<{ id: string }>(
      'SELECT id FROM flow_commands WHERE idempotency_key = ?', idempotencyKey,
    );
    if (existing) return existing.id;
    const commandId = crypto.randomUUID();
    const timestamp = now();
    this.database.run(`
      INSERT INTO flow_commands(
        id, flow_id, type, payload_json, idempotency_key, status,
        created_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    commandId, flowId, type, JSON.stringify(payload), idempotencyKey, initialStatus,
    timestamp, timestamp, initialStatus === 'completed' ? timestamp : null);

    const eventType = commandEvent(type);
    if (eventType) {
      this.database.run(`
        INSERT INTO event_outbox(
          id, event_id, flow_id, command_id, event_type, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      crypto.randomUUID(), commandId, flowId, commandId, eventType,
      JSON.stringify({ commandId, flowId }), timestamp, timestamp);
    }
    return commandId;
  }

  createFlow(request: CreateFlowRequest, idempotencyKey?: string): FlowCommandResponse {
    const existing = this.existingCommand(idempotencyKey, 'start');
    if (existing) return existing;
    const jiraKey = request.jiraKey?.trim() || null;
    const prompt = request.prompt?.trim() || null;
    if (!jiraKey && !prompt) throw new DomainError('Either jiraKey or prompt is required', 'missing_task_context');
    if (!request.workflowId || !request.workspaceId) {
      throw new DomainError('workflowId and workspaceId are required', 'missing_configuration');
    }
    const flowId = newFlowId();
    const commandId = this.database.transaction(() => {
      const workflow = this.database.get<{ steps: string }>('SELECT steps FROM workflows WHERE id = ?', request.workflowId);
      if (!workflow) throw new NotFoundError('Workflow', request.workflowId);
      const workspace = this.database.get<{ id: string }>('SELECT id FROM workspaces WHERE id = ?', request.workspaceId);
      if (!workspace) throw new NotFoundError('Workspace', request.workspaceId);
      const steps = parseJson<unknown[]>(workflow.steps, []);
      if (!steps.length || !steps.every((step) => typeof step === 'string' && step.length > 0)) {
        throw new DomainError('Workflow has no valid steps', 'invalid_workflow');
      }
      const stepOrder = steps as string[];
      if (new Set(stepOrder).size !== stepOrder.length) {
        throw new DomainError('Workflow steps must be unique', 'invalid_workflow');
      }
      if (!stepOrder.every((step) => /^[A-Za-z0-9._-]+$/.test(step))) {
        throw new DomainError('Workflow step IDs may only contain letters, numbers, dot, underscore, and dash', 'invalid_workflow');
      }
      const agents = new Map(this.database.all<{ id: string; outputs: string }>(
        `SELECT id, outputs FROM agents WHERE id IN (${stepOrder.map(() => '?').join(',')})`, ...stepOrder,
      ).map((agent) => [agent.id, agent]));
      for (const step of stepOrder) {
        if (!agents.has(step)) throw new DomainError(`Workflow references unknown agent: ${step}`, 'invalid_workflow');
        const outputs = parseJson<unknown[]>(agents.get(step)?.outputs, []);
        if (!outputs.length || typeof outputs[0] !== 'string' || !outputs[0]) {
          throw new DomainError(`Agent ${step} has no valid output path`, 'invalid_workflow');
        }
      }

      const dependencies = [...new Set(request.dependsOn || [])];
      for (const dependencyId of dependencies) {
        if (dependencyId === flowId) throw new DomainError('A flow cannot depend on itself', 'dependency_cycle');
        const dependency = this.database.get<{ workspace_id: string }>(
          'SELECT workspace_id FROM flows WHERE id = ?', dependencyId,
        );
        if (!dependency) throw new NotFoundError('Dependency flow', dependencyId);
        if (dependency.workspace_id !== request.workspaceId) {
          throw new DomainError('Dependencies must belong to the same workspace', 'workspace_isolation');
        }
      }

      const timestamp = now();
      this.database.run(`
        INSERT INTO flows(
          id, workspace_id, workflow_id, jira_key, custom_prompt, step_order_json,
          status, current_step, generation, revision, use_worktree, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 1, 0, ?, ?, ?)
      `,
      flowId, request.workspaceId, request.workflowId, jiraKey, prompt,
      JSON.stringify(stepOrder), stepOrder[0], request.useWorktree ? 1 : 0, timestamp, timestamp);

      stepOrder.forEach((step, position) => {
        const outputs = parseJson<string[]>(agents.get(step)?.outputs, []);
        const output = outputs[0] ? assertSafeRelative(outputs[0], `${step} output`) : null;
        this.database.run(`
          INSERT INTO flow_steps(
            flow_id, step, position, status, cycle, technical_retry_count,
            needs_fix_count, output_path, updated_at
          ) VALUES (?, ?, ?, 'waiting', 1, 0, 0, ?, ?)
        `, flowId, step, position, output, timestamp);
      });
      for (const dependencyId of dependencies) {
        this.database.run(
          'INSERT INTO flow_dependencies(flow_id, dependency_flow_id) VALUES (?, ?)',
          flowId, dependencyId,
        );
      }
      const id = this.insertCommand(flowId, 'start', {}, idempotencyKey);
      this.emitDomainEvent(flowId, 'flow.created', { flowId, status: 'queued', revision: 0 });
      return id;
    });
    return { flowId, commandId, status: 'queued' };
  }

  retryFlow(flowId: string, request: RetryFlowRequest, idempotencyKey?: string): FlowCommandResponse {
    const existing = this.existingCommand(idempotencyKey, 'retry', flowId);
    if (existing) return existing;
    let clearPath: string | null = null;
    const commandId = this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      const selected = flow.stepDetails.find((step) => step.step === request.step);
      if (!selected) throw new DomainError(`Step is not part of this flow: ${request.step}`, 'invalid_step');
      if (flow.status === 'running' || flow.status === 'queued' || flow.status === 'pending_dependencies'
        || flow.status === 'stopping' || ACTIVE_STEP_STATUSES.includes(selected.status)) {
        throw new ConflictError('Cannot retry while the flow or selected step is active');
      }
      const timestamp = now();
      this.database.run(`
        UPDATE flow_steps
        SET status = 'waiting', cycle = cycle + 1, technical_retry_count = 0,
            started_at = NULL, finished_at = NULL, updated_at = ?
        WHERE flow_id = ? AND position >= ?
      `, timestamp, flowId, selected.position);
      const customPrompt = request.prompt === undefined ? flow.customPrompt || null : request.prompt.trim() || null;
      const updated = this.database.run(`
        UPDATE flows
        SET status = 'queued', current_step = ?, generation = generation + 1,
            revision = revision + 1, custom_prompt = ?, blocked_summary = NULL,
            error_summary = NULL, finished_at = NULL, updated_at = ?
        WHERE id = ? AND revision = ?
      `, request.step, customPrompt, timestamp, flowId, flow.revision);
      if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
      const command = this.insertCommand(
        flowId, 'retry', { step: request.step, clearOutput: request.clearOutput === true, resumeThread: request.resumeThread === true }, idempotencyKey,
      );
      this.emitDomainEvent(flowId, 'flow.retry-requested', {
        flowId, step: request.step, status: 'queued', revision: flow.revision + 1,
      });
      if (request.clearOutput) clearPath = this.outputFile(flowId, request.step);
      return command;
    });
    if (clearPath) {
      try { fs.rmSync(clearPath, { force: true }); } catch { /* output clearing is best effort */ }
    }
    return { flowId, commandId, status: 'queued' };
  }

  resumeFlow(flowId: string, idempotencyKey?: string): FlowCommandResponse {
    const existing = this.existingCommand(idempotencyKey, 'resume', flowId);
    if (existing) return existing;
    const commandId = this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (flow.status !== 'blocked' && flow.status !== 'expired') {
        throw new ConflictError('Resume is only valid for blocked or expired flows');
      }
      const timestamp = now();
      if (flow.status === 'expired') {
        const step = flow.currentStep || flow.stepOrder[0];
        this.database.run(`
          UPDATE flow_steps SET status = 'waiting', cycle = cycle + 1,
            technical_retry_count = 0, started_at = NULL, finished_at = NULL, updated_at = ?
          WHERE flow_id = ? AND step = ?
        `, timestamp, flowId, step);
        const updated = this.database.run(`
          UPDATE flows SET status = 'queued', generation = generation + 1,
            revision = revision + 1, blocked_summary = NULL, error_summary = NULL,
            finished_at = NULL, updated_at = ? WHERE id = ? AND revision = ?
        `, timestamp, flowId, flow.revision);
        if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
      }
      const command = this.insertCommand(flowId, 'resume', {}, idempotencyKey);
      this.emitDomainEvent(flowId, 'flow.resume-requested', {
        flowId,
        status: flow.status === 'expired' ? 'queued' : 'blocked',
        revision: flow.revision + (flow.status === 'expired' ? 1 : 0),
      });
      return command;
    });
    return { flowId, commandId, status: 'queued' };
  }

  requestStop(flowId: string, idempotencyKey?: string): FlowCommandResponse {
    const idempotent = this.existingCommand(idempotencyKey, 'stop', flowId);
    if (idempotent) return idempotent;
    const commandId = this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (flow.status === 'stopped') {
        const existing = this.database.get<{ id: string }>(`
          SELECT id FROM flow_commands WHERE flow_id = ? AND type = 'stop'
          ORDER BY created_at DESC LIMIT 1
        `, flowId);
        return existing?.id || this.insertCommand(flowId, 'stop', {}, idempotencyKey, 'completed');
      }
      if (TERMINAL.includes(flow.status)) {
        throw new ConflictError(`Cannot stop a terminal ${flow.status} flow`);
      }
      const timestamp = now();
      const updated = this.database.run(`
        UPDATE flows SET status = 'stopping', revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `, timestamp, flowId, flow.revision);
      if (Number(updated.changes) !== 1) throw new ConflictError('Flow changed while stop was requested');
      const command = this.insertCommand(flowId, 'stop', {}, idempotencyKey);
      this.emitDomainEvent(flowId, 'flow.stopping', {
        flowId, status: 'stopping', revision: flow.revision + 1,
      });
      return command;
    });
    return { flowId, commandId, status: 'queued' };
  }

  finishStop(flowId: string, commandId: string): void {
    this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (flow.status === 'stopped') return;
      const timestamp = now();
      this.database.run(`
        UPDATE event_outbox SET sent_at = COALESCE(sent_at, ?), lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE flow_id = ? AND command_id <> ? AND sent_at IS NULL
      `, timestamp, timestamp, flowId, commandId);
      this.database.run(`
        UPDATE flow_commands SET status = 'cancelled', finished_at = COALESCE(finished_at, ?), updated_at = ?
        WHERE flow_id = ? AND id <> ? AND status IN ('pending','dispatched','running')
      `, timestamp, timestamp, flowId, commandId);
      this.database.run(`
        UPDATE step_attempts SET status = 'cancelled', finished_at = COALESCE(finished_at, ?), updated_at = ?
        WHERE flow_id = ? AND status IN ('queued','running')
      `, timestamp, timestamp, flowId);
      this.database.run(`
        UPDATE flow_steps SET status = 'cancelled', finished_at = COALESCE(finished_at, ?), updated_at = ?
        WHERE flow_id = ? AND status IN ('queued','running','retrying')
      `, timestamp, timestamp, flowId);
      this.database.run(`
        UPDATE orchestration_runs SET status = 'cancelled', finished_at = ?, updated_at = ?
        WHERE flow_id = ? AND status IN ('queued','running','waiting')
      `, timestamp, timestamp, flowId);
      const updated = this.database.run(`
        UPDATE flows SET status = 'stopped', revision = revision + 1,
          finished_at = ?, updated_at = ? WHERE id = ? AND revision = ? AND status = 'stopping'
      `, timestamp, timestamp, flowId, flow.revision);
      if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
      this.database.run(`
        UPDATE flow_commands SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?
      `, timestamp, timestamp, commandId);
      this.insertTerminalSignal(flowId, commandId, timestamp);
      this.emitDomainEvent(flowId, 'flow.stopped', { flowId, status: 'stopped', revision: flow.revision + 1 });
    });
  }

  stoppingCommands(): Array<{ flowId: string; commandId: string }> {
    return this.database.all<{ flowId: string; commandId: string }>(`
      SELECT flows.id AS flowId, commands.id AS commandId
      FROM flows
      JOIN flow_commands commands ON commands.flow_id = flows.id AND commands.type = 'stop'
      WHERE flows.status = 'stopping'
      ORDER BY commands.created_at DESC
    `).filter((entry, index, entries) =>
      entries.findIndex((candidate) => candidate.flowId === entry.flowId) === index);
  }

  deleteFlow(flowId: string, idempotencyKey?: string): FlowCommandResponse {
    const existing = this.existingCommand(idempotencyKey, 'delete', flowId);
    if (existing) return existing;
    let artifactDirectory = '';
    const commandId = this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (!TERMINAL.includes(flow.status)) {
        throw new ConflictError('Active flows must be stopped before deletion');
      }
      const dependent = this.database.get<{ flow_id: string }>(
        'SELECT flow_id FROM flow_dependencies WHERE dependency_flow_id = ? LIMIT 1', flowId,
      );
      if (dependent) {
        throw new ConflictError(`Flow is still required by dependent flow ${dependent.flow_id}`);
      }
      artifactDirectory = this.artifactDirectory(flow);
      const command = this.insertCommand(flowId, 'delete', {}, idempotencyKey, 'completed');
      this.emitDomainEvent(flowId, 'flow.deleted', { flowId, workspaceId: flow.workspaceId });
      const deleted = this.database.run(
        'DELETE FROM flows WHERE id = ? AND revision = ? AND status = ?', flowId, flow.revision, flow.status,
      );
      if (Number(deleted.changes) !== 1) throw new ConflictError('Stale flow revision');
      return command;
    });
    try { fs.rmSync(artifactDirectory, { recursive: true, force: true }); } catch { /* DB deletion remains authoritative */ }
    return { flowId, commandId, status: 'queued' };
  }

  coordinatorDefinition(flowId: string): CoordinatorDefinition {
    const flow = this.getFlow(flowId);
    return {
      flowId,
      steps: flow.stepOrder,
      dependencies: flow.dependencies,
      generation: flow.generation,
      useWorktree: flow.useWorktree,
    };
  }

  claimCoordinator(
    commandId: string,
    flowId: string,
    inngestRunId: string,
    runnerId: string,
  ): { claimed: boolean; reason?: string; definition?: CoordinatorDefinition } {
    return this.database.transaction(() => {
      const command = this.command(commandId);
      if (command.flowId !== flowId) throw new DomainError('Command does not belong to flow', 'invalid_command');
      if (!['start', 'retry', 'resume'].includes(command.type)) {
        throw new DomainError(`Command cannot start a coordinator: ${command.type}`, 'invalid_command');
      }
      if (command.status === 'completed' || command.status === 'cancelled' || command.status === 'failed') {
        return { claimed: false, reason: `command_${command.status}` };
      }
      const flow = this.getFlow(flowId);
      if (flow.status === 'stopping' || TERMINAL.includes(flow.status)) {
        const timestamp = now();
        this.database.run(`
          UPDATE flow_commands SET status = 'cancelled', finished_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending','dispatched','running')
        `, timestamp, timestamp, commandId);
        return { claimed: false, reason: `flow_${flow.status}` };
      }
      if (command.type === 'resume' && flow.status === 'blocked') {
        const active = this.database.get<{ id: string }>(`
          SELECT id FROM orchestration_runs
          WHERE flow_id = ? AND generation = ? AND status IN ('running','waiting') LIMIT 1
        `, flowId, flow.generation);
        if (active) return { claimed: false, reason: 'active_coordinator_waiting' };
      }
      if (command.status === 'running') return { claimed: false, reason: 'already_claimed' };
      const timestamp = now();
      this.database.run(`
        UPDATE flow_commands SET status = 'running', claimed_by = ?, claimed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending','dispatched')
      `, runnerId, timestamp, timestamp, commandId);
      const runId = crypto.randomUUID();
      this.database.run(`
        INSERT INTO orchestration_runs(
          id, flow_id, generation, command_id, inngest_run_id, status,
          created_at, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
        ON CONFLICT(flow_id, generation) DO UPDATE SET
          inngest_run_id = COALESCE(orchestration_runs.inngest_run_id, excluded.inngest_run_id),
          updated_at = excluded.updated_at
      `, runId, flowId, flow.generation, commandId, inngestRunId, timestamp, timestamp, timestamp);
      return { claimed: true, definition: this.coordinatorDefinition(flowId) };
    });
  }

  claimResume(commandId: string, flowId: string, resetStep = true): boolean {
    return this.database.transaction(() => {
      const command = this.command(commandId);
      if (command.flowId !== flowId || command.type !== 'resume') return false;
      if (command.status === 'completed') return false;
      const flow = this.getFlow(flowId);
      if (flow.status !== 'blocked') return false;
      const step = flow.currentStep || flow.stepOrder[0];
      const timestamp = now();
      if (resetStep) {
        this.database.run(`
          UPDATE flow_steps SET status = 'waiting', cycle = cycle + 1,
            technical_retry_count = 0, started_at = NULL, finished_at = NULL, updated_at = ?
          WHERE flow_id = ? AND step = ?
        `, timestamp, flowId, step);
      }
      const updated = this.database.run(`
        UPDATE flows SET status = 'running', revision = revision + 1,
          blocked_summary = NULL, error_summary = NULL, updated_at = ?
        WHERE id = ? AND revision = ?
      `, timestamp, flowId, flow.revision);
      if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
      this.database.run(`
        UPDATE flow_commands SET status = 'completed', claimed_at = COALESCE(claimed_at, ?),
          finished_at = ?, updated_at = ? WHERE id = ?
      `, timestamp, timestamp, timestamp, commandId);
      this.emitDomainEvent(flowId, 'flow.resumed', {
        flowId, step, status: 'running', revision: flow.revision + 1,
      });
      return true;
    });
  }

  dependencyStates(flowId: string): Array<{ flowId: string; status: FlowStatus }> {
    return this.database.all<{ flowId: string; status: FlowStatus }>(`
      SELECT dependency.id AS flowId, dependency.status AS status
      FROM flow_dependencies fd
      JOIN flows dependency ON dependency.id = fd.dependency_flow_id
      WHERE fd.flow_id = ? ORDER BY dependency.id
    `, flowId);
  }

  markPendingDependencies(flowId: string): void {
    this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      const timestamp = now();
      const updated = this.database.run(`
        UPDATE flows SET status = 'pending_dependencies', revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `, timestamp, flowId, flow.revision);
      if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
      this.database.run(`
        UPDATE orchestration_runs SET status = 'waiting', updated_at = ?
        WHERE flow_id = ? AND status = 'running'
      `, timestamp, flowId);
      this.emitDomainEvent(flowId, 'flow.dependencies-waiting', {
        flowId, status: 'pending_dependencies', revision: flow.revision + 1,
      });
    });
  }

  markCoordinatorRunning(flowId: string): void {
    this.database.run(`
      UPDATE orchestration_runs SET status = 'running', updated_at = ?
      WHERE flow_id = ? AND status = 'waiting'
    `, now(), flowId);
  }

  queueStep(flowId: string, step: string): { cycle: number; workspaceKey: string } {
    return this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (!['queued', 'pending_dependencies', 'running'].includes(flow.status)) {
        throw new ConflictError(`Cannot queue a step while flow is ${flow.status}`);
      }
      const detail = flow.stepDetails.find((candidate) => candidate.step === step);
      if (!detail) throw new DomainError(`Unknown step: ${step}`, 'invalid_step');
      const timestamp = now();
      this.database.run(`
        UPDATE flow_steps SET status = 'queued', updated_at = ? WHERE flow_id = ? AND step = ?
      `, timestamp, flowId, step);
      const updated = this.database.run(`
        UPDATE flows SET status = 'running', current_step = ?, revision = revision + 1,
          started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND revision = ?
      `, step, timestamp, timestamp, flowId, flow.revision);
      if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
      this.emitDomainEvent(flowId, 'step.queued', {
        flowId, step, cycle: detail.cycle, status: 'running', revision: flow.revision + 1,
      });
      return { cycle: detail.cycle, workspaceKey: flow.workspaceId };
    });
  }

  projectAgentResult(
    flowId: string,
    stepName: string,
    result: AgentStepResult,
    commandId?: string,
  ): ProjectionResult {
    return this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (flow.status !== 'running') {
        throw new ConflictError(`Cannot project an agent result while flow is ${flow.status}`);
      }
      const step = flow.stepDetails.find((candidate) => candidate.step === stepName);
      if (!step) throw new DomainError(`Unknown step: ${stepName}`, 'invalid_step');
      const timestamp = now();
      if (result.status === 'DONE') {
        this.database.run(`
          UPDATE flow_steps SET status = 'done', finished_at = ?, updated_at = ?
          WHERE flow_id = ? AND step = ?
        `, timestamp, timestamp, flowId, stepName);
        this.bumpFlow(flow, { eventType: 'step.completed', payload: { step: stepName, attemptId: result.attemptId } });
        return { outcome: 'continue', nextIndex: step.position + 1, step: { ...step, status: 'done' } };
      }

      if (result.status === 'BLOCKED') {
        this.database.run(`
          UPDATE flow_steps SET status = 'blocked', finished_at = ?, updated_at = ?
          WHERE flow_id = ? AND step = ?
        `, timestamp, timestamp, flowId, stepName);
        const updated = this.database.run(`
          UPDATE flows SET status = 'blocked', blocked_summary = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?
        `, `Agent ${stepName} reported BLOCKED`, timestamp, flowId, flow.revision);
        if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
        this.database.run(`
          UPDATE orchestration_runs SET status = 'waiting', updated_at = ?
          WHERE flow_id = ? AND status = 'running'
        `, timestamp, flowId);
        this.emitDomainEvent(flowId, 'flow.blocked', {
          flowId, step: stepName, status: 'blocked', revision: flow.revision + 1,
        });
        return { outcome: 'blocked', nextIndex: step.position, step: { ...step, status: 'blocked' } };
      }

      if (result.status === 'NEEDS_FIX') {
        const nextCount = step.needsFixCount + 1;
        if (nextCount >= 5) {
          this.database.run(`
            UPDATE flow_steps SET status = 'blocked', needs_fix_count = ?, finished_at = ?, updated_at = ?
            WHERE flow_id = ? AND step = ?
          `, nextCount, timestamp, timestamp, flowId, stepName);
          const updated = this.database.run(`
            UPDATE flows SET status = 'blocked', blocked_summary = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?
          `, `NEEDS_FIX limit exceeded at ${stepName}`, timestamp, flowId, flow.revision);
          if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
          this.database.run(`
            UPDATE orchestration_runs SET status = 'waiting', updated_at = ?
            WHERE flow_id = ? AND status = 'running'
          `, timestamp, flowId);
          this.emitDomainEvent(flowId, 'flow.blocked', {
            flowId, step: stepName, reason: 'needs_fix_limit', status: 'blocked', revision: flow.revision + 1,
          });
          return { outcome: 'blocked', nextIndex: step.position, step: { ...step, status: 'blocked', needsFixCount: nextCount } };
        }
        const fixIndex = this.fixTargetIndex(flow.stepOrder);
        this.database.run(`
          UPDATE flow_steps SET
            status = 'waiting', cycle = cycle + 1,
            needs_fix_count = CASE WHEN step = ? THEN ? ELSE needs_fix_count END,
            technical_retry_count = 0, started_at = NULL, finished_at = NULL, updated_at = ?
          WHERE flow_id = ? AND position >= ?
        `, stepName, nextCount, timestamp, flowId, fixIndex);
        const fixStep = flow.stepOrder[fixIndex];
        const updated = this.database.run(`
          UPDATE flows SET status = 'running', current_step = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?
        `, fixStep, timestamp, flowId, flow.revision);
        if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
        this.emitDomainEvent(flowId, 'step.needs-fix', {
          flowId, step: stepName, fixStep, count: nextCount, status: 'running', revision: flow.revision + 1,
        });
        return { outcome: 'rewind', nextIndex: fixIndex, step: { ...step, status: 'needs_fix', needsFixCount: nextCount } };
      }

      this.database.run(`
        UPDATE flow_steps SET status = 'failed', finished_at = ?, updated_at = ? WHERE flow_id = ? AND step = ?
      `, timestamp, timestamp, flowId, stepName);
      this.failFlowInTransaction(flow, `Agent ${stepName} reported FAILED`, stepName, commandId);
      return { outcome: 'failed', nextIndex: step.position, step: { ...step, status: 'failed' } };
    });
  }

  private fixTargetIndex(steps: string[]): number {
    const exact = steps.findIndex((step) => step === 'developer' || step === 'implementer' || step === 'fix_implementer' || step === 'refactor-implementer');
    if (exact >= 0) return exact;
    for (let index = steps.length - 1; index >= 0; index--) {
      if (/(developer|implementer|frontend|backend|dev)/i.test(steps[index])) return index;
    }
    return 0;
  }

  expireBlockedFlow(flowId: string, reason = 'Blocked wait expired after 30 days'): void {
    this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (flow.status !== 'blocked') return;
      const timestamp = now();
      const updated = this.database.run(`
        UPDATE flows SET status = 'expired', error_summary = ?, revision = revision + 1,
          finished_at = ?, updated_at = ? WHERE id = ? AND revision = ?
      `, reason, timestamp, timestamp, flowId, flow.revision);
      if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
      this.database.run(`
        UPDATE orchestration_runs SET status = 'expired', finished_at = ?, updated_at = ?
        WHERE flow_id = ? AND status = 'waiting'
      `, timestamp, timestamp, flowId);
      const command = this.database.get<{ command_id: string }>(`
        SELECT command_id FROM orchestration_runs WHERE flow_id = ? AND generation = ?
      `, flowId, flow.generation);
      if (command) {
        this.database.run(`
          UPDATE flow_commands SET status = 'failed', error_json = ?,
            finished_at = COALESCE(finished_at, ?), updated_at = ?
          WHERE id = ? AND status IN ('pending','dispatched','running')
        `, JSON.stringify({ message: reason.slice(0, 500) }), timestamp, timestamp, command.command_id);
        this.insertTerminalSignal(flowId, command.command_id, timestamp);
      }
      this.emitDomainEvent(flowId, 'flow.expired', {
        flowId, status: 'expired', revision: flow.revision + 1,
      });
    });
  }

  completeFlow(flowId: string, commandId: string): void {
    this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (flow.stepDetails.some((step) => step.status !== 'done')) {
        throw new ConflictError('Cannot complete a flow until every step is done');
      }
      if (flow.status !== 'running') {
        throw new ConflictError(`Cannot complete a flow while it is ${flow.status}`);
      }
      const timestamp = now();
      const updated = this.database.run(`
        UPDATE flows SET status = 'completed', current_step = NULL, revision = revision + 1,
          finished_at = ?, updated_at = ? WHERE id = ? AND revision = ?
      `, timestamp, timestamp, flowId, flow.revision);
      if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
      this.database.run(`
        UPDATE orchestration_runs SET status = 'completed', finished_at = ?, updated_at = ?
        WHERE flow_id = ? AND generation = ?
      `, timestamp, timestamp, flowId, flow.generation);
      this.database.run(`
        UPDATE flow_commands SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?
      `, timestamp, timestamp, commandId);
      this.database.run(`
        INSERT INTO event_outbox(
          id, event_id, flow_id, command_id, event_type, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'devteam/flow.completed', ?, ?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `,
      crypto.randomUUID(), `${commandId}:completed`, flowId, commandId,
      JSON.stringify({ commandId, flowId }), timestamp, timestamp);
      this.emitDomainEvent(flowId, 'flow.completed', {
        flowId, status: 'completed', revision: flow.revision + 1,
      });
    });
  }

  blockFlow(flowId: string, reason: string): void {
    this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (flow.status === 'stopping' || TERMINAL.includes(flow.status)) return;
      const timestamp = now();
      const updated = this.database.run(`
        UPDATE flows SET status = 'blocked', blocked_summary = ?, revision = revision + 1,
          updated_at = ? WHERE id = ? AND revision = ?
      `, reason.slice(0, 2_000), timestamp, flowId, flow.revision);
      if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
      this.database.run(`
        UPDATE orchestration_runs SET status = 'waiting', updated_at = ?
        WHERE flow_id = ? AND status = 'running'
      `, timestamp, flowId);
      this.emitDomainEvent(flowId, 'flow.blocked', {
        flowId, status: 'blocked', revision: flow.revision + 1,
        error: { code: 'worktree_conflict', message: reason.slice(0, 500) },
      });
    });
  }

  failFlow(flowId: string, message: string, step?: string, commandId?: string): void {
    this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (flow.status === 'stopping' || TERMINAL.includes(flow.status)) return;
      this.failFlowInTransaction(flow, message, step, commandId);
    });
  }

  private failFlowInTransaction(flow: FlowRecord, message: string, step?: string, commandId?: string): void {
    const timestamp = now();
    if (step) {
      this.database.run(`
        UPDATE flow_steps SET status = 'failed', finished_at = COALESCE(finished_at, ?), updated_at = ?
        WHERE flow_id = ? AND step = ?
      `, timestamp, timestamp, flow.flowId, step);
    }
    const updated = this.database.run(`
      UPDATE flows SET status = 'failed', error_summary = ?, revision = revision + 1,
        finished_at = ?, updated_at = ? WHERE id = ? AND revision = ?
    `, message.slice(0, 2_000), timestamp, timestamp, flow.flowId, flow.revision);
    if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
    this.database.run(`
      UPDATE orchestration_runs SET status = 'failed', finished_at = ?, updated_at = ?
      WHERE flow_id = ? AND status IN ('queued','running','waiting')
    `, timestamp, timestamp, flow.flowId);
    if (commandId) {
      this.database.run(`
        UPDATE flow_commands SET status = 'failed', error_json = ?, finished_at = ?, updated_at = ? WHERE id = ?
      `, JSON.stringify({ message: message.slice(0, 500) }), timestamp, timestamp, commandId);
      this.database.run(`
        INSERT INTO event_outbox(
          id, event_id, flow_id, command_id, event_type, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'devteam/flow.failed', ?, ?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `,
      crypto.randomUUID(), `${commandId}:failed`, flow.flowId, commandId,
      JSON.stringify({ commandId, flowId: flow.flowId }), timestamp, timestamp);
    }
    this.emitDomainEvent(flow.flowId, 'flow.failed', {
      flowId: flow.flowId, step, status: 'failed', revision: flow.revision + 1,
      error: { code: 'orchestration_failed', message: message.slice(0, 500) },
    });
  }

  private insertTerminalSignal(flowId: string, commandId: string, timestamp: string): void {
    this.database.run(`
      INSERT INTO event_outbox(
        id, event_id, flow_id, command_id, event_type, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'devteam/flow.failed', ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `,
    crypto.randomUUID(), `${commandId}:terminal`, flowId, commandId,
    JSON.stringify({ commandId, flowId }), timestamp, timestamp);
  }

  private updateFlowState(flowId: string, status: FlowStatus, eventType: string): void {
    this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      const timestamp = now();
      const result = this.database.run(`
        UPDATE flows SET status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `, status, timestamp, flowId, flow.revision);
      if (Number(result.changes) !== 1) throw new ConflictError('Stale flow revision');
      this.emitDomainEvent(flowId, eventType, { flowId, status, revision: flow.revision + 1 });
    });
  }

  private bumpFlow(
    flow: FlowRecord,
    options: { eventType: string; payload: Record<string, unknown> },
  ): void {
    const timestamp = now();
    const result = this.database.run(`
      UPDATE flows SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?
    `, timestamp, flow.flowId, flow.revision);
    if (Number(result.changes) !== 1) throw new ConflictError('Stale flow revision');
    this.emitDomainEvent(flow.flowId, options.eventType, {
      flowId: flow.flowId, revision: flow.revision + 1, ...options.payload,
    });
  }

  command(commandId: string): FlowCommandRecord {
    const row = this.database.get<{
      id: string; flow_id: string; type: FlowCommandType; payload_json: string;
      idempotency_key: string; status: FlowCommandRecord['status']; created_at: string;
    }>('SELECT * FROM flow_commands WHERE id = ?', commandId);
    if (!row) throw new NotFoundError('Command', commandId);
    return {
      id: row.id,
      flowId: row.flow_id,
      type: row.type,
      payload: parseJson(row.payload_json, {}),
      idempotencyKey: row.idempotency_key,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  getAgent(step: string): AgentRecord {
    const row = this.database.get<{
      id: string; role: string; objective: string; model: string | null; thinking: string | null;
      tools: string; outputs: string; runtime: string | null; runtime_command: string | null; instructions: string;
    }>('SELECT * FROM agents WHERE id = ?', step);
    if (!row) throw new NotFoundError('Agent', step);
    return {
      id: row.id,
      role: row.role,
      objective: row.objective,
      model: row.model,
      thinking: row.thinking,
      tools: parseJson(row.tools, []),
      outputs: parseJson(row.outputs, []),
      runtime: row.runtime,
      runtimeCommand: row.runtime_command || undefined,
      instructions: row.instructions,
    };
  }

  latestRetryCommand(flowId: string): { step: string; clearOutput: boolean; resumeThread: boolean } | null {
    const row = this.database.get<{ payload_json: string }>(
      "SELECT payload_json FROM flow_commands WHERE flow_id = ? AND type = 'retry' ORDER BY created_at DESC LIMIT 1",
      flowId,
    );
    if (!row) return null;
    const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
    return {
      step: typeof payload.step === 'string' ? payload.step : '',
      clearOutput: payload.clearOutput === true,
      resumeThread: payload.resumeThread === true,
    };
  }

  latestAttemptWithThread(flowId: string, step: string): { threadId: string; sessionRunId: string } | null {
    const attempts = this.listAttempts(flowId, step);
    for (let i = attempts.length - 1; i >= 0; i--) {
      const attempt = attempts[i];
      if (attempt.status !== 'completed' && attempt.status !== 'failed' && attempt.status !== 'running') continue;
      try {
        const flow = this.getFlow(flowId);
        const metadataPath = path.join(this.artifactDirectory(flow), 'sessions', step, `${attempt.sessionRunId}.json`);
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { threadId?: string };
        if (metadata.threadId) {
          return { threadId: metadata.threadId, sessionRunId: attempt.sessionRunId };
        }
      } catch { /* no metadata */ }
    }
    return null;
  }

  resumeAttempt(
    flowId: string,
    step: string,
    cycle: number,
    inngestRunId: string,
    inngestAttempt: number,
    runnerId: string,
  ): StepAttemptRecord | null {
    return this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      if (flow.status !== 'running') {
        throw new ConflictError(`Cannot resume an attempt while flow is ${flowId}`);
      }
      const attempts = this.listAttempts(flowId, step);
      for (let i = attempts.length - 1; i >= 0; i--) {
        const attempt = attempts[i];
        if (attempt.status !== 'completed' && attempt.status !== 'failed') continue;
        try {
          const metadataPath = path.join(this.artifactDirectory(flow), 'sessions', step, `${attempt.sessionRunId}.json`);
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { threadId?: string };
          if (metadata.threadId) {
            const timestamp = now();
            this.database.run(`
              UPDATE step_attempts SET status = 'running', cycle = ?,
                inngest_run_id = ?, inngest_attempt = ?, runner_id = ?,
                started_at = ?, updated_at = ?
              WHERE id = ?
            `, cycle, inngestRunId, inngestAttempt, runnerId, timestamp, timestamp, attempt.id);
            this.database.run(`
              UPDATE flow_steps SET status = 'running', technical_retry_count = ?,
                started_at = COALESCE(started_at, ?), updated_at = ?
              WHERE flow_id = ? AND step = ?
            `, inngestAttempt, timestamp, timestamp, flowId, step);
            this.bumpFlow(flow, {
              eventType: 'step.running',
              payload: { step, attemptId: attempt.id, technicalAttempt: inngestAttempt },
            });
            return this.attempt(attempt.id);
          }
        } catch { /* no metadata */ }
      }
      return null;
    });
  }

  createAttempt(input: {
    id: string; flowId: string; step: string; cycle: number; technicalAttempt: number;
    inngestRunId: string; inngestAttempt: number; sessionRunId: string; runnerId: string;
  }): StepAttemptRecord {
    return this.database.transaction(() => {
      const flow = this.getFlow(input.flowId);
      if (flow.status !== 'running') {
        throw new ConflictError(`Cannot create an attempt while flow is ${flow.status}`);
      }
      const existing = this.database.get<{ id: string }>(`
        SELECT id FROM step_attempts
        WHERE flow_id = ? AND step = ? AND cycle = ? AND technical_attempt = ?
      `, input.flowId, input.step, input.cycle, input.technicalAttempt);
      if (!existing) {
        const timestamp = now();
        this.database.run(`
          INSERT INTO step_attempts(
            id, flow_id, step, cycle, technical_attempt, inngest_run_id,
            inngest_attempt, session_run_id, runner_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
        `,
        input.id, input.flowId, input.step, input.cycle, input.technicalAttempt,
        input.inngestRunId, input.inngestAttempt, input.sessionRunId, input.runnerId,
        timestamp, timestamp);
      }
      return this.attempt(existing?.id || input.id);
    });
  }

  markAttemptRunning(attemptId: string, pid: number, processGroupId: number): void {
    this.database.transaction(() => {
      const attempt = this.attempt(attemptId);
      const flow = this.getFlow(attempt.flowId);
      if (flow.status !== 'running') {
        throw new ConflictError(`Cannot start an attempt while flow is ${flow.status}`);
      }
      const timestamp = now();
      // Handle both queued (new attempt) and running (resumed attempt) statuses
      const updated = this.database.run(`
        UPDATE step_attempts SET status = 'running', pid = ?, process_group_id = ?,
          started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `, pid, processGroupId, timestamp, timestamp, attemptId);
      if (Number(updated.changes) !== 1) throw new ConflictError('Attempt is no longer queued or running');
      this.database.run(`
        UPDATE flow_steps SET status = 'running', technical_retry_count = ?,
          started_at = COALESCE(started_at, ?), updated_at = ? WHERE flow_id = ? AND step = ?
      `, attempt.technicalAttempt, timestamp, timestamp, attempt.flowId, attempt.step);
      this.bumpFlow(flow, {
        eventType: 'step.running',
        payload: { step: attempt.step, attemptId, technicalAttempt: attempt.technicalAttempt },
      });
    });
  }

  finishAttempt(
    attemptId: string,
    status: 'completed' | 'failed' | 'cancelled',
    exitCode: number | null,
    error?: { stage: string; message: string; retriable: boolean } | null,
  ): void {
    this.database.transaction(() => {
      const attempt = this.attempt(attemptId);
      const timestamp = now();
      const updated = this.database.run(`
        UPDATE step_attempts SET status = ?, exit_code = ?, error_json = ?,
          finished_at = COALESCE(finished_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('queued','running')
      `, status, exitCode, error ? JSON.stringify(error) : null, timestamp, timestamp, attemptId);
      if (Number(updated.changes) !== 1) return;
      if (status === 'failed' && error?.retriable) {
        const flow = this.getFlow(attempt.flowId);
        if (flow.status === 'running') {
          this.database.run(`
            UPDATE flow_steps SET status = 'retrying', technical_retry_count = technical_retry_count + 1,
              updated_at = ? WHERE flow_id = ? AND step = ?
          `, timestamp, attempt.flowId, attempt.step);
          this.bumpFlow(flow, {
            eventType: 'step.retrying',
            payload: { step: attempt.step, attemptId, technicalAttempt: attempt.technicalAttempt },
          });
        }
      }
    });
  }

  attempt(attemptId: string): StepAttemptRecord {
    const row = this.database.get<{
      id: string; flow_id: string; step: string; cycle: number; technical_attempt: number;
      inngest_run_id: string; inngest_attempt: number; session_run_id: string; runner_id: string;
      pid: number | null; process_group_id: number | null; exit_code: number | null;
      status: StepAttemptRecord['status']; error_json: string | null; created_at: string;
      started_at: string | null; finished_at: string | null; updated_at: string;
    }>('SELECT * FROM step_attempts WHERE id = ?', attemptId);
    if (!row) throw new NotFoundError('Attempt', attemptId);
    return {
      id: row.id,
      flowId: row.flow_id,
      step: row.step,
      cycle: Number(row.cycle),
      technicalAttempt: Number(row.technical_attempt),
      inngestRunId: row.inngest_run_id,
      inngestAttempt: Number(row.inngest_attempt),
      sessionRunId: row.session_run_id,
      runnerId: row.runner_id,
      pid: row.pid,
      processGroupId: row.process_group_id,
      exitCode: row.exit_code,
      status: row.status,
      error: parseJson(row.error_json, null),
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      updatedAt: row.updated_at,
    };
  }

  runningAttempts(flowId?: string): StepAttemptRecord[] {
    const rows = flowId
      ? this.database.all<{ id: string }>(
          "SELECT id FROM step_attempts WHERE flow_id = ? AND status = 'running' ORDER BY created_at", flowId,
        )
      : this.database.all<{ id: string }>(
          "SELECT id FROM step_attempts WHERE status = 'running' ORDER BY created_at",
        );
    return rows.map((row) => this.attempt(row.id));
  }

  listAttempts(flowId: string, step?: string): StepAttemptRecord[] {
    const rows = step
      ? this.database.all<{ id: string }>(`
          SELECT id FROM step_attempts WHERE flow_id = ? AND step = ?
          ORDER BY cycle, technical_attempt, created_at
        `, flowId, step)
      : this.database.all<{ id: string }>(`
          SELECT attempts.id AS id
          FROM step_attempts attempts
          JOIN flow_steps steps ON steps.flow_id = attempts.flow_id AND steps.step = attempts.step
          WHERE attempts.flow_id = ?
          ORDER BY steps.position, attempts.cycle, attempts.technical_attempt, attempts.created_at
        `, flowId);
    return rows.map((row) => this.attempt(row.id));
  }

  runningAttemptForCycle(flowId: string, step: string, cycle: number): StepAttemptRecord | null {
    const row = this.database.get<{ id: string }>(`
      SELECT id FROM step_attempts
      WHERE flow_id = ? AND step = ? AND cycle = ? AND status = 'running'
      ORDER BY created_at DESC LIMIT 1
    `, flowId, step, cycle);
    return row ? this.attempt(row.id) : null;
  }

  completedAttemptForCycle(flowId: string, step: string, cycle: number): StepAttemptRecord | null {
    const row = this.database.get<{ id: string }>(`
      SELECT id FROM step_attempts
      WHERE flow_id = ? AND step = ? AND cycle = ? AND status = 'completed'
      ORDER BY technical_attempt DESC, created_at DESC LIMIT 1
    `, flowId, step, cycle);
    return row ? this.attempt(row.id) : null;
  }

  heartbeat(status: 'connecting' | 'connected' | 'disconnected' | 'stopping'): void {
    const timestamp = now();
    const active = this.database.get<{ count: number }>(`
      SELECT COUNT(*) AS count FROM step_attempts WHERE runner_id = ? AND status = 'running'
    `, this.config.runnerId)?.count || 0;
    this.database.run(`
      INSERT INTO orchestrator_workers(
        runner_id, connection_status, capacity, active_attempts, last_heartbeat, version, updated_at
      ) VALUES (?, ?, ?, ?, ?, '1.0.0', ?)
      ON CONFLICT(runner_id) DO UPDATE SET
        connection_status = excluded.connection_status,
        capacity = excluded.capacity,
        active_attempts = excluded.active_attempts,
        last_heartbeat = excluded.last_heartbeat,
        version = excluded.version,
        updated_at = excluded.updated_at
    `, this.config.runnerId, status, this.config.agentConcurrency, Number(active), timestamp, timestamp);
  }

  latestWorker(): {
    runnerId: string; connectionStatus: string; capacity: number; lastHeartbeat: string;
  } | null {
    const row = this.database.get<{
      runner_id: string; connection_status: string; capacity: number; last_heartbeat: string;
    }>('SELECT * FROM orchestrator_workers ORDER BY last_heartbeat DESC LIMIT 1');
    return row ? {
      runnerId: row.runner_id,
      connectionStatus: row.connection_status,
      capacity: Number(row.capacity),
      lastHeartbeat: row.last_heartbeat,
    } : null;
  }

  claimOutbox(limit = 20): Array<{
    id: string; eventId: string; flowId: string; commandId: string | null;
    eventType: string; payload: { commandId: string; flowId: string };
  }> {
    return this.database.transaction(() => {
      const timestamp = now();
      const leaseExpires = new Date(Date.now() + 30_000).toISOString();
      const rows = this.database.all<{
        id: string; event_id: string; flow_id: string; command_id: string | null;
        event_type: string; payload_json: string;
      }>(`
        SELECT * FROM event_outbox
        WHERE sent_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at < ?)
        ORDER BY created_at LIMIT ?
      `, timestamp, limit);
      for (const row of rows) {
        this.database.run(`
          UPDATE event_outbox SET lease_owner = ?, lease_expires_at = ?,
            attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?
        `, this.config.runnerId, leaseExpires, timestamp, row.id);
      }
      return rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        flowId: row.flow_id,
        commandId: row.command_id,
        eventType: row.event_type,
        payload: parseJson(row.payload_json, { commandId: '', flowId: row.flow_id }),
      }));
    });
  }

  markOutboxSent(id: string, commandId: string | null): void {
    this.database.transaction(() => {
      const timestamp = now();
      this.database.run(`
        UPDATE event_outbox SET sent_at = ?, lease_owner = NULL, lease_expires_at = NULL,
          error_json = NULL, updated_at = ? WHERE id = ?
      `, timestamp, timestamp, id);
      if (commandId) {
        this.database.run(`
          UPDATE flow_commands SET status = 'dispatched', updated_at = ?
          WHERE id = ? AND status = 'pending'
        `, timestamp, commandId);
      }
    });
  }

  markOutboxFailed(id: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.database.run(`
      UPDATE event_outbox SET lease_owner = NULL, lease_expires_at = NULL,
        error_json = ?, updated_at = ? WHERE id = ?
    `, JSON.stringify({ message: message.slice(0, 500) }), now(), id);
  }

  domainEventsAfter(cursor: number, workspaceId?: string, limit = 100): Array<{
    sequence: number; workspaceId: string | null; flowId: string | null; eventType: string;
  }> {
    const rows = workspaceId
      ? this.database.all<{
          sequence: number; workspace_id: string | null; flow_id: string | null; event_type: string;
        }>(`
          SELECT sequence, workspace_id, flow_id, event_type FROM domain_events
          WHERE sequence > ? AND workspace_id = ? ORDER BY sequence LIMIT ?
        `, cursor, workspaceId, limit)
      : this.database.all<{
          sequence: number; workspace_id: string | null; flow_id: string | null; event_type: string;
        }>(`
          SELECT sequence, workspace_id, flow_id, event_type FROM domain_events
          WHERE sequence > ? ORDER BY sequence LIMIT ?
        `, cursor, limit);
    return rows.map((row) => ({
      sequence: Number(row.sequence), workspaceId: row.workspace_id,
      flowId: row.flow_id, eventType: row.event_type,
    }));
  }

  latestDomainCursor(): number {
    return Number(this.database.get<{ sequence: number }>(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events',
    )?.sequence || 0);
  }

  setWorktree(flowId: string, worktreePath: string | null, branch: string | null): void {
    this.database.transaction(() => {
      const flow = this.getFlow(flowId);
      const updated = this.database.run(`
        UPDATE flows SET worktree_path = ?, worktree_branch = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `, worktreePath, branch, now(), flowId, flow.revision);
      if (Number(updated.changes) !== 1) throw new ConflictError('Stale flow revision');
      this.emitDomainEvent(flowId, 'flow.worktree-ready', {
        flowId, branch, revision: flow.revision + 1,
      });
    });
  }
}

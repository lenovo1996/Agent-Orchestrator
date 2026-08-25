import type {
  AttemptStatus,
  FlowStatus,
  FlowStepState,
  StepStatus,
  WorkflowState,
} from '@devteam-dashboard/shared';

export type FlowCommandType = 'start' | 'retry' | 'resume' | 'stop' | 'delete';
export type FlowCommandStatus = 'pending' | 'dispatched' | 'running' | 'completed' | 'failed' | 'cancelled';
export type DomainResultStatus = 'DONE' | 'NEEDS_FIX' | 'BLOCKED' | 'FAILED';

export const FLOW_STATUSES: readonly FlowStatus[] = [
  'queued', 'pending_dependencies', 'running', 'blocked', 'completed',
  'failed', 'stopping', 'stopped', 'expired',
];

export const STEP_STATUSES: readonly StepStatus[] = [
  'waiting', 'queued', 'running', 'retrying', 'done', 'needs_fix',
  'blocked', 'failed', 'cancelled',
];

export const ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'queued', 'running', 'completed', 'failed', 'cancelled',
];

export interface FlowRecord extends WorkflowState {
  worktreePath: string | null;
  workspacePath: string;
}

export interface AgentRecord {
  id: string;
  role: string;
  objective: string;
  model: string | null;
  thinking: string | null;
  tools: string[];
  outputs: string[];
  runtime: string | null;
  instructions: string;
  runtimeCommand?: string;
}

export interface StepAttemptRecord {
  id: string;
  flowId: string;
  step: string;
  cycle: number;
  technicalAttempt: number;
  inngestRunId: string;
  inngestAttempt: number;
  sessionRunId: string;
  runnerId: string;
  pid: number | null;
  processGroupId: number | null;
  exitCode: number | null;
  status: AttemptStatus;
  error: { stage: string; message: string; retriable: boolean } | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FlowCommandRecord {
  id: string;
  flowId: string;
  type: FlowCommandType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: FlowCommandStatus;
  createdAt: string;
}

export interface AgentStepResult {
  status: DomainResultStatus;
  attemptId: string;
}

export interface CoordinatorDefinition {
  flowId: string;
  workspaceId: string;
  steps: string[];
  dependencies: string[];
  generation: number;
  useWorktree: boolean;
}

export interface ProjectionResult {
  outcome: 'continue' | 'rewind' | 'blocked' | 'failed';
  nextIndex: number;
  step: FlowStepState;
}

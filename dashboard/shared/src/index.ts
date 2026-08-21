// === Core Domain Types ===

export type AgentStep = string;

export type FlowStatus =
  | 'queued'
  | 'pending_dependencies'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'stopping'
  | 'stopped'
  | 'expired';

export type StepStatus =
  | 'waiting'
  | 'queued'
  | 'running'
  | 'retrying'
  | 'done'
  | 'needs_fix'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type AttemptStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CustomWorkflow {
  id: string;
  name: string;
  description: string;
  steps: string[];
}

export interface AgentConfig {
  id: string;
  role: string;
  objective: string;
  model?: string;
  thinking?: string;
  tools: string[];
  outputs: string[];
  runtime?: string;
  runtimeCommand?: string;
  instructions: string;
}

export interface FlowStepState {
  step: AgentStep;
  position: number;
  status: StepStatus;
  cycle: number;
  technicalRetryCount: number;
  needsFixCount: number;
  outputPath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface WorkflowState {
  flowId: string;
  workspaceId: string;
  workspaceName: string;
  workflowId: string;
  jiraKey: string | null;
  customPrompt?: string;
  stepOrder: string[];
  status: FlowStatus;
  currentStep: AgentStep | null;
  generation: number;
  revision: number;
  useWorktree: boolean;
  worktreeBranch: string | null;
  blockedReason: string | null;
  errorSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: Record<AgentStep, StepStatus>;
  stepDetails: FlowStepState[];
  dependencies: string[];
}

export interface FlowSummary {
  flowId: string;
  workspaceId: string;
  workflowId: string;
  jiraKey: string | null;
  status: FlowStatus;
  currentStep: AgentStep | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  completedSteps: number;
  totalSteps: number;
  generation: number;
  revision: number;
}

export interface CreateFlowRequest {
  jiraKey?: string;
  prompt?: string;
  workflowId: string;
  workspaceId: string;
  dependsOn?: string[];
  useWorktree?: boolean;
}

export interface RetryFlowRequest {
  step: string;
  clearOutput?: boolean;
  prompt?: string;
  resumeThread?: boolean;
}

export interface FlowCommandResponse {
  flowId: string;
  commandId: string;
  status: 'queued';
}

export interface OrchestrationHealth {
  ready: boolean;
  inngest: { ready: boolean; url: string; error?: string };
  worker: {
    ready: boolean;
    runnerId: string | null;
    connectionStatus: string | null;
    capacity: number;
    error?: string;
  };
}

// === Socket.IO Event Payloads ===

export interface FlowUpdatedPayload {
  sequence: number;
  flowId: string;
  workflow: WorkflowState;
}

export interface LogAppendPayload {
  flowId: string;
  step: AgentStep;
  lines: string[];
}

export interface OutputCreatedPayload {
  flowId: string;
  step: AgentStep;
  filePath: string;
}

export interface OutputUpdatedPayload {
  flowId: string;
  step: AgentStep;
  content: string;
  metadata: FileMetadata;
}

export interface FileMetadata {
  size: number;
  lastModified: string;
}

export interface StateInitPayload {
  flows: Record<string, WorkflowState>;
  cursor: number;
}

// === Structured Codex sessions ===

export interface SessionUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface SessionErrorSummary {
  stage: 'before_thread' | 'turn' | 'process';
  message: string;
}

export interface SessionAttemptSummary {
  schemaVersion: 1 | 2;
  runId: string;
  attemptId?: string;
  inngestRunId?: string;
  inngestAttempt?: number;
  flowId: string;
  step: string;
  threadId: string | null;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  usage: SessionUsage | null;
  errorSummary: SessionErrorSummary | null;
}

export type SessionItemKind =
  | 'message'
  | 'reasoning'
  | 'command'
  | 'patch'
  | 'plan'
  | 'search'
  | 'tool'
  | 'error'
  | 'unknown';

export interface SessionItemSummary {
  id: string;
  ordinal: number | null;
  kind: SessionItemKind;
  timestamp: string;
  turnId?: string;
  role?: 'user' | 'assistant';
  phase?: 'commentary' | 'final';
  text?: string;
  title?: string;
  status?: string;
  callId?: string;
  toolName?: string;
  command?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  outputPreview?: string;
  filePaths?: string[];
  plan?: Array<{ step: string; status: string }>;
  hasDetail: boolean;
}

export interface SessionItemDetail {
  id: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  diff?: string;
  toolInput?: string;
  toolOutput?: string;
}

export interface SessionHeader {
  model: string | null;
  cliVersion: string | null;
  startedAt: string;
  finishedAt: string | null;
  totalDurationMs: number | null;
  activeDurationMs: number | null;
}

export interface SessionStats {
  turns: number;
  commands: number;
  patches: number;
  filesTouched: number;
  usage: SessionUsage | null;
  totalTokens: number;
}

export interface SessionSnapshot {
  attempt: SessionAttemptSummary;
  header: SessionHeader | null;
  stats: SessionStats;
  items: SessionItemSummary[];
  rolloutAvailable: boolean;
}

export interface SessionSubscription {
  workspaceName: string | null;
  flowId: string;
  step: string;
  runId: string;
}

export interface SessionItemUpsertPayload extends SessionSubscription {
  item: SessionItemSummary;
}

export interface SessionAttemptUpdatedPayload {
  workspaceName: string | null;
  flowId: string;
  step: string;
  attempt: SessionAttemptSummary;
}

// === Socket.IO Event Map ===

export interface ServerToClientEvents {
  'state:init': (payload: StateInitPayload) => void;
  'flow:updated': (payload: FlowUpdatedPayload) => void;
  'log:append': (payload: LogAppendPayload) => void;
  'output:created': (payload: OutputCreatedPayload) => void;
  'output:updated': (payload: OutputUpdatedPayload) => void;
  'session:item-upsert': (payload: SessionItemUpsertPayload) => void;
  'session:attempt-updated': (payload: SessionAttemptUpdatedPayload) => void;
}

export interface ClientToServerEvents {
  'state:resync': () => void;
  'workspace:select': (payload: { workspaceId: string | null }) => void;
  'log:subscribe': (payload: { flowId: string; step: AgentStep }) => void;
  'log:unsubscribe': (payload: { flowId: string; step: AgentStep }) => void;
  'session:subscribe': (payload: SessionSubscription) => void;
  'session:unsubscribe': (payload: SessionSubscription) => void;
}

// === Agent Interaction ===

export interface AgentMessageRequest {
  message: string;
}

export interface AgentMessageResponse {
  success: boolean;
  turnId: string;
  method: 'steer' | 'new-turn';
}

export interface AgentInterruptResponse {
  success: boolean;
}
export * from './workspaces';

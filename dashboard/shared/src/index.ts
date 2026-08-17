// === Core Domain Types ===

export type AgentStep = string;

export type StepStatus = 'waiting' | 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled' | 'retrying' | 'unknown';

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
  instructions: string;
}

export type FlowStatus = 'running' | 'stopped' | 'failed' | 'blocked' | 'completed' | 'pending_dependencies';

export interface WorkflowState {
  flowId: string;
  jiraKey: string;
  customPrompt?: string;
  workflowId?: string;
  stepOrder?: string[];
  status: FlowStatus;
  currentStep: AgentStep;
  startedAt: string;          // ISO 8601
  stoppedAt?: string;
  steps: Record<AgentStep, StepStatus>;
  retries?: Record<AgentStep, number>;
  needsFixCount?: Record<AgentStep, number>;
  blockedStep?: AgentStep;
  blockedReason?: string;
}

export interface FlowSummary {
  flowId: string;
  jiraKey: string;
  status: FlowStatus;
  currentStep: AgentStep;
  startedAt: string;
  completedSteps: number;
  totalSteps: number;
}

// === Socket.IO Event Payloads ===

export interface FlowUpdatedPayload {
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
  schemaVersion: 1;
  runId: string;
  flowId: string;
  step: string;
  threadId: string | null;
  status: 'starting' | 'running' | 'completed' | 'failed';
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
  'workspace:select': (payload: { workspaceName: string | null }) => void;
  'log:subscribe': (payload: { flowId: string; step: AgentStep }) => void;
  'log:unsubscribe': (payload: { flowId: string; step: AgentStep }) => void;
  'session:subscribe': (payload: SessionSubscription) => void;
  'session:unsubscribe': (payload: SessionSubscription) => void;
}
export * from './workspaces';

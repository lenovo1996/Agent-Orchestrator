// === Core Domain Types ===

export type AgentStep = string;

export type StepStatus = 'waiting' | 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled' | 'retrying' | 'unknown';

export interface Workspace {
  id: string;
  name: string;
  path: string;
}

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

export type FlowStatus = 'running' | 'stopped' | 'failed' | 'blocked' | 'completed';

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

// === Socket.IO Event Map ===

export interface ServerToClientEvents {
  'state:init': (payload: StateInitPayload) => void;
  'flow:updated': (payload: FlowUpdatedPayload) => void;
  'log:append': (payload: LogAppendPayload) => void;
  'output:created': (payload: OutputCreatedPayload) => void;
  'output:updated': (payload: OutputUpdatedPayload) => void;
  'workspace:switch': (workspaceId: string) => void;
}

export interface ClientToServerEvents {
  'state:resync': (workspaceId?: string) => void;
  'log:subscribe': (payload: { flowId: string; step: AgentStep }) => void;
  'log:unsubscribe': (payload: { flowId: string; step: AgentStep }) => void;
  'workspace:switch': (workspaceId: string) => void;
}

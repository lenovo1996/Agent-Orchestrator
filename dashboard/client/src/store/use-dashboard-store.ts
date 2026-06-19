import { create } from 'zustand';
import type {
  AgentConfig,
  WorkflowState,
  AgentStep,
  StateInitPayload,
  Workspace,
} from '@devteam-dashboard/shared';
import { AGENT_STEPS } from '@/lib/constants';

const API_BASE = import.meta.env.VITE_API_URL || '';

export interface LogBuffer {
  lines: string[];
  autoScroll: boolean;
}

export interface DashboardState {
  // Connection
  connected: boolean;
  setConnected: (v: boolean) => void;

  // Workspaces
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  fetchWorkspaces: () => Promise<void>;
  setActiveWorkspace: (id: string | null) => void;

  // Flows
  flows: Record<string, WorkflowState>;
  setFlows: (flows: Record<string, WorkflowState>) => void;
  updateFlow: (flowId: string, workflow: WorkflowState) => void;
  deleteFlowLocally: (flowId: string) => void;
  fetchFlow: (flowId: string) => Promise<WorkflowState | null>;

  // Agents
  agents: Record<string, AgentConfig>;
  setAgents: (agents: AgentConfig[]) => void;
  fetchAgents: () => Promise<void>;

  // Selection
  selectedFlowId: string | null;
  selectedStep: AgentStep | null;
  selectFlow: (flowId: string | null) => void;
  selectStep: (step: AgentStep | null) => void;

  // Logs
  logBuffers: Record<string, LogBuffer>;
  appendLogLines: (flowId: string, step: AgentStep, lines: string[]) => void;
  setLogBuffer: (flowId: string, step: AgentStep, lines: string[]) => void;
  toggleAutoScroll: () => void;

  // Init
  initState: (payload: StateInitPayload) => void;
}

export const MAX_LOG_LINES = 1000;

function getLatestAgentStep(flow: WorkflowState | undefined): AgentStep | null {
  if (!flow) return null;

  const stepsToUse = flow.stepOrder || AGENT_STEPS;
  for (let i = stepsToUse.length - 1; i >= 0; i--) {
    const step = stepsToUse[i];
    const status = flow.steps[step];
    if (status && status !== 'waiting') {
      return step;
    }
  }

  return flow.currentStep ?? null;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  connected: false,
  setConnected: (v) => set({ connected: v }),

  workspaces: [],
  activeWorkspaceId: null,
  fetchWorkspaces: async () => {
    const res = await fetch(`${API_BASE}/api/workspaces`);
    if (!res.ok) return;
    const workspaces = (await res.json()) as Workspace[];
    set({ workspaces });
    const { activeWorkspaceId } = get();
    if (workspaces.length > 0 && !activeWorkspaceId) {
      set({ activeWorkspaceId: workspaces[0].id });
    }
  },
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id, flows: {}, selectedFlowId: null, selectedStep: null, logBuffers: {} }),

  flows: {},
  setFlows: (flows) => set({ flows }),
  updateFlow: (flowId, workflow) =>
    set((state) => {
      const shouldSelectStep = state.selectedFlowId === flowId && !state.selectedStep;
      return {
        flows: { ...state.flows, [flowId]: workflow },
        selectedStep: shouldSelectStep ? getLatestAgentStep(workflow) : state.selectedStep,
      };
    }),
  deleteFlowLocally: (flowId) =>
    set((state) => {
      const newFlows = { ...state.flows };
      delete newFlows[flowId];
      return {
        flows: newFlows,
        selectedFlowId: state.selectedFlowId === flowId ? null : state.selectedFlowId
      };
    }),
  fetchFlow: async (flowId) => {
    const workspaceId = get().activeWorkspaceId;
    const url = new URL(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`, window.location.origin);
    if (workspaceId) {
      url.searchParams.append('workspaceId', workspaceId);
    }
    const res = await fetch(url.toString());
    if (!res.ok) return null;

    const data = (await res.json()) as { workflow?: WorkflowState };
    if (!data.workflow) return null;

    set((state) => {
      const shouldSelectStep = state.selectedFlowId === flowId && !state.selectedStep;
      return {
        flows: { ...state.flows, [flowId]: data.workflow! },
        selectedStep: shouldSelectStep ? getLatestAgentStep(data.workflow) : state.selectedStep,
      };
    });

    return data.workflow;
  },

  agents: {},
  setAgents: (agents) =>
    set({
      agents: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    }),
  fetchAgents: async () => {
    const res = await fetch(`${API_BASE}/api/agents`);
    if (!res.ok) return;
    const agents = (await res.json()) as AgentConfig[];
    set({
      agents: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    });
  },

  selectedFlowId: null,
  selectedStep: null,
  selectFlow: (flowId) =>
    set((state) => ({
      selectedFlowId: flowId,
      selectedStep: flowId ? getLatestAgentStep(state.flows[flowId]) : null,
    })),
  selectStep: (step) => set({ selectedStep: step }),

  logBuffers: {},
  appendLogLines: (flowId, step, lines) =>
    set((state) => {
      const key = `${flowId}:${step}`;
      const existing = state.logBuffers[key] || { lines: [], autoScroll: true };
      const newLines = [...existing.lines, ...lines].slice(-MAX_LOG_LINES);
      return {
        logBuffers: {
          ...state.logBuffers,
          [key]: { ...existing, lines: newLines },
        },
      };
    }),
  setLogBuffer: (flowId, step, lines) =>
    set((state) => {
      const key = `${flowId}:${step}`;
      return {
        logBuffers: {
          ...state.logBuffers,
          [key]: { lines: lines.slice(-MAX_LOG_LINES), autoScroll: true },
        },
      };
    }),
  toggleAutoScroll: () =>
    set((state) => {
      const { selectedFlowId, selectedStep } = state;
      if (!selectedFlowId || !selectedStep) return state;
      const key = `${selectedFlowId}:${selectedStep}`;
      const existing = state.logBuffers[key];
      if (!existing) return state;
      return {
        logBuffers: {
          ...state.logBuffers,
          [key]: { ...existing, autoScroll: !existing.autoScroll },
        },
      };
    }),

  initState: (payload) =>
    set((state) => ({
      flows: payload.flows,
      selectedStep:
        state.selectedFlowId && !state.selectedStep
          ? getLatestAgentStep(payload.flows[state.selectedFlowId])
          : state.selectedStep,
    })),
}));

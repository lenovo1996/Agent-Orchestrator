import type { StateCreator } from 'zustand';
import type { WorkflowState, AgentStep, StateInitPayload } from '@devteam-dashboard/shared';
import { AGENT_STEPS } from '@/lib/constants';
import type { WorkspaceSlice } from './workspaceSlice';

const API_BASE = import.meta.env.VITE_API_URL || '';

export interface FlowSlice {
  flows: Record<string, WorkflowState>;
  setFlows: (flows: Record<string, WorkflowState>) => void;
  updateFlow: (flowId: string, workflow: WorkflowState) => void;
  deleteFlowLocally: (flowId: string) => void;
  fetchFlow: (flowId: string) => Promise<WorkflowState | null>;

  selectedFlowId: string | null;
  selectedStep: AgentStep | null;
  selectFlow: (flowId: string | null) => void;
  selectStep: (step: AgentStep | null) => void;

  initState: (payload: StateInitPayload) => void;
}

export function getLatestAgentStep(flow: WorkflowState | undefined): AgentStep | null {
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

export const createFlowSlice: StateCreator<
  FlowSlice & WorkspaceSlice,
  [],
  [],
  FlowSlice
> = (set, get) => ({
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
        selectedFlowId: state.selectedFlowId === flowId ? null : state.selectedFlowId,
      };
    }),
  fetchFlow: async (flowId) => {
    const workspace = get().workspaces.find((w) => w.id === get().selectedWorkspaceId);
    const qs = workspace ? `?workspaceName=${encodeURIComponent(workspace.name)}` : '';
    const res = await fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}${qs}`);
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

  selectedFlowId: null,
  selectedStep: null,
  selectFlow: (flowId) =>
    set((state) => ({
      selectedFlowId: flowId,
      selectedStep: flowId ? getLatestAgentStep(state.flows[flowId]) : null,
    })),
  selectStep: (step) => set({ selectedStep: step }),

  initState: (payload) =>
    set((state) => ({
      flows: payload.flows,
      selectedStep:
        state.selectedFlowId && !state.selectedStep
          ? getLatestAgentStep(payload.flows[state.selectedFlowId])
          : state.selectedStep,
    })),
});

import { create } from 'zustand';
import { createWorkspaceSlice, type WorkspaceSlice } from './slices/workspaceSlice';
import { createFlowSlice, type FlowSlice } from './slices/flowSlice';
import { createLogSlice, type LogSlice } from './slices/logSlice';
import { createAgentSlice, type AgentSlice } from './slices/agentSlice';

export interface DashboardState
  extends WorkspaceSlice,
    FlowSlice,
    LogSlice,
    AgentSlice {
  // Connection state
  connected: boolean;
  setConnected: (v: boolean) => void;
}

export const useDashboardStore = create<DashboardState>((set, get, api) => ({
  ...createWorkspaceSlice(set, get, api),
  ...createFlowSlice(set, get, api),
  ...createLogSlice(set, get, api),
  ...createAgentSlice(set, get, api),

  connected: false,
  setConnected: (v) => set({ connected: v }),
}));

import type { StateCreator } from 'zustand';
import type { AgentConfig } from '@devteam-dashboard/shared';

const API_BASE = import.meta.env.VITE_API_URL || '';

export interface AgentSlice {
  agents: Record<string, AgentConfig>;
  setAgents: (agents: AgentConfig[]) => void;
  fetchAgents: () => Promise<void>;
}

export const createAgentSlice: StateCreator<
  AgentSlice,
  [],
  [],
  AgentSlice
> = (set) => ({
  agents: {},
  setAgents: (agents) =>
    set({
      agents: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
    }),
  fetchAgents: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/agents`);
      if (!res.ok) return;
      const agents = (await res.json()) as AgentConfig[];
      set({
        agents: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
      });
    } catch (err) {
      console.error('Failed to fetch agents', err);
    }
  },
});

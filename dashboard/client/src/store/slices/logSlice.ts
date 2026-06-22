import type { StateCreator } from 'zustand';
import type { AgentStep } from '@devteam-dashboard/shared';
import type { FlowSlice } from './flowSlice';

export interface LogBuffer {
  lines: string[];
  autoScroll: boolean;
}

export interface LogSlice {
  logBuffers: Record<string, LogBuffer>;
  appendLogLines: (flowId: string, step: AgentStep, lines: string[]) => void;
  setLogBuffer: (flowId: string, step: AgentStep, lines: string[]) => void;
  toggleAutoScroll: () => void;
}

export const MAX_LOG_LINES = 1000;

export const createLogSlice: StateCreator<
  LogSlice & FlowSlice,
  [],
  [],
  LogSlice
> = (set, get) => ({
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
});

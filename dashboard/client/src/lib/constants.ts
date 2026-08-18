import type { AgentConfig, AgentStep, StepStatus } from '@devteam-dashboard/shared';

/**
 * Ordered array of all 5 agent steps in pipeline execution order.
 */
export const AGENT_STEPS: AgentStep[] = [
  'clarifier',
  'architect',
  'planner',
  'implementer',
  'verifier',
];

export function formatStepId(step: AgentStep): string {
  return step
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getStepDisplayName(step: AgentStep, agents: Record<string, AgentConfig> = {}): string {
  return agents[step]?.role || formatStepId(step);
}

export function getAgentOutputFilename(step: AgentStep, agents: Record<string, AgentConfig> = {}): string {
  const output = agents[step]?.outputs?.[0];
  if (output) {
    return output.split('/').pop() || output;
  }

  return `${step}.md`;
}

/**
 * Tailwind CSS color classes for each step status, optimized for dark theme.
 * Validates: Requirements 3.3, 7.4
 */
export const STATUS_COLORS: Record<StepStatus, string> = {
  waiting: 'bg-gray-500',
  queued: 'bg-sky-400 animate-pulse',
  running: 'bg-blue-500 animate-pulse',
  needs_fix: 'bg-amber-500',
  done: 'bg-green-500',
  failed: 'bg-red-500',
  blocked: 'bg-purple-500',
  cancelled: 'bg-gray-600',
  retrying: 'bg-yellow-500 animate-pulse',
};

import type { AgentStep, StepStatus } from '@devteam-dashboard/shared';

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

/**
 * Human-readable display names for each agent step.
 */
export const STEP_DISPLAY_NAMES: Record<AgentStep, string> = {
  clarifier: 'Clarifier',
  architect: 'Architect',
  planner: 'Planner',
  implementer: 'Implementer',
  verifier: 'Verifier',
};

/**
 * Tailwind CSS color classes for each step status, optimized for dark theme.
 * Validates: Requirements 3.3, 7.4
 */
export const STATUS_COLORS: Record<StepStatus, string> = {
  waiting: 'bg-gray-500',
  pending: 'bg-gray-400',
  running: 'bg-blue-500 animate-pulse',
  done: 'bg-green-500',
  failed: 'bg-red-500',
  blocked: 'bg-purple-500',
  cancelled: 'bg-gray-600',
  retrying: 'bg-yellow-500 animate-pulse',
  unknown: 'bg-gray-400',
};

/**
 * Mapping from AgentStep to its output filename in the output/ directory.
 */
export const OUTPUT_FILE_MAP: Record<AgentStep, string> = {
  clarifier: 'clarify.md',
  architect: 'architecture.md',
  planner: 'plan.md',
  implementer: 'implementation.md',
  verifier: 'verification.md',
};

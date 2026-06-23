import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentStep, StepStatus, WorkflowState } from '@devteam-dashboard/shared';
import { MAX_LOG_BUFFER_LINES, useDashboardStore } from './use-dashboard-store';

function workflow(
  flowId: string,
  currentStep: AgentStep,
  steps: Record<AgentStep, StepStatus>
): WorkflowState {
  return {
    flowId,
    jiraKey: 'JH-001',
    status: 'running',
    currentStep,
    startedAt: '2026-01-01T00:00:00Z',
    steps,
  };
}

describe('useDashboardStore selection', () => {
  beforeEach(() => {
    useDashboardStore.setState({
      connected: false,
      flows: {},
      selectedFlowId: null,
      selectedStep: null,
      logBuffers: {},
    });
  });

  it('selects latest non-waiting agent step when selecting a flow', () => {
    const flow = workflow('flow_001', 'architect', {
      clarifier: 'done',
      architect: 'running',
      planner: 'waiting',
      implementer: 'waiting',
      verifier: 'waiting',
    });

    useDashboardStore.setState({ flows: { [flow.flowId]: flow } });
    useDashboardStore.getState().selectFlow(flow.flowId);

    expect(useDashboardStore.getState().selectedFlowId).toBe('flow_001');
    expect(useDashboardStore.getState().selectedStep).toBe('architect');
  });

  it('selects a step when the selected flow arrives later', () => {
    useDashboardStore.getState().selectFlow('flow_002');
    expect(useDashboardStore.getState().selectedStep).toBeNull();

    const flow = workflow('flow_002', 'clarifier', {
      clarifier: 'pending',
      architect: 'waiting',
      planner: 'waiting',
      implementer: 'waiting',
      verifier: 'waiting',
    });

    useDashboardStore.getState().updateFlow(flow.flowId, flow);

    expect(useDashboardStore.getState().selectedStep).toBe('clarifier');
  });

  it('does not overwrite a manually selected step on flow updates', () => {
    const flow = workflow('flow_003', 'architect', {
      clarifier: 'done',
      architect: 'running',
      planner: 'waiting',
      implementer: 'waiting',
      verifier: 'waiting',
    });

    useDashboardStore.setState({ flows: { [flow.flowId]: flow } });
    useDashboardStore.getState().selectFlow(flow.flowId);
    useDashboardStore.getState().selectStep('clarifier');

    const updated = workflow('flow_003', 'planner', {
      clarifier: 'done',
      architect: 'done',
      planner: 'running',
      implementer: 'waiting',
      verifier: 'waiting',
    });
    useDashboardStore.getState().updateFlow(updated.flowId, updated);

    expect(useDashboardStore.getState().selectedStep).toBe('clarifier');
  });

  it('keeps parse context lines in log buffers', () => {
    const lines = Array.from({ length: MAX_LOG_BUFFER_LINES + 500 }, (_, i) => `line-${i}`);

    useDashboardStore.getState().setLogBuffer('flow_logs', 'architect', lines);

    const buffer = useDashboardStore.getState().logBuffers['flow_logs:architect'];
    expect(buffer.lines).toHaveLength(MAX_LOG_BUFFER_LINES);
    expect(buffer.lines[0]).toBe('line-500');
    expect(buffer.lines[buffer.lines.length - 1]).toBe(`line-${MAX_LOG_BUFFER_LINES + 499}`);
  });
});

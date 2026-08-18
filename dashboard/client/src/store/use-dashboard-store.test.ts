import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentStep, StepStatus, WorkflowState } from '@devteam-dashboard/shared';
import { useDashboardStore } from './use-dashboard-store';

function workflow(
  flowId: string,
  currentStep: AgentStep,
  steps: Record<AgentStep, StepStatus>
): WorkflowState {
  return {
    flowId,
    workspaceId: 'ws_1',
    workspaceName: 'Workspace',
    workflowId: 'wf_1',
    jiraKey: 'JH-001',
    stepOrder: Object.keys(steps),
    status: 'running',
    currentStep,
    generation: 1,
    revision: 0,
    useWorktree: false,
    worktreeBranch: null,
    blockedReason: null,
    errorSummary: null,
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
    steps,
    stepDetails: Object.entries(steps).map(([step, status], position) => ({
      step, position, status, cycle: 1, technicalRetryCount: 0, needsFixCount: 0,
      outputPath: `output/${step}.md`, startedAt: null, finishedAt: null,
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    dependencies: [],
  };
}

describe('useDashboardStore selection', () => {
  beforeEach(() => {
    useDashboardStore.setState({
      connected: false,
      flows: {},
      selectedFlowId: null,
      selectedStep: null,
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
      clarifier: 'queued',
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

  it('clears a deleted selection when a resync snapshot no longer contains it', () => {
    const flow = workflow('flow_deleted', 'implementer', { implementer: 'done' });
    useDashboardStore.setState({
      flows: { [flow.flowId]: flow }, selectedFlowId: flow.flowId, selectedStep: 'implementer',
    });

    useDashboardStore.getState().initState({ flows: {}, cursor: 9 });

    expect(useDashboardStore.getState()).toMatchObject({
      flows: {}, selectedFlowId: null, selectedStep: null, domainCursor: 9,
    });
  });
});

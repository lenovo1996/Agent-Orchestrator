/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkflowState } from '@devteam-dashboard/shared';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { FlowList } from './FlowList';

function flow(flowId: string, jiraKey: string, createdAt: string, status: WorkflowState['status']): WorkflowState {
  const stepStatus = status === 'completed' ? 'done' : status === 'running' ? 'running' : 'waiting';
  return {
    flowId,
    workspaceId: 'ws_1',
    workspaceName: 'Workspace',
    workflowId: 'wf_1',
    jiraKey,
    workflowContext: '',
    stepOrder: ['planner', 'implementer'],
    status,
    currentStep: status === 'completed' ? null : 'planner',
    generation: 1,
    revision: 1,
    useWorktree: false,
    worktreeBranch: null,
    blockedReason: null,
    errorSummary: null,
    createdAt,
    startedAt: createdAt,
    finishedAt: status === 'completed' ? createdAt : null,
    steps: { planner: stepStatus, implementer: status === 'completed' ? 'done' : 'waiting' },
    stepDetails: ['planner', 'implementer'].map((step, position) => ({
      step,
      position,
      status: step === 'planner' ? stepStatus : status === 'completed' ? 'done' : 'waiting',
      cycle: 1,
      technicalRetryCount: 0,
      needsFixCount: 0,
      onNeedsFix: null,
      outputPath: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: createdAt,
    })),
    dependencies: [],
  };
}

describe('FlowList', () => {
  const originalSelectFlow = useDashboardStore.getState().selectFlow;
  const selectFlow = vi.fn();

  afterEach(() => {
    cleanup();
    useDashboardStore.setState({ selectFlow: originalSelectFlow });
  });

  beforeEach(() => {
    selectFlow.mockReset();
    const older = flow('flow_older', 'TASK-1', '2026-08-17T00:00:00.000Z', 'completed');
    const newer = flow('flow_newer', 'TASK-2', '2026-08-18T00:00:00.000Z', 'running');
    useDashboardStore.setState({
      flows: { [older.flowId]: older, [newer.flowId]: newer },
      selectedFlowId: older.flowId,
      agents: {
        planner: { id: 'planner', role: 'Planner', objective: '', tools: [], outputs: [], instructions: '' },
      },
      selectFlow,
    });
  });

  it('renders a compact newest-first history list and selects a row', () => {
    render(<FlowList />);

    const history = screen.getByRole('region', { name: 'Flow history' });
    const rows = within(history).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('button', { name: 'Open flow TASK-2' })).toBeTruthy();
    expect(within(rows[1]).getByRole('button', { name: 'Open flow TASK-1' }).getAttribute('aria-current')).toBe('true');
    expect(screen.queryByText('flow_newer')).toBeNull();

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Open flow TASK-2' }));
    expect(selectFlow).toHaveBeenCalledWith('flow_newer');
  });
});

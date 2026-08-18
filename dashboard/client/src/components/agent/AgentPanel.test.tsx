/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentConfig, WorkflowState } from '@devteam-dashboard/shared';
import { useDashboardStore } from '@/store/use-dashboard-store';

vi.mock('@xyflow/react', () => ({
  BackgroundVariant: { Dots: 'dots' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  ReactFlow: ({ nodes, onNodeClick, colorMode }: any) => (
    <div data-testid="react-flow" data-color-mode={colorMode}>
      {nodes.map((node: any) => (
        <button key={node.id} type="button" onClick={(event) => onNodeClick(event, node)}>{node.data.label}</button>
      ))}
    </div>
  ),
}));

import { AgentPanel, buildPipelineGraph } from './AgentPanel';

const steps = ['clarifier', 'architect', 'planner', 'implementer', 'verifier'];
const startedAt = '2026-08-18T00:00:00.000Z';
const flow: WorkflowState = {
  flowId: 'flow_graph', workspaceId: 'ws_1', workspaceName: 'Workspace', workflowId: 'wf_1', jiraKey: 'GRAPH-1',
  stepOrder: steps, status: 'running', currentStep: 'planner', generation: 1, revision: 1,
  useWorktree: false, worktreeBranch: null, blockedReason: null, errorSummary: null,
  createdAt: startedAt, startedAt, finishedAt: null,
  steps: { clarifier: 'done', architect: 'done', planner: 'running', implementer: 'waiting', verifier: 'waiting' },
  stepDetails: steps.map((step, position) => ({
    step, position, status: position < 2 ? 'done' : position === 2 ? 'running' : 'waiting', cycle: 1,
    technicalRetryCount: step === 'planner' ? 1 : 0, needsFixCount: 0, outputPath: `output/${step}.md`,
    startedAt: position <= 2 ? startedAt : null, finishedAt: position < 2 ? startedAt : null, updatedAt: startedAt,
  })),
  dependencies: [],
};
const agents: Record<string, AgentConfig> = Object.fromEntries(steps.map((step) => [step, {
  id: step,
  role: `${step} role`,
  objective: `${step} objective`,
  model: `${step}-model`,
  tools: [],
  outputs: [`output/${step}.md`],
  runtime: 'codex',
  instructions: '',
}]));

describe('AgentPanel graph', () => {
  afterEach(cleanup);

  beforeEach(() => {
    useDashboardStore.setState({
      selectedFlowId: flow.flowId,
      selectedStep: 'clarifier',
      flows: { [flow.flowId]: flow },
      agents,
    });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      tokens: { clarifier: 100, architect: 200, planner: 300 },
      total: 600,
      outputTimes: {},
    }), { status: 200 })) as typeof fetch;
  });

  it('builds a snake graph with ordered animated edges and selected node state', () => {
    const graph = buildPipelineGraph(flow, agents, {}, 'planner', {
      planner: {
        usage: { inputTokens: 500, cachedInputTokens: 120, outputTokens: 80, reasoningOutputTokens: 10 },
        startedAt,
        finishedAt: null,
      },
    });

    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toHaveLength(4);
    expect(graph.nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 256, y: 0 },
      { x: 512, y: 0 },
      { x: 512, y: 180 },
      { x: 256, y: 180 },
    ]);
    expect(graph.nodes.find((node) => node.id === 'planner')).toMatchObject({
      selected: true,
      data: {
        status: 'running', model: 'planner-model', inputTokens: 500, outputTokens: 80,
        cachedInputTokens: 120, retryCount: 1, sourcePosition: 'bottom',
      },
    });
    expect(graph.edges.find((edge) => edge.target === 'planner')?.animated).toBe(true);
    expect(graph.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      'clarifier->architect',
      'architect->planner',
      'planner->implementer',
      'implementer->verifier',
    ]);
  });

  it('passes the dashboard color mode and selects a step when its graph node is clicked', async () => {
    render(<AgentPanel colorMode="light" />);

    expect((await screen.findByTestId('react-flow')).getAttribute('data-color-mode')).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'planner role' }));
    expect(useDashboardStore.getState().selectedStep).toBe('planner');
  });
});

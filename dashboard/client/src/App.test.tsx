/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App';
import { useDashboardStore } from './store/use-dashboard-store';

vi.mock('./hooks/use-socket-events', () => ({ useSocketEvents: vi.fn() }));
vi.mock('./components/layout/Header', () => ({ Header: () => <div>Dashboard header</div> }));
vi.mock('./components/layout/Sidebar', () => ({ Sidebar: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside> }));
vi.mock('./components/flow/FlowList', () => ({ FlowList: () => null }));
vi.mock('./components/agent/AgentPanel', () => ({ AgentPanel: () => <div>Pipeline content</div> }));
vi.mock('./components/agent/FlowActions', () => ({ FlowActions: () => null }));
vi.mock('./components/session/SessionViewer', () => ({ SessionViewer: () => <div>Session content</div> }));
vi.mock('./components/output/OutputPreview', () => ({ OutputPreview: () => <div>Output content</div> }));
vi.mock('./components/flow/NewTaskDialog', () => ({ NewTaskDialog: () => null }));
vi.mock('./components/workflows/WorkflowsPage', () => ({ WorkflowsPage: () => null }));
vi.mock('./components/agents/AgentsPage', () => ({ AgentsPage: () => null }));

describe('App flow workspace layout', () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.localStorage.setItem('dashboard-theme', 'dark');
    useDashboardStore.setState({
      selectedFlowId: 'flow-layout',
      fetchAgents: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('places pipeline above output in the left column and session in the right column', () => {
    render(<App />);

    const pipeline = screen.getByText('Agent Pipeline').closest('section')!;
    const output = screen.getByText('Output').closest('section')!;
    const session = screen.getByText('Session').closest('section')!;
    const leftColumn = pipeline.parentElement?.parentElement;

    expect(leftColumn).toBe(output.parentElement?.parentElement);
    expect(leftColumn).not.toBe(session.parentElement?.parentElement);
    expect(pipeline.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(output.compareDocumentPosition(session) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('separator').map((separator) => separator.getAttribute('aria-orientation'))).toEqual([
      'horizontal',
      'vertical',
    ]);
  });
});

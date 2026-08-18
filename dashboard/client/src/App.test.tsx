/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { useDashboardStore } from './store/use-dashboard-store';

vi.mock('./hooks/use-socket-events', () => ({ useSocketEvents: vi.fn() }));
vi.mock('./components/layout/Header', () => ({ Header: () => <div>Dashboard header</div> }));
vi.mock('./components/layout/Sidebar', () => ({ Sidebar: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside> }));
vi.mock('./components/flow/FlowList', () => ({ FlowList: () => <div>Task list</div> }));
vi.mock('./components/agent/AgentPanel', () => ({ AgentPanel: () => <div>Pipeline content</div> }));
vi.mock('./components/agent/FlowActions', () => ({ FlowActions: () => null }));
vi.mock('./components/session/SessionViewer', () => ({ SessionViewer: () => <div>Session content</div> }));
vi.mock('./components/output/OutputPreview', () => ({ OutputPreview: () => <div>Output content</div> }));
vi.mock('./components/flow/NewTaskDialog', () => ({ NewTaskDialog: () => null }));
vi.mock('./components/workflows/WorkflowsPage', () => ({ WorkflowsPage: () => <div>Workflow settings</div> }));
vi.mock('./components/agents/AgentsPage', () => ({ AgentsPage: () => <div>Agent settings</div> }));

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

  it('uses the left menu bar to separate Tasks, Workflow, and Agents', () => {
    render(<App />);

    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(navigation).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Task list')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    expect(screen.getByText('Workflow settings')).toBeTruthy();
    expect(screen.queryByText('Task list')).toBeNull();
    expect(screen.getByRole('button', { name: 'Workflow' }).getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    expect(screen.getByText('Agent settings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-current')).toBe('page');
  });
});

/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowState } from '@devteam-dashboard/shared';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { OutputPreview } from './OutputPreview';

const socketMock = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => void>,
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({ socket: socketMock }));

const originalFetch = globalThis.fetch;
const timestamp = '2026-08-21T00:00:00.000Z';
const workflow: WorkflowState = {
  flowId: 'flow_001',
  workspaceId: 'workspace_001',
  workspaceName: 'Workspace',
  workflowId: 'workflow_001',
  jiraKey: null,
  stepOrder: ['implementer'],
  status: 'completed',
  currentStep: 'implementer',
  generation: 1,
  revision: 1,
  useWorktree: false,
  worktreeBranch: null,
  blockedReason: null,
  errorSummary: null,
  createdAt: timestamp,
  startedAt: timestamp,
  finishedAt: timestamp,
  steps: { implementer: 'done' },
  stepDetails: [{
    step: 'implementer',
    position: 0,
    status: 'done',
    cycle: 1,
    technicalRetryCount: 0,
    needsFixCount: 0,
    outputPath: 'output/implementation.md',
    startedAt: timestamp,
    finishedAt: timestamp,
    updatedAt: timestamp,
  }],
  dependencies: [],
};

describe('OutputPreview Markdown theme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketMock.handlers = {};
    socketMock.on.mockImplementation((event: string, handler: (...args: any[]) => void) => {
      socketMock.handlers[event] = handler;
      return socketMock as any;
    });
    socketMock.off.mockImplementation((event: string) => {
      delete socketMock.handlers[event];
      return socketMock as any;
    });
    useDashboardStore.setState({
      selectedFlowId: 'flow_001',
      selectedStep: 'implementer',
      flows: {
        flow_001: workflow,
      },
      agents: {},
    });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      exists: true,
      content: '| Name | Status |\n| --- | --- |\n| API | Ready |',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    useDashboardStore.setState({ selectedFlowId: null, selectedStep: null, flows: {}, agents: {} });
  });

  it('uses normal prose in light mode and semantic table text colors in both themes', async () => {
    render(<OutputPreview />);
    const table = await screen.findByRole('table');
    const article = table.closest('article');

    expect(article).toBeTruthy();
    expect(article?.classList.contains('prose-invert')).toBe(false);
    expect(article?.classList.contains('dark:prose-invert')).toBe(true);
    expect(article?.classList.contains('prose-table:text-foreground')).toBe(true);
    expect(article?.classList.contains('prose-th:text-foreground')).toBe(true);
    expect(article?.classList.contains('prose-td:text-foreground')).toBe(true);
    expect(screen.getByText('API')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('loads the first output as soon as the output-created event arrives', async () => {
    let exists = false;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(exists
      ? { exists: true, content: 'Realtime output' }
      : { exists: false, content: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    render(<OutputPreview />);
    expect(await screen.findByText('No output file found for this step')).toBeTruthy();

    exists = true;
    await act(async () => {
      socketMock.handlers['output:created']({
        flowId: 'flow_001',
        step: 'implementer',
        filePath: 'output/implementation.md',
      });
    });

    expect(await screen.findByText('Realtime output')).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not let an older empty response overwrite a realtime output update', async () => {
    let resolveInitialFetch!: (response: Response) => void;
    const pendingInitialFetch = new Promise<Response>((resolve) => {
      resolveInitialFetch = resolve;
    });
    globalThis.fetch = vi.fn(async () => pendingInitialFetch) as typeof fetch;

    render(<OutputPreview />);
    await waitFor(() => expect(socketMock.handlers['output:updated']).toBeTypeOf('function'));

    act(() => {
      socketMock.handlers['output:updated']({
        flowId: 'flow_001',
        step: 'implementer',
        content: 'Realtime output wins',
        metadata: { size: 20, lastModified: timestamp },
      });
    });
    expect(await screen.findByText('Realtime output wins')).toBeTruthy();

    await act(async () => {
      resolveInitialFetch(new Response(JSON.stringify({ exists: false, content: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await pendingInitialFetch;
    });

    await waitFor(() => expect(screen.getByText('Realtime output wins')).toBeTruthy());
    expect(screen.queryByText('No output file found for this step')).toBeNull();
  });

  it('refetches after step completion when the watcher attached after the file was written', async () => {
    let exists = false;
    useDashboardStore.setState({
      flows: {
        flow_001: {
          ...workflow,
          status: 'running',
          finishedAt: null,
          steps: { implementer: 'running' },
          stepDetails: [{
            ...workflow.stepDetails[0],
            status: 'running',
            finishedAt: null,
          }],
        },
      },
    });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(exists
      ? { exists: true, content: 'Completed output' }
      : { exists: false, content: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    render(<OutputPreview />);
    expect(await screen.findByText('No output file found for this step')).toBeTruthy();

    exists = true;
    act(() => {
      useDashboardStore.setState({
        flows: {
          flow_001: {
            ...workflow,
            revision: workflow.revision + 1,
          },
        },
      });
    });

    expect(await screen.findByText('Completed output')).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

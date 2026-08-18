/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionSnapshot, WorkflowState } from '@devteam-dashboard/shared';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { SessionViewer } from './SessionViewer';

const socketMock = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => void>,
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  io: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('@/lib/socket', () => ({ socket: socketMock }));

const first = {
  schemaVersion: 1 as const,
  runId: 'aaaaaaaa-1111-4222-8333-444444444444',
  flowId: 'flow_001',
  step: 'implementer',
  threadId: '019fffff-1111-7222-8333-444444444444',
  status: 'completed' as const,
  startedAt: '2026-08-17T00:00:00.000Z',
  finishedAt: '2026-08-17T00:01:00.000Z',
  exitCode: 0,
  usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 5, reasoningOutputTokens: 2 },
  errorSummary: null,
};
const latest = { ...first, runId: 'bbbbbbbb-1111-4222-8333-444444444444', startedAt: '2026-08-17T00:02:00.000Z' };

const snapshot: SessionSnapshot = {
  attempt: latest,
  rolloutAvailable: true,
  header: { model: 'gpt-5.5', cliVersion: '0.147.0', startedAt: latest.startedAt, finishedAt: latest.finishedAt, totalDurationMs: 60_000, activeDurationMs: 40_000 },
  stats: { turns: 1, commands: 0, patches: 1, filesTouched: 1, usage: latest.usage, totalTokens: 15 },
  items: [
    { id: 'message-user', ordinal: 1, kind: 'message', timestamp: latest.startedAt, role: 'user', text: 'Please build', hasDetail: false },
    { id: 'message-commentary', ordinal: 2, kind: 'message', timestamp: latest.startedAt, role: 'assistant', phase: 'commentary', text: 'Working now', hasDetail: false },
    { id: 'reasoning-1', ordinal: 3, kind: 'reasoning', timestamp: latest.startedAt, title: 'Reasoning', text: 'Hidden thought summary', hasDetail: false },
    { id: 'call-patch', ordinal: 4, kind: 'patch', timestamp: latest.startedAt, title: 'File changes', status: 'completed', filePaths: ['a.ts'], hasDetail: true },
    { id: 'message-final', ordinal: 5, kind: 'message', timestamp: latest.startedAt, role: 'assistant', phase: 'final', text: 'Newest final', hasDetail: false },
  ],
};
const firstSnapshot: SessionSnapshot = {
  ...snapshot,
  attempt: first,
  header: { ...snapshot.header!, startedAt: first.startedAt },
  items: [{ id: 'old-final', ordinal: 1, kind: 'message', timestamp: first.startedAt, role: 'assistant', phase: 'final', text: 'Older final', hasDetail: false }],
};

describe('SessionViewer', () => {
  afterEach(cleanup);

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
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    const workflow: WorkflowState = {
      flowId: 'flow_001', workspaceId: 'ws_1', workspaceName: 'Workspace', workflowId: 'wf_1',
      jiraKey: 'TEST-1', stepOrder: ['implementer'], status: 'running', currentStep: 'implementer',
      generation: 1, revision: 1, useWorktree: false, worktreeBranch: null,
      blockedReason: null, errorSummary: null, createdAt: latest.startedAt,
      startedAt: latest.startedAt, finishedAt: null, steps: { implementer: 'running' },
      stepDetails: [{
        step: 'implementer', position: 0, status: 'running', cycle: 1,
        technicalRetryCount: 0, needsFixCount: 0, outputPath: 'output/implementation.md',
        startedAt: latest.startedAt, finishedAt: null, updatedAt: latest.startedAt,
      }],
      dependencies: [],
    };
    useDashboardStore.setState({
      selectedFlowId: 'flow_001',
      selectedStep: 'implementer',
      selectedWorkspaceId: null,
      workspaces: [],
      flows: { flow_001: workflow },
      agents: { implementer: { id: 'implementer', role: 'Developer', objective: '', tools: [], outputs: [], runtime: 'codex', instructions: '' } },
    });
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/items/call-patch')) {
        return new Response(JSON.stringify({ id: 'call-patch', diff: '*** Begin Patch\n+line\n*** End Patch' }), { status: 200 });
      }
      if (url.includes(`/${latest.runId}`)) {
        return new Response(JSON.stringify(snapshot), { status: 200 });
      }
      if (url.includes(`/${first.runId}`)) {
        return new Response(JSON.stringify(firstSnapshot), { status: 200 });
      }
      return new Response(JSON.stringify({ enabled: true, attempts: [first, latest] }), { status: 200 });
    }) as typeof fetch;
  });

  it('selects the newest attempt, hides reasoning by default and lazy-loads patch detail', async () => {
    render(<SessionViewer />);
    expect(await screen.findByText('Newest final')).toBeTruthy();
    expect((screen.getByLabelText('Attempt') as HTMLSelectElement).value).toBe(latest.runId);
    expect(screen.queryByRole('status', { name: 'Working...' })).toBeNull();
    expect(screen.queryByText('session.log')).toBeNull();
    expect(screen.queryByText(/Jump to turn/i)).toBeNull();
    expect(screen.getByLabelText('Session transcript').className).toContain('dark:bg-[#090b0f]');
    expect(screen.queryByText('Hidden thought summary')).toBeNull();
    expect(screen.queryByText(/Started /)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Session details' }));
    expect(screen.getByText((_, element) => element?.tagName === 'SPAN' && element.textContent?.startsWith('Started ') === true)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /reasoning/i }));
    expect(await screen.findByText('Hidden thought summary')).toBeTruthy();

    const detailCallsBefore = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => String(url).includes('/items/')).length;
    expect(detailCallsBefore).toBe(0);
    fireEvent.click(screen.getByText('File changes').closest('button')!);
    expect(await screen.findByText(/\+line/)).toBeTruthy();
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => String(url).includes('/items/'))).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('Attempt'), { target: { value: first.runId } });
    expect(await screen.findByText('Older final')).toBeTruthy();
    expect(screen.queryByText('Newest final')).toBeNull();
  });

  it('shows an animated working indicator for an active attempt and removes it when the attempt completes', async () => {
    const runningAttempt = {
      ...latest,
      status: 'running' as const,
      finishedAt: null,
      exitCode: null,
    };
    const runningSnapshot: SessionSnapshot = {
      ...snapshot,
      attempt: runningAttempt,
      header: { ...snapshot.header!, finishedAt: null, totalDurationMs: null },
    };
    global.fetch = vi.fn(async (input: string | URL | Request) => String(input).includes(`/${runningAttempt.runId}`)
      ? new Response(JSON.stringify(runningSnapshot), { status: 200 })
      : new Response(JSON.stringify({ enabled: true, attempts: [first, runningAttempt] }), { status: 200 })) as typeof fetch;

    render(<SessionViewer />);

    const working = await screen.findByRole('status', { name: 'Working...' });
    expect(working.querySelectorAll('[data-working-dot]')).toHaveLength(3);
    expect(working.querySelector('[data-working-dot]')?.className).toContain('animate-bounce');
    expect(working.closest('[data-session-working-dock]')).toBeTruthy();
    expect(screen.getByLabelText('Session transcript').contains(working)).toBe(false);

    socketMock.handlers['session:attempt-updated']({
      workspaceName: null,
      flowId: 'flow_001',
      step: 'implementer',
      attempt: {
        ...runningAttempt,
        status: 'completed',
        finishedAt: '2026-08-17T00:03:00.000Z',
        exitCode: 0,
      },
    });

    await waitFor(() => expect(screen.queryByRole('status', { name: 'Working...' })).toBeNull());
  });

  it('upserts stable item IDs without duplicates and stops auto-scroll after the user scrolls up', async () => {
    render(<SessionViewer />);
    expect(await screen.findByText('Newest final')).toBeTruthy();
    const transcript = screen.getByLabelText('Session transcript');
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    fireEvent.scroll(transcript);
    const scrollTo = HTMLElement.prototype.scrollTo as ReturnType<typeof vi.fn>;
    scrollTo.mockClear();

    const payload = {
      workspaceName: null,
      flowId: 'flow_001',
      step: 'implementer',
      runId: latest.runId,
      item: { id: 'ordinal-6', ordinal: 6, kind: 'message' as const, timestamp: latest.startedAt, role: 'assistant' as const, phase: 'commentary' as const, text: 'Live update', hasDetail: false },
    };
    socketMock.handlers['session:item-upsert'](payload);
    socketMock.handlers['session:item-upsert'](payload);
    expect(await screen.findAllByText('Live update')).toHaveLength(1);
    expect(scrollTo).not.toHaveBeenCalled();

    const scrollButton = screen.getByRole('button', { name: 'Scroll to bottom' });
    fireEvent.click(scrollButton);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).toBeNull();
  });

  it('counts exec_command tool upserts as commands', async () => {
    render(<SessionViewer />);
    expect(await screen.findByText('Newest final')).toBeTruthy();

    socketMock.handlers['session:item-upsert']({
      workspaceName: null,
      flowId: 'flow_001',
      step: 'implementer',
      runId: latest.runId,
      item: {
        id: 'exec-command-1', ordinal: 6, kind: 'tool', toolName: 'exec_command', title: 'exec_command',
        timestamp: latest.startedAt, status: 'completed', hasDetail: true,
      },
    });

    await waitFor(() => expect(screen.getByTitle('Commands').textContent).toBe('1'));
  });

  it('renders the historical-flow state without falling back to raw logs', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ enabled: true, attempts: [] }), { status: 200 })) as typeof fetch;
    render(<SessionViewer />);
    expect(await screen.findByText('Session data unavailable — flow created before Session Viewer.')).toBeTruthy();
    expect(screen.queryByText(/Runtime Log|Raw|Logs/)).toBeNull();
  });

  it('renders a pre-thread failure from structured metadata without stderr tail', async () => {
    const failed = {
      ...first,
      threadId: null,
      status: 'failed' as const,
      exitCode: 1,
      usage: null,
      errorSummary: { stage: 'before_thread' as const, message: 'Authentication failed' },
    };
    const failedSnapshot: SessionSnapshot = {
      attempt: failed,
      header: null,
      stats: { turns: 0, commands: 0, patches: 0, filesTouched: 0, usage: null, totalTokens: 0 },
      items: [],
      rolloutAvailable: false,
    };
    global.fetch = vi.fn(async (input: string | URL | Request) => String(input).includes(`/${failed.runId}`)
      ? new Response(JSON.stringify(failedSnapshot), { status: 200 })
      : new Response(JSON.stringify({ enabled: true, attempts: [failed] }), { status: 200 })) as typeof fetch;
    render(<SessionViewer />);
    expect(await screen.findByText('Codex failed before a session was created')).toBeTruthy();
    expect(screen.getByText('Authentication failed')).toBeTruthy();
    expect(screen.getByText('Exit code: 1')).toBeTruthy();
    expect(screen.queryByText(/stderr|Runtime Log/i)).toBeNull();
  });
});

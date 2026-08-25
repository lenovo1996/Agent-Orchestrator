/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentConfig, CustomWorkflow } from '@devteam-dashboard/shared';

import { WorkflowsPage } from './WorkflowsPage';

const agents: AgentConfig[] = [
  { id: 'planner', role: 'Delivery planner', objective: 'Plan delivery', model: 'gpt-5', tools: ['read'], outputs: ['plan.md'], runtime: 'codex', instructions: 'Plan.' },
  { id: 'implementer', role: 'Implementer', objective: 'Implement changes', model: 'gpt-5', tools: ['write'], outputs: ['implementation.md'], runtime: 'codex', instructions: 'Build.' },
  { id: 'reviewer', role: 'Code reviewer', objective: 'Review changes', model: 'gpt-5', tools: ['read'], outputs: ['review.md'], runtime: 'codex', instructions: 'Review.' },
  { id: 'verifier', role: 'QA verifier', objective: 'Verify behavior', model: 'gpt-5', tools: ['exec'], outputs: ['verification.md'], runtime: 'codex', instructions: 'Verify.' },
];
const workflows: CustomWorkflow[] = [
  {
    id: 'wf_delivery', name: 'Delivery flow', description: 'Plan and implement',
    steps: ['planner', 'ghost'], context: 'Keep changes focused.',
    needsFix: { reviewer: 'planner', verifier: 'implementer' }, version: 2,
  },
  {
    id: 'wf_build', name: 'Build flow', description: 'Implementation only',
    steps: ['implementer'], context: '', needsFix: {}, version: 1,
  },
];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch(options: { agentsResponse?: Response; workflowResponse?: Response; mutationResponse?: Response } = {}) {
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return options.mutationResponse?.clone() || json({ ok: true });
    if (String(input).endsWith('/api/agents')) return options.agentsResponse?.clone() || json(agents);
    return options.workflowResponse?.clone() || json(workflows);
  }) as typeof fetch;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('WorkflowsPage', () => {
  beforeEach(() => {
    installFetch();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows catalog summaries, configuration metadata, missing references, and search state', async () => {
    render(<WorkflowsPage />);

    expect(await screen.findByRole('heading', { name: 'Delivery flow' })).toBeTruthy();
    const overview = screen.getByRole('region', { name: 'Workflow overview' });
    expect(within(overview).getByText('Workflows').nextElementSibling?.textContent).toBe('2');
    expect(within(overview).getByText('Agent steps').nextElementSibling?.textContent).toBe('3');
    expect(within(overview).getByText('Workflows with feedback routing').nextElementSibling?.textContent).toBe('1');
    expect(screen.getByText('Missing agent reference: ghost')).toBeTruthy();
    expect(screen.getByText('reviewer → planner')).toBeTruthy();
    expect(screen.getByText('verifier → implementer')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search workflows'), { target: { value: 'implementer' } });
    expect(screen.queryByRole('heading', { name: 'Delivery flow' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Build flow' })).toBeTruthy();
    expect(screen.getByText('Showing 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('heading', { name: 'Delivery flow' })).toBeTruthy();
  });

  it('uses an ordered editor and saves reordered steps without dropping an unknown reference', async () => {
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit workflow Delivery flow' }));

    expect(screen.getByRole('list', { name: 'Workflow execution editor' })).toBeTruthy();
    expect(screen.getByLabelText('Agent for step 1').getAttribute('value')).toBe('planner');
    expect(screen.getByLabelText('Agent for step 2').getAttribute('value')).toBe('ghost');
    expect(screen.getByText(/Missing agent reference\. It will be preserved/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }));
    await waitFor(() => expect(screen.getByLabelText('Agent for step 1').getAttribute('value')).toBe('ghost'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Workflow' }));

    await waitFor(() => {
      const putCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(putCall).toBeTruthy();
      expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
        id: 'wf_delivery', steps: ['ghost', 'planner'], needsFix: { reviewer: 'planner' }, version: 2,
      });
    });
    expect(await screen.findByText('Workflow updated successfully.')).toBeTruthy();
  });

  it('adds known agents with capability context and keeps the linear API payload', async () => {
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create Workflow' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New flow' } });
    fireEvent.change(screen.getByLabelText('Agent for step 1'), { target: { value: 'planner' } });
    fireEvent.click(screen.getByRole('button', { name: '+ implementer' }));
    fireEvent.click(screen.getByRole('button', { name: '+ reviewer' }));
    fireEvent.click(screen.getByRole('button', { name: '+ verifier' }));

    await waitFor(() => expect(screen.getByLabelText('Agent for step 4').getAttribute('value')).toBe('verifier'));
    expect(within(screen.getByRole('list', { name: 'Workflow execution editor' })).getByText('Implementer')).toBeTruthy();
    expect(screen.getAllByText('gpt-5').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save Workflow' }));
    await waitFor(() => {
      const postCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({ name: 'New flow', steps: ['planner', 'implementer', 'reviewer', 'verifier'] });
    });
  });

  it('reports actionable NEEDS_FIX syntax errors instead of a connection error', async () => {
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit workflow Delivery flow' }));
    fireEvent.change(screen.getByLabelText('NEEDS_FIX routing'), { target: { value: 'reviewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Workflow' }));

    expect(await screen.findByText(/Invalid NEEDS_FIX route/)).toBeTruthy();
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('keeps workflow data visible when agent reference verification fails', async () => {
    installFetch({ agentsResponse: json({ message: 'Unavailable' }, 503) });
    render(<WorkflowsPage />);

    expect(await screen.findByRole('heading', { name: 'Delivery flow' })).toBeTruthy();
    expect(screen.getByText(/Agent references cannot be verified/)).toBeTruthy();
    expect(screen.queryByText(/Missing agent reference/)).toBeNull();
  });

  it('shows API delete errors and preserves confirmation behavior', async () => {
    installFetch({ mutationResponse: json({ message: 'Workflow is in use' }, 409) });
    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete workflow Delivery flow' }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(await screen.findByText('Workflow is in use')).toBeTruthy();
  });

  it('does not show unverified summary values while loading and then shows the empty catalog', async () => {
    const workflowResponse = deferred<Response>();
    const agentResponse = deferred<Response>();
    global.fetch = vi.fn((input: string | URL | Request) => (
      String(input).endsWith('/api/agents') ? agentResponse.promise : workflowResponse.promise
    )) as typeof fetch;

    render(<WorkflowsPage />);

    expect(screen.getByRole('status').textContent).toContain('Loading workflows');
    expect(screen.queryByRole('region', { name: 'Workflow overview' })).toBeNull();

    await act(async () => {
      workflowResponse.resolve(json([]));
      agentResponse.resolve(json([]));
    });

    expect(await screen.findByText('No workflows configured')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Workflow overview' })).toBeTruthy();
  });

  it('retries a failed primary catalog request', async () => {
    let workflowAttempts = 0;
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/agents')) return json(agents);
      workflowAttempts += 1;
      return workflowAttempts === 1 ? json({ message: 'Workflow service unavailable' }, 503) : json(workflows);
    }) as typeof fetch;

    render(<WorkflowsPage />);

    expect(await screen.findByText('Workflow service unavailable')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Workflow overview' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Delivery flow' })).toBeTruthy();
    expect(workflowAttempts).toBe(2);
  });

  it('prevents duplicate saves while pending and surfaces an API save failure', async () => {
    const mutationResponse = deferred<Response>();
    global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') return mutationResponse.promise;
      if (String(input).endsWith('/api/agents')) return Promise.resolve(json(agents));
      return Promise.resolve(json(workflows));
    }) as typeof fetch;

    render(<WorkflowsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit workflow Delivery flow' }));
    const saveButton = screen.getByRole('button', { name: 'Save Workflow' });
    fireEvent.click(saveButton);

    expect(await screen.findByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }));
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);

    await act(async () => mutationResponse.resolve(json({ message: 'Workflow validation failed' }, 422)));
    expect(await screen.findByText('Workflow validation failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Workflow' })).toHaveProperty('disabled', false);
  });

  it('supports delete cancellation and prevents duplicate deletes while a successful request is pending', async () => {
    const mutationResponse = deferred<Response>();
    global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') return mutationResponse.promise;
      if (String(input).endsWith('/api/agents')) return Promise.resolve(json(agents));
      return Promise.resolve(json(workflows));
    }) as typeof fetch;
    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValue(true);

    render(<WorkflowsPage />);
    const deleteButton = await screen.findByRole('button', { name: 'Delete workflow Delivery flow' });
    fireEvent.click(deleteButton);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);

    fireEvent.click(deleteButton);
    expect(await screen.findByRole('button', { name: 'Delete workflow Delivery flow' })).toHaveProperty('disabled', true);
    fireEvent.click(deleteButton);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);

    await act(async () => mutationResponse.resolve(json({ ok: true })));
    expect(await screen.findByText('Workflow deleted successfully.')).toBeTruthy();
  });
});

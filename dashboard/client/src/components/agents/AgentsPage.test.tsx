/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentConfig, CustomWorkflow } from '@devteam-dashboard/shared';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { AgentsPage } from './AgentsPage';

const agents: AgentConfig[] = [
  {
    id: 'planner', role: 'Delivery planner', objective: 'Plan delivery', model: 'gpt-5',
    thinking: 'high', tools: ['read'], outputs: ['plan.md'], runtime: 'codex',
    runtimeCommand: 'codex exec', instructions: 'Plan the work.',
  },
  {
    id: 'implementer', role: 'Implementer', objective: 'Implement approved plans', model: 'gpt-5',
    tools: ['read', 'write'], outputs: ['implementation.md'], runtime: 'generic',
    runtimeCommand: 'agent-run', instructions: 'Implement safely.',
  },
];
const workflows: CustomWorkflow[] = [{
  id: 'wf_delivery', name: 'Delivery flow', description: '', steps: ['planner'],
  context: '', needsFix: {}, version: 1,
}];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch(options: { workflowResponse?: Response; agentResponse?: Response; mutationResponse?: Response } = {}) {
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return options.mutationResponse?.clone() || json({ ok: true });
    if (String(input).endsWith('/api/workflows')) return options.workflowResponse?.clone() || json(workflows);
    return options.agentResponse?.clone() || json(agents);
  }) as typeof fetch;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const originalSetAgents = useDashboardStore.getState().setAgents;

describe('AgentsPage', () => {
  beforeEach(() => {
    installFetch();
    useDashboardStore.setState({ setAgents: originalSetAgents, agents: {} });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    useDashboardStore.setState({ setAgents: originalSetAgents, agents: {} });
    vi.restoreAllMocks();
  });

  it('shows capability metadata, runtime configuration, and workflow usage summaries', async () => {
    render(<AgentsPage />);

    expect(await screen.findByRole('heading', { name: 'planner' })).toBeTruthy();
    const overview = screen.getByRole('region', { name: 'Agent overview' });
    expect(within(overview).getByText('Agents').nextElementSibling?.textContent).toBe('2');
    expect(within(overview).getByText('Used by workflows').nextElementSibling?.textContent).toBe('1');
    expect(within(overview).getByText('Not referenced').nextElementSibling?.textContent).toBe('1');
    expect(screen.getByText('codex exec')).toBeTruthy();
    expect(screen.getByText(/Delivery flow/)).toBeTruthy();
    expect(screen.getByText('Not referenced by a workflow.')).toBeTruthy();
  });

  it('searches across runtime and capability fields and clears no-result state', async () => {
    render(<AgentsPage />);
    await screen.findByRole('heading', { name: 'planner' });
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'agent-run' } });

    expect(screen.queryByRole('heading', { name: 'planner' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'implementer' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'absent' } });
    expect(screen.getByText('No agents match your search')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset search' }));
    expect(screen.getByRole('heading', { name: 'planner' })).toBeTruthy();
  });

  it('preserves runtime fields when editing and synchronizes the refreshed catalog to the store', async () => {
    const setStoreAgents = vi.fn();
    useDashboardStore.setState({ setAgents: setStoreAgents });
    render(<AgentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit agent planner' }));

    expect(screen.getByLabelText('Agent ID').hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Runtime').getAttribute('value')).toBe('codex');
    expect(screen.getByLabelText('Runtime command').getAttribute('value')).toBe('codex exec');
    fireEvent.click(screen.getByRole('button', { name: 'Save Agent' }));

    await waitFor(() => {
      const putCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
        id: 'planner', runtime: 'codex', runtimeCommand: 'codex exec', tools: [], outputs: ['plan.md'],
      });
    });
    expect(await screen.findByText('Agent updated successfully.')).toBeTruthy();
    expect(setStoreAgents).toHaveBeenLastCalledWith(agents);
  });

  it('creates an agent without a per-agent tool allowlist', async () => {
    render(<AgentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create Agent' }));
    fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'reviewer' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Reviewer' } });
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Review changes' } });
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Runtime command'), { target: { value: 'claude run' } });
    fireEvent.change(screen.getByLabelText('Outputs'), { target: { value: 'review.md' } });
    fireEvent.change(screen.getByLabelText('Instructions prompt'), { target: { value: 'Review.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Agent' }));

    await waitFor(() => {
      const postCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
        id: 'reviewer', role: 'Reviewer', objective: 'Review changes', runtime: 'claude',
        runtimeCommand: 'claude run', tools: [], outputs: ['review.md'], instructions: 'Review.',
      });
    });
    expect(screen.queryByLabelText('Tools')).toBeNull();
  });

  it('keeps agents visible when workflow usage is unavailable', async () => {
    installFetch({ workflowResponse: json({ message: 'Unavailable' }, 503) });
    render(<AgentsPage />);

    expect(await screen.findByRole('heading', { name: 'planner' })).toBeTruthy();
    expect(screen.getByText(/Workflow usage cannot be calculated/)).toBeTruthy();
    expect(screen.getAllByText('Usage unavailable.')).toHaveLength(2);
  });

  it('surfaces delete API failures after confirmation', async () => {
    installFetch({ mutationResponse: json({ error: 'Agent is referenced by a workflow' }, 409) });
    render(<AgentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete agent planner' }));

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(await screen.findByText('Agent is referenced by a workflow')).toBeTruthy();
  });

  it('does not show unverified summary values while loading and then shows the empty catalog', async () => {
    const agentResponse = deferred<Response>();
    const workflowResponse = deferred<Response>();
    global.fetch = vi.fn((input: string | URL | Request) => (
      String(input).endsWith('/api/workflows') ? workflowResponse.promise : agentResponse.promise
    )) as typeof fetch;

    render(<AgentsPage />);

    expect(screen.getByRole('status').textContent).toContain('Loading agents');
    expect(screen.queryByRole('region', { name: 'Agent overview' })).toBeNull();

    await act(async () => {
      agentResponse.resolve(json([]));
      workflowResponse.resolve(json([]));
    });

    expect(await screen.findByText('No agents configured')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Agent overview' })).toBeTruthy();
  });

  it('retries a failed primary catalog request', async () => {
    let agentAttempts = 0;
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/workflows')) return json(workflows);
      agentAttempts += 1;
      return agentAttempts === 1 ? json({ message: 'Agent service unavailable' }, 503) : json(agents);
    }) as typeof fetch;

    render(<AgentsPage />);

    expect(await screen.findByText('Agent service unavailable')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Agent overview' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'planner' })).toBeTruthy();
    expect(agentAttempts).toBe(2);
  });

  it('prevents duplicate saves while pending and surfaces an API save failure', async () => {
    const mutationResponse = deferred<Response>();
    global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') return mutationResponse.promise;
      if (String(input).endsWith('/api/workflows')) return Promise.resolve(json(workflows));
      return Promise.resolve(json(agents));
    }) as typeof fetch;

    render(<AgentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit agent planner' }));
    const saveButton = screen.getByRole('button', { name: 'Save Agent' });
    fireEvent.click(saveButton);

    expect(await screen.findByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }));
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);

    await act(async () => mutationResponse.resolve(json({ error: 'Agent validation failed' }, 422)));
    expect(await screen.findByText('Agent validation failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Agent' })).toHaveProperty('disabled', false);
  });

  it('supports delete cancellation and prevents duplicate deletes while a successful request is pending', async () => {
    const mutationResponse = deferred<Response>();
    global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') return mutationResponse.promise;
      if (String(input).endsWith('/api/workflows')) return Promise.resolve(json(workflows));
      return Promise.resolve(json(agents));
    }) as typeof fetch;
    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValue(true);

    render(<AgentsPage />);
    const deleteButton = await screen.findByRole('button', { name: 'Delete agent planner' });
    fireEvent.click(deleteButton);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);

    fireEvent.click(deleteButton);
    expect(await screen.findByRole('button', { name: 'Delete agent planner' })).toHaveProperty('disabled', true);
    fireEvent.click(deleteButton);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);

    await act(async () => mutationResponse.resolve(json({ ok: true })));
    expect(await screen.findByText('Agent deleted successfully.')).toBeTruthy();
  });
});

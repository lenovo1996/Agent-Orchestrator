/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CustomWorkflow } from '@devteam-dashboard/shared';

import { useDashboardStore } from '../../store/use-dashboard-store';
import { NewTaskDialog } from './NewTaskDialog';

const longWorkflowName = 'A workflow name that is intentionally far too long for the native select popup';
const workflows: CustomWorkflow[] = [{
  id: 'long-workflow',
  name: longWorkflowName,
  description: '',
  steps: ['requirements_analyst', 'implementer', 'qa_verifier'],
  context: '',
  needsFix: {},
  version: 1,
}, {
  id: 'short-workflow',
  name: 'Short workflow',
  description: '',
  steps: ['planner'],
  context: '',
  needsFix: {},
  version: 1,
}];

describe('NewTaskDialog', () => {
  beforeEach(() => {
    useDashboardStore.setState({
      selectedWorkspaceId: 'workspace-1',
      orchestrationReady: true,
    });
    global.fetch = vi.fn(async () => new Response(JSON.stringify(workflows), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('wraps full workflow names and steps inside a bounded option list', async () => {
    render(<NewTaskDialog open onClose={vi.fn()} onSuccess={vi.fn()} />);

    const trigger = await screen.findByRole('combobox', { name: 'Workflow' });
    fireEvent.click(trigger);

    const listbox = screen.getByRole('listbox', { name: 'Workflow' });
    const option = screen.getAllByRole('option')[0];

    expect(listbox.className).toContain('w-full');
    expect(listbox.className).toContain('overflow-x-hidden');
    expect(option.textContent).toContain(longWorkflowName);
    expect(option.textContent).toContain('requirements_analyst → implementer → qa_verifier');
    expect(option.querySelectorAll('.break-words')).toHaveLength(2);
    expect(trigger.getAttribute('title')).toBe(
      `${longWorkflowName} (requirements_analyst → implementer → qa_verifier)`,
    );
    expect(option.getAttribute('title')).toBe(trigger.getAttribute('title'));

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe('new-task-workflow-option-1');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(trigger.getAttribute('title')).toBe('Short workflow (planner)');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});

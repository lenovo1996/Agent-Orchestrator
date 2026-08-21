/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionItem } from './SessionItem';

describe('SessionItem', () => {
  afterEach(cleanup);

  it('renders plan state and command completion metadata', () => {
    const { rerender } = render(<SessionItem
      item={{ id: 'plan', ordinal: 1, kind: 'plan', timestamp: '2026-08-17T00:00:00Z', plan: [{ step: 'Run tests', status: 'in_progress' }], hasDetail: false }}
      loadDetail={vi.fn()}
    />);
    expect(screen.getByText('Run tests')).toBeTruthy();
    expect(screen.getByText('in progress')).toBeTruthy();
    expect(screen.getByText('PLAN')).toBeTruthy();

    rerender(<SessionItem
      item={{ id: 'command', ordinal: 2, kind: 'command', timestamp: '2026-08-17T00:00:00Z', title: 'Command', command: 'npm test', status: 'completed', exitCode: 0, hasDetail: false }}
      loadDetail={vi.fn()}
    />);
    expect(screen.getByText('COMMAND')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('[completed]')).toBeTruthy();
    expect(screen.getByText('[exit 0]')).toBeTruthy();
  });

  it('expands generic tool and search cards through the lazy detail callback', () => {
    const loadDetail = vi.fn();
    const { rerender } = render(<SessionItem
      item={{ id: 'tool', ordinal: 3, kind: 'tool', timestamp: '2026-08-17T00:00:00Z', title: 'mcp__jira__get', status: 'completed', hasDetail: true }}
      loadDetail={loadDetail}
    />);
    fireEvent.click(screen.getByText('mcp__jira__get').closest('button')!);
    expect(loadDetail).toHaveBeenCalledWith(expect.objectContaining({ id: 'tool' }));

    rerender(<SessionItem key="search"
      item={{ id: 'search', ordinal: 4, kind: 'search', timestamp: '2026-08-17T00:00:00Z', title: 'Web search', text: 'Codex docs', status: 'completed', hasDetail: true }}
      detail={{ id: 'search', toolOutput: 'One result' }}
      loadDetail={loadDetail}
    />);
    fireEvent.click(screen.getByText('Web search').closest('button')!);
    expect(screen.getByText('One result')).toBeTruthy();
  });

  it('presents expanded tool request and response in one minimal structured region', () => {
    const fullCommand = 'npm run test --workspace=client -- src/components/session/SessionItem.test.tsx --reporter=verbose --coverage --runInBand';
    render(<SessionItem
      item={{
        id: 'tool-details', ordinal: 5, kind: 'tool', timestamp: '2026-08-17T00:00:00Z',
        title: 'mcp__jira__get_issue', toolName: 'mcp__jira__get_issue', status: 'completed', hasDetail: true,
      }}
      detail={{
        id: 'tool-details',
        toolInput: JSON.stringify({ cmd: fullCommand, key: 'ABC-123', fields: ['summary', 'status'] }),
        toolOutput: '[{"type":"text","text":"{\\"ok\\":true,\\"issue\\":{\\"summary\\":\\"Improve session tools\\"}}"}]',
      }}
      loadDetail={vi.fn()}
    />);

    fireEvent.click(screen.getByText('mcp__jira__get_issue').closest('button')!);

    const panel = screen.getByLabelText('Tool details: mcp__jira__get_issue');
    expect(panel.className).toBe('min-w-0');
    expect(panel.parentElement?.className).not.toContain('sm:pl-');
    expect(screen.queryByText('Tool exchange')).toBeNull();
    expect(screen.getByLabelText('Request')).toBeTruthy();
    expect(screen.getByLabelText('Response')).toBeTruthy();
    const request = screen.getByLabelText('Tool request');
    const response = screen.getByLabelText('Tool response');
    expect(screen.getByText('Key')).toBeTruthy();
    expect(screen.getByText('ABC-123')).toBeTruthy();
    expect(screen.getByText('Fields')).toBeTruthy();
    expect(screen.getByLabelText('2 list items')).toBeTruthy();
    expect(screen.getByText('Ok')).toBeTruthy();
    expect(screen.getByText('True')).toBeTruthy();
    expect(screen.getByText('Issue')).toBeTruthy();
    expect(screen.getByText('Summary')).toBeTruthy();
    expect(screen.getByText('Improve session tools')).toBeTruthy();
    expect(screen.queryByText('Content')).toBeNull();
    expect(screen.queryByText('Type')).toBeNull();
    expect(screen.queryByText('#1')).toBeNull();
    expect(screen.getByText('Cmd')).toBeTruthy();
    const compactCommand = screen.getByTitle(fullCommand);
    expect(compactCommand.textContent?.length).toBeLessThan(fullCommand.length);
    expect(compactCommand.textContent).toContain('…');
    expect(request.textContent).not.toContain('{');
    expect(response.textContent).not.toContain('{');
    expect(request.querySelector('pre')).toBeNull();
    expect(request.className).not.toContain('border');
    expect(response.querySelector('.rounded-md')).toBeNull();
    expect(response.className).toContain('max-h-[28rem]');
  });

  it('uses compact copy for assistant output while keeping user prompts at the normal size', () => {
    const { rerender } = render(<SessionItem
      item={{ id: 'assistant', ordinal: 1, kind: 'message', role: 'assistant', phase: 'commentary', text: 'Working on it', timestamp: '2026-08-17T00:00:00Z', hasDetail: false }}
      loadDetail={vi.fn()}
    />);
    expect(screen.getByLabelText('Session item: ASSISTANT').querySelector('.prose')?.className).toContain('prose-p:text-xs');

    rerender(<SessionItem
      item={{ id: 'user', ordinal: 2, kind: 'message', role: 'user', text: 'Please continue', timestamp: '2026-08-17T00:00:01Z', hasDetail: false }}
      loadDetail={vi.fn()}
    />);
    expect(screen.getByLabelText('Session item: YOU').querySelector('.prose')?.className).not.toContain('prose-p:text-xs');
  });

  it('renders emphasized THINK content with regular weight', () => {
    render(<SessionItem
      item={{
        id: 'reasoning', ordinal: 3, kind: 'reasoning', text: '**Inspecting the active turn**',
        timestamp: '2026-08-17T00:00:02Z', hasDetail: false,
      }}
      loadDetail={vi.fn()}
    />);

    const thinkItem = screen.getByLabelText('Session item: THINK');
    expect(thinkItem.querySelector('.prose strong')).toBeNull();
    expect(screen.getByText('Inspecting the active turn').className).toContain('font-normal');
    expect(screen.getByText('THINK').className).toContain('font-bold');
  });
});

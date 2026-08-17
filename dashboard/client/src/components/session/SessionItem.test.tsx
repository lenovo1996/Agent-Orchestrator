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

    rerender(<SessionItem
      item={{ id: 'command', ordinal: 2, kind: 'command', timestamp: '2026-08-17T00:00:00Z', title: 'Command', command: 'npm test', status: 'completed', exitCode: 0, hasDetail: false }}
      loadDetail={vi.fn()}
    />);
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByText('exit 0')).toBeTruthy();
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
});

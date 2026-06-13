/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoScroll } from './use-auto-scroll';

describe('useAutoScroll', () => {
  let mockElement: {
    scrollHeight: number;
    scrollTo: ReturnType<typeof vi.fn>;
  };
  let containerRef: { current: typeof mockElement | null };

  beforeEach(() => {
    mockElement = {
      scrollHeight: 500,
      scrollTo: vi.fn(),
    };
    containerRef = { current: mockElement as unknown as HTMLElement } as any;
  });

  it('scrolls to bottom when autoScroll is true and deps change', () => {
    const { rerender } = renderHook(
      ({ deps }) => useAutoScroll(containerRef as any, { autoScroll: true, deps }),
      { initialProps: { deps: [5] } },
    );

    expect(mockElement.scrollTo).toHaveBeenCalledWith({
      top: 500,
      behavior: 'smooth',
    });

    mockElement.scrollHeight = 800;
    mockElement.scrollTo.mockClear();

    rerender({ deps: [10] });

    expect(mockElement.scrollTo).toHaveBeenCalledWith({
      top: 800,
      behavior: 'smooth',
    });
  });

  it('does not scroll when autoScroll is false', () => {
    renderHook(() =>
      useAutoScroll(containerRef as any, { autoScroll: false, deps: [5] }),
    );

    expect(mockElement.scrollTo).not.toHaveBeenCalled();
  });

  it('stops scrolling when autoScroll transitions from true to false', () => {
    const { rerender } = renderHook(
      ({ autoScroll, deps }) =>
        useAutoScroll(containerRef as any, { autoScroll, deps }),
      { initialProps: { autoScroll: true, deps: [5] } },
    );

    expect(mockElement.scrollTo).toHaveBeenCalledTimes(1);
    mockElement.scrollTo.mockClear();

    rerender({ autoScroll: false, deps: [10] });

    expect(mockElement.scrollTo).not.toHaveBeenCalled();
  });

  it('resumes scrolling when autoScroll transitions from false to true', () => {
    const { rerender } = renderHook(
      ({ autoScroll, deps }) =>
        useAutoScroll(containerRef as any, { autoScroll, deps }),
      { initialProps: { autoScroll: false, deps: [5] } },
    );

    expect(mockElement.scrollTo).not.toHaveBeenCalled();

    rerender({ autoScroll: true, deps: [10] });

    expect(mockElement.scrollTo).toHaveBeenCalledWith({
      top: 500,
      behavior: 'smooth',
    });
  });

  it('handles null ref gracefully', () => {
    const nullRef = { current: null } as any;

    expect(() => {
      renderHook(() =>
        useAutoScroll(nullRef, { autoScroll: true, deps: [5] }),
      );
    }).not.toThrow();
  });

  it('returns scrollToBottom function', () => {
    const { result } = renderHook(() =>
      useAutoScroll(containerRef as any, { autoScroll: false, deps: [0] }),
    );

    expect(typeof result.current.scrollToBottom).toBe('function');

    // Manual call should scroll regardless of autoScroll state
    result.current.scrollToBottom();
    expect(mockElement.scrollTo).toHaveBeenCalledWith({
      top: 500,
      behavior: 'smooth',
    });
  });
});

import { useEffect, useCallback, type RefObject } from 'react';

export interface UseAutoScrollOptions {
  /** Whether auto-scroll is currently enabled */
  autoScroll: boolean;
  /** Dependencies that trigger a scroll check (e.g. lines.length) */
  deps?: unknown[];
}

/**
 * Hook to manage auto-scrolling behavior for a scrollable container.
 * Scrolls to bottom when new content arrives and autoScroll is enabled.
 *
 * Validates: Requirements 5.2, 5.3
 */
export function useAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  options: UseAutoScrollOptions,
) {
  const { autoScroll, deps = [] } = options;

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: 'smooth',
    });
  }, [containerRef]);

  // Auto-scroll to bottom when content changes and autoScroll is enabled
  useEffect(() => {
    if (autoScroll) {
      scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScroll, scrollToBottom, ...deps]);

  return { scrollToBottom };
}

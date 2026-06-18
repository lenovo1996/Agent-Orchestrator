import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { socket } from '@/lib/socket';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { LogLine } from './LogLine';

// In dev mode, Vite proxy handles /api routing so we use empty string (relative path).
const API_BASE = import.meta.env.VITE_API_URL || '';

/**
 * Realtime log viewer component with auto-scroll, socket subscription,
 * and a 1000-line buffer cap.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */
export function LogViewer() {
  const selectedFlowId = useDashboardStore((s) => s.selectedFlowId);
  const selectedStep = useDashboardStore((s) => s.selectedStep);
  const logBuffers = useDashboardStore((s) => s.logBuffers);
  const setLogBuffer = useDashboardStore((s) => s.setLogBuffer);
  const toggleAutoScroll = useDashboardStore((s) => s.toggleAutoScroll);

  const containerRef = useRef<HTMLDivElement>(null);

  const bufferKey = selectedFlowId && selectedStep
    ? `${selectedFlowId}:${selectedStep}`
    : null;

  const buffer = bufferKey ? logBuffers[bufferKey] : null;
  const lines = buffer?.lines ?? [];
  const autoScroll = buffer?.autoScroll ?? true;

  useAutoScroll(containerRef, { autoScroll, deps: [lines.length] });

  // Subscribe/unsubscribe to log events via socket + fetch initial log
  useEffect(() => {
    if (!selectedFlowId || !selectedStep) return;

    // Subscribe to realtime log events
    socket.emit('log:subscribe', { flowId: selectedFlowId, step: selectedStep });

    // Fetch initial log content via REST API
    const controller = new AbortController();
    fetch(`${API_BASE}/api/flows/${selectedFlowId}/logs/${selectedStep}`, {
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data: { lines: string[] }) => {
        if (data.lines && data.lines.length > 0) {
          setLogBuffer(selectedFlowId, selectedStep, data.lines);
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          console.error('[LogViewer] Failed to fetch initial logs:', err);
        }
      });

    return () => {
      controller.abort();
      socket.emit('log:unsubscribe', { flowId: selectedFlowId, step: selectedStep });
    };
  }, [selectedFlowId, selectedStep, setLogBuffer]);

  // Placeholder when no step is selected
  if (!selectedFlowId || !selectedStep) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a step to view logs
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with auto-scroll toggle */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <span className="text-xs text-muted-foreground font-medium">
          Logs — {selectedStep}
        </span>
        <button
          type="button"
          onClick={toggleAutoScroll}
          className={
            'text-xs px-2.5 py-1 rounded-md border transition-all duration-300 hover:scale-105 ' +
            (autoScroll
              ? 'bg-primary/20 border-primary/50 text-primary'
              : 'bg-muted border-border text-muted-foreground hover:text-foreground')
          }
        >
          Auto-scroll {autoScroll ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Log content area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto bg-muted/30 font-mono text-foreground"
      >
        {lines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            No log output yet
          </div>
        ) : (
          lines.map((line, idx) => (
            <LogLine key={idx} line={line} index={idx} />
          ))
        )}
      </div>
    </div>
  );
}

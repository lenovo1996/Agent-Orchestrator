import { useEffect, useRef, useState, useMemo } from 'react';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { socket } from '@/lib/socket';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { LogLine } from './LogLine';
import { LogBlockView } from './LogBlockView';
import { parseLogs } from '@/lib/log-parser';
import { Eye, FileCode2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// In dev mode, Vite proxy handles /api routing so we use empty string (relative path).
const API_BASE = import.meta.env.VITE_API_URL || '';
const MAX_VISIBLE_LOG_LINES = 1000;

/**
 * Realtime log viewer component with auto-scroll, socket subscription,
 * and support for Pretty/Raw toggle modes.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */
export function LogViewer() {
  const selectedFlowId = useDashboardStore((s) => s.selectedFlowId);
  const selectedStep = useDashboardStore((s) => s.selectedStep);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const workspaces = useDashboardStore((s) => s.workspaces);
  const logBuffers = useDashboardStore((s) => s.logBuffers);
  const setLogBuffer = useDashboardStore((s) => s.setLogBuffer);
  const toggleAutoScroll = useDashboardStore((s) => s.toggleAutoScroll);

  const [mode, setMode] = useState<'pretty' | 'raw'>('pretty');
  const containerRef = useRef<HTMLDivElement>(null);

  const bufferKey = selectedFlowId && selectedStep
    ? `${selectedFlowId}:${selectedStep}`
    : null;

  const buffer = bufferKey ? logBuffers[bufferKey] : null;
  const lines = buffer?.lines ?? [];
  const visibleStartLine = Math.max(0, lines.length - MAX_VISIBLE_LOG_LINES);
  const visibleLines = useMemo(
    () => lines.slice(visibleStartLine),
    [lines, visibleStartLine]
  );
  const autoScroll = buffer?.autoScroll ?? true;

  // Optimize parsing performance by memoizing parsed output
  const parsedBlocks = useMemo(() => {
    if (mode === 'raw' || lines.length === 0) return [];
    return parseLogs(lines, { visibleStartLine });
  }, [lines, mode, visibleStartLine]);

  useAutoScroll(containerRef, { autoScroll, deps: [visibleLines.length, lines.length] });

  // Subscribe/unsubscribe to log events via socket + fetch initial log
  useEffect(() => {
    if (!selectedFlowId || !selectedStep) return;

    // Subscribe to realtime log events
    socket.emit('log:subscribe', { flowId: selectedFlowId, step: selectedStep });

    // Fetch initial log content via REST API
    const controller = new AbortController();
    const workspaceName = workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.name;
    const query = workspaceName ? `?workspaceName=${encodeURIComponent(workspaceName)}` : '';
    fetch(
      `${API_BASE}/api/flows/${encodeURIComponent(selectedFlowId)}/logs/${encodeURIComponent(selectedStep)}${query}`,
      {
      signal: controller.signal,
      }
    )
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
  }, [selectedFlowId, selectedStep, selectedWorkspaceId, workspaces, setLogBuffer]);

  // Placeholder when no step is selected
  if (!selectedFlowId || !selectedStep) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground bg-muted/20">
        <div className="flex flex-col items-center gap-2">
          <FileCode2 className="w-8 h-8 text-muted-foreground/30" />
          <span>Select a step to view logs</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Header with auto-scroll toggle and view mode toggle */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/10">
        <div className="flex items-center gap-4">
          <div className="flex bg-muted/50 rounded p-0.5 border border-border/50">
            <button
              onClick={() => setMode('pretty')}
              className={cn(
                "px-2 py-0.5 text-[10px] font-medium rounded transition-colors flex items-center gap-1",
                mode === 'pretty' ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Eye className="w-3 h-3" /> PRETTY
            </button>
            <button
              onClick={() => setMode('raw')}
              className={cn(
                "px-2 py-0.5 text-[10px] font-medium rounded transition-colors flex items-center gap-1",
                mode === 'raw' ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <FileCode2 className="w-3 h-3" /> RAW
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={toggleAutoScroll}
          className={
            'text-[10px] uppercase font-medium px-2 py-1 rounded transition-colors ' +
            (autoScroll
              ? 'bg-primary/10 text-primary'
              : 'bg-muted/50 text-muted-foreground hover:text-foreground')
          }
        >
          Auto-scroll: {autoScroll ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Log content area */}
      <div
        ref={containerRef}
        className={cn(
          "flex-1 overflow-y-auto",
          mode === 'raw' ? "bg-muted/10 font-mono text-foreground" : "bg-background"
        )}
      >
        {visibleLines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            No log output yet
          </div>
        ) : mode === 'pretty' ? (
          <div className="flex flex-col">
            {parsedBlocks.map((block, idx) => (
              <LogBlockView key={idx} block={block} />
            ))}
          </div>
        ) : (
          <div className="py-2">
            {visibleLines.map((line, idx) => (
              <LogLine key={visibleStartLine + idx} line={line} index={visibleStartLine + idx} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

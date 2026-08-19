import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, Radio, Sparkles } from 'lucide-react';
import type {
  SessionAttemptSummary,
  SessionItemDetail,
  SessionItemSummary,
  SessionSnapshot,
  SessionSubscription,
} from '@devteam-dashboard/shared';
import { socket } from '@/lib/socket';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { SessionHeader } from './SessionHeader';
import { SessionItem } from './SessionItem';

const API_BASE = import.meta.env.VITE_API_URL || '';
const INACTIVITY_MS = 5 * 60_000;

function query(workspaceName: string | null): string {
  return workspaceName ? `?workspaceName=${encodeURIComponent(workspaceName)}` : '';
}

function sameSubscription(payload: SessionSubscription, subscription: SessionSubscription): boolean {
  return (payload.workspaceName || null) === subscription.workspaceName
    && payload.flowId === subscription.flowId
    && payload.step === subscription.step
    && payload.runId === subscription.runId;
}

function sortItems(items: SessionItemSummary[]): SessionItemSummary[] {
  return [...items].sort((a, b) => {
    if (a.ordinal !== null && b.ordinal !== null) return a.ordinal - b.ordinal;
    if (a.ordinal !== null) return -1;
    if (b.ordinal !== null) return 1;
    return a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
  });
}

function estimatedItemHeight(item: SessionItemSummary | undefined): number {
  if (!item) return 72;
  if (item.kind === 'message' || item.kind === 'reasoning') return 120;
  if (item.kind === 'plan') return 104;
  return item.outputPreview || item.text || item.filePaths?.length ? 82 : 62;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function WorkingIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Working..."
      className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 bg-blue-500/5 px-2 py-2 font-mono"
    >
      <span className="select-none text-[10px] font-semibold tracking-widest text-blue-600/60 dark:text-blue-400/60">LIVE</span>
      <span className="flex items-center gap-2 text-[11px] text-blue-700 dark:text-blue-300">
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-400" />
        </span>
        <span className="font-semibold tracking-wide">Working</span>
        <span className="flex items-end gap-0.5" aria-hidden="true">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              data-working-dot
              className="inline-block animate-bounce font-bold leading-none motion-reduce:animate-none"
              style={{ animationDelay: `${delay}ms` }}
            >
              .
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}

export function SessionViewer(_props: { fullscreen?: boolean }) {
  const selectedFlowId = useDashboardStore((state) => state.selectedFlowId);
  const selectedStep = useDashboardStore((state) => state.selectedStep);
  const selectedWorkspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const workspaces = useDashboardStore((state) => state.workspaces);
  const agent = useDashboardStore((state) => selectedStep ? state.agents[selectedStep] : undefined);
  const selectedFlow = useDashboardStore((state) => selectedFlowId ? state.flows[selectedFlowId] : undefined);
  const workspaceName = workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.name || null;
  const [attempts, setAttempts] = useState<SessionAttemptSummary[]>([]);
  const [runId, setRunId] = useState('');
  const [manualAttempt, setManualAttempt] = useState(false);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [details, setDetails] = useState<Record<string, SessionItemDetail>>({});
  const [loading, setLoading] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState('');
  const [showCommentary, setShowCommentary] = useState(true);
  const [showTools, setShowTools] = useState(true);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [followUpMessage, setFollowUpMessage] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [improving, setImproving] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);

  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 20;
    const maxLines = 7;
    const maxHeight = lineHeight * maxLines;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    autoResizeTextarea();
  }, [followUpMessage, autoResizeTextarea]);

  useEffect(() => {
    setManualAttempt(false);
    setAttempts([]);
    setRunId('');
    setSnapshot(null);
    setError('');
    nearBottom.current = true;
    setShowScrollToBottom(false);
  }, [selectedFlowId, selectedStep, workspaceName, selectedFlow?.revision]);

  useEffect(() => {
    if (!selectedFlowId || !selectedStep) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch(`${API_BASE}/api/flows/${encodeURIComponent(selectedFlowId)}/sessions/${encodeURIComponent(selectedStep)}${query(workspaceName)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (response.status === 503 || data.enabled === false) {
          setDisabled(true);
          setAttempts([]);
          return;
        }
        if (!response.ok) throw new Error(data.error || 'Failed to load session attempts');
        const next = data.attempts as SessionAttemptSummary[];
        setDisabled(false);
        setAttempts(next);
        setRunId((current) => {
          if (manualAttempt && next.some((attempt) => attempt.runId === current)) return current;
          return next.at(-1)?.runId || '';
        });
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError') setError(reason.message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [manualAttempt, selectedFlow?.revision, selectedFlowId, selectedStep, workspaceName]);

  useEffect(() => {
    if (!selectedFlowId || !selectedStep || !runId) return;
    const subscription: SessionSubscription = { workspaceName, flowId: selectedFlowId, step: selectedStep, runId };
    let active = true;

    const refresh = async () => {
      const response = await fetch(
        `${API_BASE}/api/flows/${encodeURIComponent(selectedFlowId)}/sessions/${encodeURIComponent(selectedStep)}/${encodeURIComponent(runId)}${query(workspaceName)}`,
      );
      if (!response.ok) throw new Error('Failed to load session');
      const data = await response.json() as SessionSnapshot;
      if (!data.attempt || !Array.isArray(data.items)) throw new Error('Invalid session snapshot');
      if (active) setSnapshot(data);
    };
    const connect = () => {
      void refresh().then(() => {
        if (active) socket.emit('session:subscribe', subscription);
      }).catch((reason) => active && setError(reason.message));
    };
    const upsert = (payload: SessionSubscription & { item: SessionItemSummary }) => {
      if (!sameSubscription(payload, subscription)) return;
      setSnapshot((current) => {
        if (!current) return current;
        const items = sortItems([...current.items.filter((item) => item.id !== payload.item.id), payload.item]);
        const files = new Set(items.flatMap((item) => item.filePaths || []));
        return {
          ...current,
          items,
          stats: {
            ...current.stats,
            turns: Math.max(current.stats.turns, items.filter((item) => item.kind === 'message' && item.role === 'user').length),
            commands: items.filter((item) => item.kind === 'command' || item.toolName === 'exec_command').length,
            patches: items.filter((item) => item.kind === 'patch').length,
            filesTouched: files.size,
          },
        };
      });
    };
    const updateAttempt = (payload: { workspaceName: string | null; flowId: string; step: string; attempt: SessionAttemptSummary }) => {
      if (payload.attempt.runId !== runId || payload.flowId !== selectedFlowId || payload.step !== selectedStep || (payload.workspaceName || null) !== workspaceName) return;
      setAttempts((current) => current.map((attempt) => attempt.runId === runId ? payload.attempt : attempt));
      setSnapshot((current) => current ? {
        ...current,
        attempt: payload.attempt,
        stats: {
          ...current.stats,
          usage: payload.attempt.usage || current.stats.usage,
          totalTokens: payload.attempt.usage
            ? payload.attempt.usage.inputTokens + payload.attempt.usage.outputTokens
            : current.stats.totalTokens,
        },
      } : current);
    };

    nearBottom.current = true;
    setShowScrollToBottom(false);
    setSnapshot(null);
    socket.on('session:item-upsert', upsert);
    socket.on('session:attempt-updated', updateAttempt);
    socket.io.on('reconnect', connect);
    connect();
    return () => {
      active = false;
      socket.emit('session:unsubscribe', subscription);
      socket.off('session:item-upsert', upsert);
      socket.off('session:attempt-updated', updateAttempt);
      socket.io.off('reconnect', connect);
    };
  }, [runId, selectedFlowId, selectedStep, workspaceName]);

  const visibleItems = useMemo(() => (snapshot?.items || []).filter((item) => {
    if (item.kind === 'reasoning') return showReasoning;
    if (item.kind === 'message') return item.role === 'user' || item.phase === 'final' || showCommentary;
    if (['command', 'patch', 'plan', 'search', 'tool', 'unknown'].includes(item.kind)) return showTools;
    return true;
  }), [showCommentary, showReasoning, showTools, snapshot?.items]);

  const getVirtualItemKey = useCallback((index: number) => visibleItems[index]?.id || index, [visibleItems]);
  const rowVirtualizer = useVirtualizer({
    count: visibleItems.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: getVirtualItemKey,
    estimateSize: (index) => {
      const item = visibleItems[index];
      const previous = visibleItems[index - 1];
      const gap = previous && item ? Date.parse(item.timestamp) - Date.parse(previous.timestamp) : 0;
      return estimatedItemHeight(item) + (gap >= INACTIVITY_MS ? 28 : 0);
    },
    overscan: 6,
    initialRect: { width: 800, height: 480 },
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualHeight = rowVirtualizer.getTotalSize();

  useEffect(() => {
    if (!nearBottom.current || !scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [snapshot?.attempt.status, virtualHeight, visibleItems.length]);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    nearBottom.current = true;
    setShowScrollToBottom(false);
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, []);

  const handleSendFollowUp = useCallback(async () => {
    if (!followUpMessage.trim() || !selectedFlowId || !selectedStep) return;
    setSendingFollowUp(true);
    setFollowUpError(null);
    try {
      const res = await fetch(`${API_BASE}/api/flows/${encodeURIComponent(selectedFlowId)}/steps/${encodeURIComponent(selectedStep)}/send-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: followUpMessage }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setFollowUpMessage('');
      } else {
        setFollowUpError(data.error || 'Failed to send message');
      }
    } catch {
      setFollowUpError('Failed to connect to server');
    } finally {
      setSendingFollowUp(false);
    }
  }, [followUpMessage, selectedFlowId, selectedStep]);

  const handleInterrupt = useCallback(async () => {
    if (!selectedFlowId || !selectedStep) return;
    try {
      await fetch(`${API_BASE}/api/flows/${encodeURIComponent(selectedFlowId)}/steps/${encodeURIComponent(selectedStep)}/interrupt`, {
        method: 'POST',
      });
    } catch { /* ignore */ }
  }, [selectedFlowId, selectedStep]);

  const handleImprovePrompt = useCallback(async () => {
    if (!followUpMessage.trim()) return;
    setImproving(true);
    setFollowUpError(null);
    try {
      const res = await fetch(`${API_BASE}/api/improve-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: followUpMessage }),
      });
      const data = await res.json();
      if (res.ok && data.improved) {
        setFollowUpMessage(data.improved);
      } else {
        setFollowUpError(data.error || 'Failed to improve prompt');
      }
    } catch {
      setFollowUpError('Failed to connect to server');
    } finally {
      setImproving(false);
    }
  }, [followUpMessage]);

  const loadDetail = useCallback((item: SessionItemSummary) => {
    const cacheKey = `${runId}:${item.id}`;
    if (!selectedFlowId || !selectedStep || !runId || details[cacheKey]) return;
    fetch(`${API_BASE}/api/flows/${encodeURIComponent(selectedFlowId)}/sessions/${encodeURIComponent(selectedStep)}/${encodeURIComponent(runId)}/items/${encodeURIComponent(item.id)}${query(workspaceName)}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Detail unavailable')))
      .then((detail: SessionItemDetail) => setDetails((current) => ({ ...current, [cacheKey]: detail })))
      .catch(() => setDetails((current) => ({ ...current, [cacheKey]: { id: item.id, output: 'Detail unavailable' } })));
  }, [details, runId, selectedFlowId, selectedStep, workspaceName]);

  if (!selectedFlowId || !selectedStep) return <EmptyState>Select an agent step to view its session.</EmptyState>;
  if (disabled) return <EmptyState>Session Viewer is disabled by server configuration.</EmptyState>;
  if (loading && attempts.length === 0) return <EmptyState>Loading session data…</EmptyState>;
  if (error && attempts.length === 0) return <EmptyState>{error}</EmptyState>;
  if (attempts.length === 0) {
    return <EmptyState>{agent?.runtime && agent.runtime !== 'codex'
      ? 'Structured session unavailable — this agent runtime does not create Codex sessions.'
      : 'Session data unavailable — flow created before Session Viewer.'}</EmptyState>;
  }
  if (!snapshot) return <EmptyState>Loading attempt…</EmptyState>;

  const preThreadFailure = snapshot.attempt.status === 'failed' && !snapshot.attempt.threadId;
  const unavailable = snapshot.attempt.threadId && !snapshot.rolloutAvailable;
  const isWorking = snapshot.attempt.status === 'starting' || snapshot.attempt.status === 'running';

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <SessionHeader
        attempt={snapshot.attempt}
        attempts={attempts}
        runId={runId}
        onAttemptChange={(value) => { setManualAttempt(true); setRunId(value); }}
        header={snapshot.header}
        stats={snapshot.stats}
        showCommentary={showCommentary}
        showTools={showTools}
        showReasoning={showReasoning}
        onToggleCommentary={() => setShowCommentary((value) => !value)}
        onToggleTools={() => setShowTools((value) => !value)}
        onToggleReasoning={() => setShowReasoning((value) => !value)}
      />

      {preThreadFailure ? (
        <EmptyState>
          <div><AlertText title="Codex failed before a session was created" text={snapshot.attempt.errorSummary?.message} />
            <div className="mt-2 text-xs">Exit code: {snapshot.attempt.exitCode ?? 'unknown'}</div></div>
        </EmptyState>
      ) : unavailable ? (
        <EmptyState>Rollout no longer available.</EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              aria-label="Session transcript"
              onScroll={(event) => {
                const element = event.currentTarget;
                const isNearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
                nearBottom.current = isNearBottom;
                setShowScrollToBottom(!isNearBottom);
              }}
              className="min-h-0 flex-1 overflow-y-auto bg-zinc-100 text-foreground dark:bg-[#090b0f]"
            >
              <div className="mx-auto min-h-full max-w-6xl border-x border-border bg-background shadow-inner shadow-black/5 dark:shadow-black/30">
                {visibleItems.length === 0 && !isWorking ? (
                  <div className="py-10 text-center font-mono text-[11px] text-muted-foreground">no visible session items</div>
                ) : (
                  <div
                    data-testid="virtual-session-list"
                    className="relative w-full"
                    style={{ height: `${virtualHeight}px` }}
                  >
                    {virtualRows.map((virtualRow) => {
                      const item = visibleItems[virtualRow.index];
                      const previous = visibleItems[virtualRow.index - 1];
                      const gap = previous ? Date.parse(item.timestamp) - Date.parse(previous.timestamp) : 0;
                      return (
                        <div
                          key={virtualRow.key}
                          id={`session-${item.id}`}
                          data-index={virtualRow.index}
                          ref={rowVirtualizer.measureElement}
                          className="absolute left-0 top-0 w-full border-b border-border"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                          {gap >= INACTIVITY_MS && (
                            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
                              <span className="h-px flex-1 bg-border" /><Radio className="h-3 w-3" /> idle {Math.round(gap / 60_000)}m<span className="h-px flex-1 bg-border" />
                            </div>
                          )}
                          <SessionItem item={item} detail={details[`${runId}:${item.id}`]} loadDetail={loadDetail} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {showScrollToBottom && (
              <button
                type="button"
                aria-label="Scroll to bottom"
                title="Scroll to bottom"
                onClick={scrollToBottom}
                className={`absolute right-3 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground shadow-lg shadow-black/10 backdrop-blur transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isWorking ? 'bottom-16' : 'bottom-3'}`}
              >
                <ArrowDownToLine className="h-4 w-4" />
              </button>
            )}
            {isWorking && (
              <div data-session-working-dock className="shrink-0 border-t border-border bg-muted/40 dark:bg-zinc-950">
                <div className="mx-auto max-w-6xl">
                  <div className="flex items-center gap-2 px-3 py-1 text-[10px] font-mono text-muted-foreground border-b border-border">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    </span>
                    agent running
                  </div>
                  <div className="flex items-start gap-0 px-3 py-2">
                    <span className="mt-1.5 shrink-0 font-mono text-sm text-emerald-500 select-none">❯</span>
                    <textarea
                      ref={textareaRef}
                      value={followUpMessage}
                      onChange={(e) => setFollowUpMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void handleSendFollowUp();
                        }
                      }}
                      placeholder="type a message..."
                      disabled={sendingFollowUp}
                      rows={1}
                      className="flex-1 ml-2 px-0 py-1 text-sm font-mono bg-transparent border-0 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-0 disabled:opacity-50 resize-none leading-5"
                    />
                    <div className="flex items-center gap-1 mt-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={handleImprovePrompt}
                        disabled={improving || !followUpMessage.trim()}
                        title="Improve prompt (AI)"
                        className="p-1 rounded text-purple-500/70 hover:text-purple-500 hover:bg-purple-500/10 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                      >
                        {improving ? (
                          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={handleSendFollowUp}
                        disabled={sendingFollowUp || !followUpMessage.trim()}
                        className="px-2 py-1 text-[11px] font-mono font-medium text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                      >
                        {sendingFollowUp ? '...' : '⏎'}
                      </button>
                    </div>
                  </div>
                  {followUpError && (
                    <div className="px-3 pb-1.5 text-[11px] font-mono text-red-500">{followUpError}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AlertText({ title, text }: { title: string; text?: string }) {
  return <div className="max-w-lg rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-left"><strong className="text-red-500">{title}</strong>{text && <p className="mt-2 text-sm text-muted-foreground">{text}</p>}</div>;
}

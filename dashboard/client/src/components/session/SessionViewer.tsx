import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, ChevronDown, MessageSquareText, Radio, Wrench } from 'lucide-react';
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

function AttemptSelector({ attempts, value, onChange }: {
  attempts: SessionAttemptSummary[];
  value: string;
  onChange: (runId: string) => void;
}) {
  return (
    <label className="relative inline-flex min-w-0 items-center">
      <span className="sr-only">Attempt</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 max-w-56 appearance-none rounded-md border border-border bg-background pl-2 pr-7 text-xs font-medium outline-none focus:ring-1 focus:ring-ring"
      >
        {attempts.map((attempt, index) => (
          <option key={attempt.runId} value={attempt.runId}>
            Attempt {index + 1} · {attempt.status} · {new Date(attempt.startedAt).toLocaleTimeString()}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground" />
    </label>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

export function SessionViewer({ fullscreen = false }: { fullscreen?: boolean }) {
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  useEffect(() => {
    setManualAttempt(false);
    setAttempts([]);
    setRunId('');
    setSnapshot(null);
    setError('');
  }, [selectedFlowId, selectedStep, workspaceName]);

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
  }, [manualAttempt, selectedFlow?.retries, selectedFlow?.steps, selectedFlowId, selectedStep, workspaceName]);

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
            commands: items.filter((item) => item.kind === 'command').length,
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

  useEffect(() => {
    if (!nearBottom.current || !scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [visibleItems]);

  const turns = useMemo(() => visibleItems.filter((item) => item.kind === 'message' && item.role === 'user'), [visibleItems]);
  const goToTurn = (id: string) => document.getElementById(`session-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <AttemptSelector attempts={attempts} value={runId} onChange={(value) => { setManualAttempt(true); setRunId(value); }} />
        <div className="ml-auto flex flex-wrap gap-1">
          <button type="button" onClick={() => setShowCommentary((value) => !value)} className={`session-toggle ${showCommentary ? 'session-toggle-active' : ''}`}><MessageSquareText className="h-3 w-3" /> Commentary</button>
          <button type="button" onClick={() => setShowTools((value) => !value)} className={`session-toggle ${showTools ? 'session-toggle-active' : ''}`}><Wrench className="h-3 w-3" /> Tools</button>
          <button type="button" onClick={() => setShowReasoning((value) => !value)} className={`session-toggle ${showReasoning ? 'session-toggle-active' : ''}`}><BrainCircuit className="h-3 w-3" /> Reasoning</button>
        </div>
      </div>
      <SessionHeader attempt={snapshot.attempt} header={snapshot.header} stats={snapshot.stats} />

      {preThreadFailure ? (
        <EmptyState>
          <div><AlertText title="Codex failed before a session was created" text={snapshot.attempt.errorSummary?.message} />
            <div className="mt-2 text-xs">Exit code: {snapshot.attempt.exitCode ?? 'unknown'}</div></div>
        </EmptyState>
      ) : unavailable ? (
        <EmptyState>Rollout no longer available.</EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1">
          {fullscreen && turns.length > 0 && (
            <nav className="hidden w-52 shrink-0 overflow-auto border-r border-border/60 p-2 lg:block">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Turns</div>
              {turns.map((turn, index) => (
                <button key={turn.id} type="button" onClick={() => goToTurn(turn.id)} className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                  {index + 1}. {(turn.text || 'User message').replace(/\s+/g, ' ')}
                </button>
              ))}
            </nav>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            {turns.length > 0 && (
              <div className={`${fullscreen ? 'lg:hidden' : ''} border-b border-border/50 px-3 py-2`}>
                <select onChange={(event) => goToTurn(event.target.value)} defaultValue="" className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs">
                  <option value="" disabled>Jump to turn…</option>
                  {turns.map((turn, index) => <option key={turn.id} value={turn.id}>Turn {index + 1}: {(turn.text || '').replace(/\s+/g, ' ').slice(0, 80)}</option>)}
                </select>
              </div>
            )}
            <div
              ref={scrollRef}
              aria-label="Session transcript"
              onScroll={(event) => {
                const element = event.currentTarget;
                nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
              }}
              className="min-h-0 flex-1 overflow-y-auto p-3"
            >
              {visibleItems.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">No visible session items.</div>
              ) : (
                <div className="mx-auto max-w-5xl space-y-3">
                  {visibleItems.map((item, index) => {
                    const previous = visibleItems[index - 1];
                    const gap = previous ? Date.parse(item.timestamp) - Date.parse(previous.timestamp) : 0;
                    return (
                      <div key={item.id} id={`session-${item.id}`} className="scroll-mt-3">
                        {gap >= INACTIVITY_MS && (
                          <div className="my-3 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                            <span className="h-px flex-1 bg-border" /><Radio className="h-3 w-3" /> inactive {Math.round(gap / 60_000)} min<span className="h-px flex-1 bg-border" />
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
        </div>
      )}
    </div>
  );
}

function AlertText({ title, text }: { title: string; text?: string }) {
  return <div className="max-w-lg rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-left"><strong className="text-red-500">{title}</strong>{text && <p className="mt-2 text-sm text-muted-foreground">{text}</p>}</div>;
}

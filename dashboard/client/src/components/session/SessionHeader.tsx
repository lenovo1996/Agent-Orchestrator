import { useState } from 'react';
import {
  Activity,
  BrainCircuit,
  ChevronDown,
  Clock3,
  FileCode2,
  GitPullRequestArrow,
  MessageSquareText,
  TerminalSquare,
  Waypoints,
  Wrench,
} from 'lucide-react';
import type { SessionAttemptSummary, SessionHeader as Header, SessionStats } from '@devteam-dashboard/shared';
import { formatTokens } from '@/lib/format';

function duration(value: number | null): string {
  if (value === null) return '—';
  const seconds = Math.max(0, Math.round(value / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function AttemptSelector({ attempts, value, onChange }: {
  attempts: SessionAttemptSummary[];
  value: string;
  onChange: (runId: string) => void;
}) {
  return (
    <label className="relative inline-flex min-w-0 shrink-0 items-center">
      <span className="sr-only">Attempt</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-40 appearance-none truncate rounded-md border border-border bg-background pl-2 pr-6 text-[11px] font-medium outline-none focus:ring-1 focus:ring-ring"
      >
        {attempts.map((attempt, index) => (
          <option key={attempt.runId} value={attempt.runId}>
            Attempt {index + 1} · {attempt.status} · {new Date(attempt.startedAt).toLocaleTimeString()}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground" />
    </label>
  );
}

function FilterButton({ active, label, icon: Icon, onClick }: {
  active: boolean;
  label: string;
  icon: typeof MessageSquareText;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Toggle ${label.toLowerCase()}`}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={`session-icon-toggle ${active ? 'session-toggle-active' : ''}`}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="session-toggle-label">{label}</span>
    </button>
  );
}

export function SessionHeader({
  attempt,
  attempts,
  runId,
  onAttemptChange,
  header,
  stats,
  showCommentary,
  showTools,
  showReasoning,
  onToggleCommentary,
  onToggleTools,
  onToggleReasoning,
}: {
  attempt: SessionAttemptSummary;
  attempts: SessionAttemptSummary[];
  runId: string;
  onAttemptChange: (runId: string) => void;
  header: Header | null;
  stats: SessionStats;
  showCommentary: boolean;
  showTools: boolean;
  showReasoning: boolean;
  onToggleCommentary: () => void;
  onToggleTools: () => void;
  onToggleReasoning: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const compactMetrics = [
    { icon: Waypoints, label: 'Turns', value: stats.turns },
    { icon: TerminalSquare, label: 'Commands', value: stats.commands },
    { icon: Clock3, label: 'Total', value: duration(header?.totalDurationMs ?? null) },
  ];
  const statusColor = attempt.status === 'failed'
    ? 'bg-red-500'
    : attempt.status === 'completed'
      ? 'bg-emerald-500'
      : 'bg-blue-500';

  return (
    <header className="session-header shrink-0 border-b border-border/60 bg-card/40">
      <div className="flex h-10 min-w-0 items-center gap-1.5 px-2">
        <AttemptSelector attempts={attempts} value={runId} onChange={onAttemptChange} />

        <span className="mx-0.5 h-4 w-px shrink-0 bg-border/70" />
        <div className="session-header-identity min-w-0 items-center gap-1.5 text-[11px]">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusColor}`} title={attempt.status} />
          <strong className="max-w-36 truncate text-foreground">{header?.model || 'Codex session'}</strong>
          {header?.cliVersion && <span className="shrink-0 text-muted-foreground">CLI {header.cliVersion}</span>}
          <span className="sr-only">Status: {attempt.status}</span>
        </div>

        <div className="session-header-metrics min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          {compactMetrics.map(({ icon: Icon, label, value }) => (
            <span key={label} title={label} className="inline-flex shrink-0 items-center gap-1">
              <Icon className="h-3 w-3" />
              <strong className="font-medium text-foreground">{value}</strong>
            </span>
          ))}
          <span title="Total tokens" className="shrink-0">
            <strong className="font-medium text-foreground">{formatTokens(stats.totalTokens)}</strong> tok
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <FilterButton active={showCommentary} label="Commentary" icon={MessageSquareText} onClick={onToggleCommentary} />
          <FilterButton active={showTools} label="Tools" icon={Wrench} onClick={onToggleTools} />
          <FilterButton active={showReasoning} label="Reasoning" icon={BrainCircuit} onClick={onToggleReasoning} />
          <button
            type="button"
            aria-label="Session details"
            aria-expanded={detailsOpen}
            title="Session details"
            onClick={() => setDetailsOpen((value) => !value)}
            className="session-icon-toggle"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {detailsOpen && (
        <div className="flex min-h-8 items-center gap-3 overflow-x-auto border-t border-border/50 px-2 py-1 text-[10px] text-muted-foreground">
          <span className="shrink-0">Started <strong className="font-medium text-foreground">{dateTime(attempt.startedAt)}</strong></span>
          <span className="inline-flex shrink-0 items-center gap-1"><Activity className="h-3 w-3" /> Active <strong className="font-medium text-foreground">{duration(header?.activeDurationMs ?? null)}</strong></span>
          <span className="inline-flex shrink-0 items-center gap-1"><GitPullRequestArrow className="h-3 w-3" /> Patches <strong className="font-medium text-foreground">{stats.patches}</strong></span>
          <span className="inline-flex shrink-0 items-center gap-1"><FileCode2 className="h-3 w-3" /> Files <strong className="font-medium text-foreground">{stats.filesTouched}</strong></span>
          {stats.usage && (
            <span className="shrink-0">
              Tokens <strong className="font-medium text-foreground">{formatTokens(stats.usage.inputTokens)} in · {formatTokens(stats.usage.outputTokens)} out</strong>
              {' · '}{formatTokens(stats.usage.cachedInputTokens)} cached · {formatTokens(stats.usage.reasoningOutputTokens)} reasoning
            </span>
          )}
          {attempt.exitCode !== null && <span className="shrink-0">Exit <strong className="font-medium text-foreground">{attempt.exitCode}</strong></span>}
        </div>
      )}
    </header>
  );
}

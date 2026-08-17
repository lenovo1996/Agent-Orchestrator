import { Activity, Clock3, FileCode2, GitPullRequestArrow, TerminalSquare, Waypoints } from 'lucide-react';
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

export function SessionHeader({
  attempt,
  header,
  stats,
}: {
  attempt: SessionAttemptSummary;
  header: Header | null;
  stats: SessionStats;
}) {
  const metrics = [
    { icon: Waypoints, label: 'Turns', value: stats.turns },
    { icon: TerminalSquare, label: 'Commands', value: stats.commands },
    { icon: GitPullRequestArrow, label: 'Patches', value: stats.patches },
    { icon: FileCode2, label: 'Files', value: stats.filesTouched },
    { icon: Clock3, label: 'Total', value: duration(header?.totalDurationMs ?? null) },
    { icon: Activity, label: 'Active', value: duration(header?.activeDurationMs ?? null) },
  ];

  return (
    <div className="border-b border-border/60 bg-card/40 px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold text-foreground">{header?.model || 'Codex session'}</span>
        {header?.cliVersion && <span className="text-muted-foreground">CLI {header.cliVersion}</span>}
        <span className="text-muted-foreground">Started {dateTime(attempt.startedAt)}</span>
        <span className={`rounded-full px-2 py-0.5 font-medium ${
          attempt.status === 'failed'
            ? 'bg-red-500/15 text-red-500'
            : attempt.status === 'completed'
              ? 'bg-emerald-500/15 text-emerald-500'
              : 'bg-blue-500/15 text-blue-500'
        }`}>
          {attempt.status}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {metrics.map(({ icon: Icon, label, value }) => (
          <span key={label} className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">
            <Icon className="h-3 w-3" /> {label} <strong className="text-foreground">{value}</strong>
          </span>
        ))}
        <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">
          Tokens <strong className="text-foreground">{formatTokens(stats.totalTokens)}</strong>
          {stats.usage && (
            <span title="Cached input / reasoning output">
              ({formatTokens(stats.usage.cachedInputTokens)} cached · {formatTokens(stats.usage.reasoningOutputTokens)} reasoning)
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

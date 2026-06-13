import { useDashboardStore } from '@/store/use-dashboard-store';
import { QueueList } from './QueueList';

export function ParallelOverview() {
  const parallelStatus = useDashboardStore((s) => s.parallelStatus);

  if (!parallelStatus) {
    return null;
  }

  const { running, queue, completed, maxConcurrency } = parallelStatus;

  return (
    <div className="rounded-xl border border-border/50 bg-card/60 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          Parallel Execution
        </h3>
        <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
          max {maxConcurrency}
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-blue-500/10 border border-blue-500/15 px-2.5 py-2 text-center">
          <div className="text-lg font-bold text-blue-400 leading-tight">{running.length}</div>
          <div className="text-[10px] text-blue-400/70">Running</div>
        </div>
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/15 px-2.5 py-2 text-center">
          <div className="text-lg font-bold text-amber-400 leading-tight">{queue.length}</div>
          <div className="text-[10px] text-amber-400/70">Queued</div>
        </div>
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/15 px-2.5 py-2 text-center">
          <div className="text-lg font-bold text-emerald-400 leading-tight">{completed.length}</div>
          <div className="text-[10px] text-emerald-400/70">Done</div>
        </div>
      </div>

      {/* Queue details */}
      <QueueList running={running} queue={queue} />
    </div>
  );
}

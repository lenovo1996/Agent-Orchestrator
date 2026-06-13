import { useEffect, useState } from 'react';
import type { ParallelTask } from '@devteam-dashboard/shared';
import { formatElapsedTime } from '@/lib/format';

interface QueueListProps {
  running: ParallelTask[];
  queue: ParallelTask[];
}

export function QueueList({ running, queue }: QueueListProps) {
  const [now, setNow] = useState(() => new Date());

  // Update elapsed times every second
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-3">
      {/* Running section */}
      {running.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
            Running
          </h4>
          <ul className="space-y-1">
            {running.map((task) => (
              <li
                key={task.flowId}
                className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs bg-blue-500/10"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
                  <span className="truncate font-medium" title={task.repo}>
                    {task.repo}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground truncate">{task.step}</span>
                </div>
                <span className="text-muted-foreground whitespace-nowrap">
                  {task.startedAt ? formatElapsedTime(task.startedAt, now) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Queued section */}
      {queue.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
            Queued
          </h4>
          <ul className="space-y-1">
            {queue.map((task, index) => (
              <li
                key={task.flowId}
                className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs bg-yellow-500/10"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-muted-foreground font-mono w-4 shrink-0 text-right">
                    {index + 1}
                  </span>
                  <span className="truncate font-medium" title={task.repo}>
                    {task.repo}
                  </span>
                </div>
                <span className="text-muted-foreground whitespace-nowrap">
                  {formatElapsedTime(task.queuedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Empty state */}
      {running.length === 0 && queue.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-2">
          No active or queued flows
        </p>
      )}
    </div>
  );
}

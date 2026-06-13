import type { WorkflowState, FlowStatus } from '@devteam-dashboard/shared';
import { Badge } from '@/components/ui/badge';
import { StepIndicator } from './StepIndicator';
import { formatElapsedTime } from '@/lib/format';
import { STEP_DISPLAY_NAMES } from '@/lib/constants';
import { cn } from '@/lib/utils';

interface FlowCardProps {
  flow: WorkflowState;
  isSelected: boolean;
  onSelect: (flowId: string) => void;
}

const FLOW_STATUS_CONFIG: Record<FlowStatus, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-400 animate-pulse' },
  completed: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  failed: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
  blocked: { bg: 'bg-purple-500/10', text: 'text-purple-400', dot: 'bg-purple-400' },
  stopped: { bg: 'bg-amber-500/10', text: 'text-amber-400', dot: 'bg-amber-400' },
};

export function FlowCard({ flow, isSelected, onSelect }: FlowCardProps) {
  const totalNeedsFix = flow.needsFixCount
    ? Object.values(flow.needsFixCount).reduce((sum, n) => sum + n, 0)
    : 0;
  const statusConfig = FLOW_STATUS_CONFIG[flow.status];

  return (
    <div
      data-flow-card
      className={cn(
        'group relative rounded-xl p-3.5 transition-all duration-200 cursor-pointer',
        'border border-border/50 hover:border-border',
        'bg-card/60 hover:bg-card',
        isSelected && 'border-primary/50 bg-primary/5 glow-sm'
      )}
      onClick={() => onSelect(flow.flowId)}
    >
      {/* Top row: Jira key + status */}
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <span className="text-sm font-semibold text-foreground">
          {flow.jiraKey}
        </span>
        <div className={cn(
          'flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border',
          statusConfig.bg, statusConfig.text,
          `border-current/20`
        )}>
          <span className={cn('h-1.5 w-1.5 rounded-full', statusConfig.dot)} />
          {flow.status}
        </div>
      </div>

      {/* Current step */}
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-xs text-muted-foreground">
          {STEP_DISPLAY_NAMES[flow.currentStep]}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/70" title={flow.flowId}>
          {flow.flowId.replace('flow_', '').slice(0, 14)}
        </span>
      </div>

      {/* Step indicators + Progress */}
      <div className="space-y-2 mb-2.5">
        <StepIndicator steps={flow.steps} />
      </div>

      {/* Footer: elapsed time + needsFix */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {flow.stoppedAt
            ? formatElapsedTime(flow.startedAt, new Date(flow.stoppedAt))
            : flow.status === 'running'
              ? formatElapsedTime(flow.startedAt)
              : '—'}
        </span>
        {totalNeedsFix > 0 && (
          <span className="text-amber-400 flex items-center gap-0.5">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
            {totalNeedsFix}
          </span>
        )}
      </div>

      {/* Blocked reason */}
      {flow.status === 'blocked' && flow.blockedReason && (
        <div className="mt-2.5 text-[11px] text-purple-300 bg-purple-500/10 border border-purple-500/20 rounded-lg px-2.5 py-1.5">
          ⚠ {flow.blockedReason}
        </div>
      )}
    </div>
  );
}

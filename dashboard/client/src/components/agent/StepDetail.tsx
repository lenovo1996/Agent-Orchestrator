import type { AgentStep, StepStatus, WorkflowState } from '@devteam-dashboard/shared';
import { STATUS_COLORS, STEP_DISPLAY_NAMES } from '@/lib/constants';
import { formatTokens } from '@/lib/format';
import { cn } from '@/lib/utils';

interface StepDetailProps {
  step: AgentStep;
  status: StepStatus;
  flow: WorkflowState;
  isSelected: boolean;
  onSelect: (step: AgentStep) => void;
}

/**
 * Renders detail row for a single agent step within the AgentPanel.
 * Shows status indicator (with animated pulse for running), step name,
 * token count, retry count, and needsFix count.
 */
export function StepDetail({ step, status, flow, isSelected, onSelect }: StepDetailProps) {
  const retryCount = flow.retries?.[step] ?? 0;
  const needsFixCount = flow.needsFixCount?.[step] ?? 0;
  // Token count placeholder — actual values come from log parsing
  const tokenCount = 0;

  return (
    <button
      type="button"
      onClick={() => onSelect(step)}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
        'hover:bg-accent/50',
        isSelected && 'bg-accent ring-1 ring-primary/50'
      )}
    >
      {/* Status dot */}
      <div
        className={cn(
          'h-3 w-3 shrink-0 rounded-full transition-colors',
          STATUS_COLORS[status] || 'bg-gray-400'
        )}
        aria-label={`${STEP_DISPLAY_NAMES[step]} status: ${status}`}
      />

      {/* Step name */}
      <span className="flex-1 text-sm font-medium text-foreground">
        {STEP_DISPLAY_NAMES[step]}
      </span>

      {/* Badges area */}
      <div className="flex items-center gap-2">
        {/* Token count */}
        <span className="text-xs font-mono text-muted-foreground">
          {formatTokens(tokenCount)}
        </span>

        {/* Retry count */}
        {retryCount > 0 && (
          <span className="inline-flex items-center rounded-full bg-yellow-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-400">
            ↻ {retryCount}
          </span>
        )}

        {/* NeedsFix count */}
        {needsFixCount > 0 && (
          <span className="inline-flex items-center rounded-full bg-orange-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-orange-400">
            🔧 {needsFixCount}
          </span>
        )}
      </div>
    </button>
  );
}

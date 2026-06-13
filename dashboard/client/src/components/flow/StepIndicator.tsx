import type { AgentStep, StepStatus } from '@devteam-dashboard/shared';
import { AGENT_STEPS, STEP_DISPLAY_NAMES } from '@/lib/constants';
import { cn } from '@/lib/utils';

interface StepIndicatorProps {
  steps: Record<AgentStep, StepStatus>;
  stepOrder?: string[];
}

const DOT_COLORS: Record<StepStatus, string> = {
  waiting: 'bg-gray-600',
  pending: 'bg-gray-500',
  running: 'bg-blue-400 animate-pulse shadow-sm shadow-blue-400/50',
  done: 'bg-emerald-400',
  failed: 'bg-red-400',
  blocked: 'bg-purple-400',
  cancelled: 'bg-gray-600',
  retrying: 'bg-amber-400 animate-pulse',
  unknown: 'bg-gray-500',
};

export function StepIndicator({ steps, stepOrder }: StepIndicatorProps) {
  const activeSteps = stepOrder || AGENT_STEPS;
  return (
    <div className="flex items-center gap-1">
      {activeSteps.map((step, idx) => (
        <div key={step} className="flex items-center">
          <div
            className={cn('h-2 w-2 rounded-full transition-colors', DOT_COLORS[steps[step]] || 'bg-gray-600')}
            title={`${STEP_DISPLAY_NAMES[step] || step}: ${steps[step]}`}
          />
          {idx < activeSteps.length - 1 && (
            <div className={cn(
              'h-px w-2 mx-0.5',
              steps[step] === 'done' ? 'bg-emerald-500/50' : 'bg-border'
            )} />
          )}
        </div>
      ))}
    </div>
  );
}

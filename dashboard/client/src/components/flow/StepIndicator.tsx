import type { AgentStep, StepStatus } from '@devteam-dashboard/shared';
import { AGENT_STEPS, getStepDisplayName } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useDashboardStore } from '@/store/use-dashboard-store';

interface StepIndicatorProps {
  steps: Record<AgentStep, StepStatus>;
  stepOrder?: string[];
}

const SEGMENT_COLORS: Record<StepStatus, string> = {
  waiting: 'bg-muted',
  queued: 'bg-sky-400 animate-pulse motion-reduce:animate-none',
  running: 'bg-blue-500 animate-pulse motion-reduce:animate-none',
  needs_fix: 'bg-amber-400',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  blocked: 'bg-purple-500',
  cancelled: 'bg-zinc-500',
  retrying: 'bg-amber-400 animate-pulse motion-reduce:animate-none',
};

export function StepIndicator({ steps, stepOrder }: StepIndicatorProps) {
  const agents = useDashboardStore((s) => s.agents);
  const activeSteps = stepOrder || AGENT_STEPS;
  return (
    <div className="flex h-1 w-10 shrink-0 items-center gap-0.5" aria-label="Step progress">
      {activeSteps.map((step) => (
        <span
          key={step}
          className={cn('h-1 min-w-1 flex-1 rounded-full transition-colors', SEGMENT_COLORS[steps[step]] || 'bg-muted')}
          title={`${getStepDisplayName(step, agents)}: ${steps[step] || 'waiting'}`}
        />
      ))}
    </div>
  );
}

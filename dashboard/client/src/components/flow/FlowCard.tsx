import { useState } from 'react';
import { AlertTriangle, Clock3, Trash2, Wrench } from 'lucide-react';
import type { FlowStatus, WorkflowState } from '@devteam-dashboard/shared';
import { formatElapsedTime } from '@/lib/format';
import { getStepDisplayName } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { DeleteFlowDialog } from './DeleteFlowDialog';
import { StepIndicator } from './StepIndicator';

interface FlowCardProps {
  flow: WorkflowState;
  isSelected: boolean;
  onSelect: (flowId: string) => void;
}

const FLOW_STATUS_CONFIG: Record<FlowStatus, { text: string; dot: string }> = {
  queued: { text: 'text-slate-600 dark:text-slate-300', dot: 'bg-slate-400 animate-pulse motion-reduce:animate-none' },
  pending_dependencies: { text: 'text-sky-700 dark:text-sky-300', dot: 'bg-sky-500 animate-pulse motion-reduce:animate-none' },
  running: { text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500 animate-pulse motion-reduce:animate-none' },
  blocked: { text: 'text-purple-700 dark:text-purple-300', dot: 'bg-purple-500' },
  completed: { text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
  failed: { text: 'text-red-700 dark:text-red-300', dot: 'bg-red-500' },
  stopping: { text: 'text-orange-700 dark:text-orange-300', dot: 'bg-orange-500 animate-pulse motion-reduce:animate-none' },
  stopped: { text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  expired: { text: 'text-zinc-600 dark:text-zinc-400', dot: 'bg-zinc-500' },
};

function flowLabel(flow: WorkflowState): string {
  return flow.jiraKey || flow.customPrompt?.trim() || 'Custom task';
}

function flowStepLabel(flow: WorkflowState, agents: ReturnType<typeof useDashboardStore.getState>['agents']): string {
  if (flow.status === 'completed') return 'All steps completed';
  if (flow.currentStep) return getStepDisplayName(flow.currentStep, agents);
  if (flow.status === 'pending_dependencies') return 'Waiting for dependencies';
  if (flow.status === 'queued') return 'Waiting to start';
  return 'No active step';
}

function flowDuration(flow: WorkflowState): string {
  const startedAt = flow.startedAt || flow.createdAt;
  const elapsed = flow.finishedAt
    ? formatElapsedTime(startedAt, new Date(flow.finishedAt))
    : ['queued', 'pending_dependencies', 'running', 'stopping'].includes(flow.status)
      ? formatElapsedTime(startedAt)
      : '—';
  return elapsed.replace(/^(\d+h \d+m) \d+s$/, '$1');
}

export function FlowCard({ flow, isSelected, onSelect }: FlowCardProps) {
  const agents = useDashboardStore((state) => state.agents);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const totalNeedsFix = flow.stepDetails.reduce((sum, step) => sum + step.needsFixCount, 0);
  const statusConfig = FLOW_STATUS_CONFIG[flow.status];
  const label = flowLabel(flow);
  const statusLabel = flow.status.replaceAll('_', ' ');

  return (
    <div role="listitem" className="group relative min-w-0">
      <button
        type="button"
        data-flow-card
        aria-current={isSelected ? 'true' : undefined}
        aria-label={`Open flow ${label}`}
        onClick={() => onSelect(flow.flowId)}
        className={cn(
          'relative block w-full min-w-0 px-2.5 py-2 pr-2 text-left transition-colors',
          'hover:bg-accent/60 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          isSelected && 'bg-primary/10 hover:bg-primary/10',
        )}
      >
        {isSelected && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-r-full bg-primary" />}

        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusConfig.dot)} />
          <strong className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground" title={label}>
            {label}
          </strong>
          <span className={cn('shrink-0 text-[9px] font-medium capitalize', statusConfig.text)}>
            {statusLabel}
          </span>
        </div>

        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 pl-3.5 text-[9px] text-muted-foreground">
          <StepIndicator steps={flow.steps} stepOrder={flow.stepOrder} />

          <span className="flex w-12 shrink-0 items-center justify-end gap-0.5 truncate font-mono" title="Flow duration">
            <Clock3 className="h-2.5 w-2.5" />{flowDuration(flow)}
          </span>

          {flow.status === 'blocked' && flow.blockedReason && (
            <span className="shrink-0" aria-label="Blocked" title={flow.blockedReason}>
              <AlertTriangle className="h-3 w-3 text-purple-500" />
            </span>
          )}
          {totalNeedsFix > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-amber-600 dark:text-amber-300" title={`${totalNeedsFix} fix cycles`}>
              <Wrench className="h-2.5 w-2.5" />{totalNeedsFix}
            </span>
          )}
        </div>
      </button>

      <button
        type="button"
        onClick={() => setDeleteModalOpen(true)}
        className="absolute right-1.5 top-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-100 transition-colors hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        title="Delete flow"
        aria-label={`Delete flow ${label}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      {deleteModalOpen && <DeleteFlowDialog flow={flow} onClose={() => setDeleteModalOpen(false)} />}
    </div>
  );
}

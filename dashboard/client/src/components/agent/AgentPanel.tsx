import { useEffect, useState } from 'react';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { AGENT_STEPS, getAgentOutputFilename, getStepDisplayName } from '@/lib/constants';
import { formatTokens, calculateProgress } from '@/lib/format';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { AgentStep, StepStatus } from '@devteam-dashboard/shared';

const API_BASE = import.meta.env.VITE_API_URL || '';

/** Status → icon + color config */
const STATUS_CONFIG: Record<StepStatus, { icon: string; color: string; bg: string }> = {
  waiting: { icon: '○', color: 'text-gray-500', bg: 'bg-gray-500/10' },
  pending: { icon: '◌', color: 'text-gray-400', bg: 'bg-gray-400/10' },
  running: { icon: '●', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  done: { icon: '✓', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  failed: { icon: '✗', color: 'text-red-400', bg: 'bg-red-500/10' },
  blocked: { icon: '⚠', color: 'text-purple-400', bg: 'bg-purple-500/10' },
  cancelled: { icon: '—', color: 'text-gray-500', bg: 'bg-gray-500/10' },
  retrying: { icon: '↻', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  unknown: { icon: '?', color: 'text-gray-500', bg: 'bg-gray-500/10' },
};

/**
 * Fetch token counts and output completion times from backend.
 */
function useFlowStepData(flowId: string | null) {
  const [data, setData] = useState<{
    perStep: Record<string, number>;
    total: number;
    outputTimes: Record<string, string | null>;
  }>({
    perStep: {},
    total: 0,
    outputTimes: {},
  });

  useEffect(() => {
    if (!flowId) {
      setData({ perStep: {}, total: 0, outputTimes: {} });
      return;
    }

    const controller = new AbortController();

    fetch(`${API_BASE}/api/flows/${flowId}/tokens`, { signal: controller.signal })
      .then((res) => res.json())
      .then((json: { tokens: Record<string, number>; total: number; outputTimes: Record<string, string | null> }) => {
        setData({
          perStep: json.tokens,
          total: json.total,
          outputTimes: json.outputTimes || {},
        });
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          console.error('[AgentPanel] Failed to fetch step data:', err);
        }
      });

    return () => controller.abort();
  }, [flowId]);

  return data;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function AgentPanel() {
  const selectedFlowId = useDashboardStore((s) => s.selectedFlowId);
  const flows = useDashboardStore((s) => s.flows);
  const agents = useDashboardStore((s) => s.agents);
  const selectedStep = useDashboardStore((s) => s.selectedStep);
  const selectStep = useDashboardStore((s) => s.selectStep);

  const flow = selectedFlowId ? flows[selectedFlowId] : null;
  const { perStep, total, outputTimes } = useFlowStepData(selectedFlowId);

  if (!flow) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center space-y-2">
          <svg className="w-10 h-10 text-muted-foreground/30 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
          </svg>
          <p className="text-sm text-muted-foreground">Select a flow to view pipeline</p>
        </div>
      </div>
    );
  }

  const progress = calculateProgress(flow.steps);

  return (
    <div className="space-y-4">
      {/* Flow info header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-foreground">{flow.jiraKey}</span>
          <span className={cn(
            'px-2 py-0.5 rounded-full text-[10px] font-medium border',
            flow.status === 'running' && 'bg-blue-500/10 text-blue-400 border-blue-500/20',
            flow.status === 'completed' && 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
            flow.status === 'failed' && 'bg-red-500/10 text-red-400 border-red-500/20',
            flow.status === 'blocked' && 'bg-purple-500/10 text-purple-400 border-purple-500/20',
            flow.status === 'stopped' && 'bg-amber-500/10 text-amber-400 border-amber-500/20',
          )}>
            {flow.status}
          </span>
          {total > 0 && (
            <span className="text-xs font-mono text-amber-300/80 bg-amber-500/10 px-2 py-0.5 rounded-full">
              {total.toLocaleString()} tokens
            </span>
          )}
        </div>
      </div>

      {flow.customPrompt && (
        <p className="text-[11px] text-muted-foreground truncate bg-muted/50 rounded-lg px-3 py-1.5 border border-border/50">
          {flow.customPrompt}
        </p>
      )}

      {/* Steps table */}
      <div className="overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0">
        <table className="w-full text-left min-w-[640px]">
          <thead>
            <tr className="text-[11px] text-muted-foreground uppercase tracking-wider">
              <th className="pb-2 pr-4 font-medium">Agent</th>
              <th className="pb-2 pr-4 font-medium">Status</th>
              <th className="pb-2 pr-4 font-medium text-right">Tokens</th>
              <th className="pb-2 pr-4 font-medium">Output</th>
              <th className="pb-2 pr-4 font-medium">Time</th>
              <th className="pb-2 font-medium">Info</th>
            </tr>
          </thead>
          <tbody className="text-xs">
            {(flow.stepOrder || AGENT_STEPS).map((step) => {
              const status = flow.steps[step] || 'unknown';
              const tokens = perStep[step] ?? 0;
              const retryCount = flow.retries?.[step] ?? 0;
              const needsFixCount = flow.needsFixCount?.[step] ?? 0;
              const isSelected = selectedStep === step;
              const outputFile = getAgentOutputFilename(step, agents);
              const config = STATUS_CONFIG[status];

              let info = `${agents[step]?.objective || getStepDisplayName(step, agents)}: ${flow.jiraKey}`;
              if (retryCount > 0) info += ` (retry: ${retryCount})`;
              if (needsFixCount > 0) info += ` [fix: ${needsFixCount}]`;

              return (
                <tr
                  key={step}
                  onClick={() => selectStep(step)}
                  className={cn(
                    'cursor-pointer border-b border-border/30 transition-all duration-150',
                    'hover:bg-accent/40',
                    isSelected && 'bg-primary/5 border-l-2 border-l-primary'
                  )}
                >
                  {/* Agent */}
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold',
                        config.bg, config.color
                      )}>
                        {config.icon}
                      </span>
                      <span className="font-medium text-foreground">
                        {getStepDisplayName(step, agents)}
                      </span>
                    </div>
                  </td>

                  {/* Status */}
                  <td className="py-2.5 pr-4">
                    <span className={cn('inline-flex items-center gap-1.5', config.color)}>
                      {status === 'running' && (
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                      )}
                      {status}
                    </span>
                  </td>

                  {/* Tokens */}
                  <td className="py-2.5 pr-4 text-right font-mono">
                    <span className={tokens > 0 ? 'text-amber-300' : 'text-muted-foreground/50'}>
                      {tokens > 0 ? tokens.toLocaleString() : '—'}
                    </span>
                    {retryCount > 0 && (
                      <span className="text-muted-foreground ml-1 text-[10px]">
                        ({retryCount + 1})
                      </span>
                    )}
                  </td>

                  {/* Output */}
                  <td className="py-2.5 pr-4">
                    <span className={cn(
                      'font-mono text-[11px]',
                      status === 'done' ? 'text-foreground/80' : 'text-muted-foreground/30'
                    )}>
                      {outputFile}
                    </span>
                  </td>

                  {/* Time */}
                  <td className="py-2.5 pr-4 font-mono text-muted-foreground">
                    {outputTimes[step] ? formatTime(outputTimes[step]!) : '—'}
                  </td>

                  {/* Info */}
                  <td className="py-2.5 text-muted-foreground/70 truncate max-w-[180px]" title={info}>
                    {info}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer: total + blocked */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          <span className="text-xs text-muted-foreground">Total</span>
          <span className={cn(
            'text-xs font-mono font-semibold',
            total > 0 ? 'text-amber-300' : 'text-muted-foreground/50'
          )}>
            {total > 0 ? total.toLocaleString() : '—'}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground/50 font-mono">
          {flow.flowId}
        </span>
      </div>

      {/* Blocked banner */}
      {flow.status === 'blocked' && flow.blockedReason && (
        <div className="flex items-center gap-2 rounded-lg bg-purple-500/10 border border-purple-500/20 px-3 py-2">
          <svg className="w-4 h-4 text-purple-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span className="text-xs text-purple-300">
            <span className="font-medium">Blocked:</span> {flow.blockedStep} — {flow.blockedReason}
          </span>
        </div>
      )}
    </div>
  );
}

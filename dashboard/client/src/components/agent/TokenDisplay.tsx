import type { WorkflowState } from '@devteam-dashboard/shared';
import { formatTokens } from '@/lib/format';

interface TokenDisplayProps {
  flow: WorkflowState;
}

/**
 * Displays total token count across all steps for a flow.
 * Currently shows placeholder "—" since actual token data
 * comes from parsing log files (handled at a higher level).
 */
export function TokenDisplay({ flow: _flow }: TokenDisplayProps) {
  // Token data will come from log parsing in the future.
  // For now, show placeholder since we don't have log content in WorkflowState.
  const totalTokens = 0;

  return (
    <div className="flex items-center justify-between border-t border-border pt-3 mt-3">
      <span className="text-sm text-muted-foreground">Total Tokens</span>
      <span className="text-sm font-mono font-medium text-foreground">
        {formatTokens(totalTokens)}
      </span>
    </div>
  );
}

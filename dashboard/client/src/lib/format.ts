import type { AgentStep, StepStatus } from '@devteam-dashboard/shared';

/**
 * Format token count cho display: raw → K/M units.
 */
export function formatTokens(n: number): string {
  if (n === 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Parse token entries từ log content.
 * Format expected: line "tokens used" followed by numeric value on next line.
 */
export function parseTokensFromLog(content: string): number[] {
  const lines = content.split('\n');
  const entries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (stripAnsi(lines[i]).trim() === 'tokens used' && i + 1 < lines.length) {
      const val = parseTokenNumber(lines[i + 1]);
      if (val > 0) entries.push(val);
    }
  }
  return entries;
}

/**
 * Parse token number string, handling comma/dot thousands separators.
 */
export function parseTokenNumber(s: string): number {
  const cleaned = stripAnsi(s).trim().replace(/[,.\s]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Tính elapsed time từ startedAt timestamp.
 * Returns formatted string: "Xh Ym Zs" hoặc "Ym Zs" hoặc "Zs"
 */
export function formatElapsedTime(startedAt: string, now: Date = new Date()): string {
  const start = new Date(startedAt);
  const diffMs = now.getTime() - start.getTime();
  if (diffMs < 0) return '0s';

  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Tính progress: số steps đã done / tổng steps.
 */
export function calculateProgress(steps: Record<AgentStep, StepStatus>): {
  completed: number;
  total: number;
  percentage: number;
} {
  const allSteps = Object.keys(steps);
  const completed = allSteps.filter(s => steps[s] === 'done').length;
  const total = allSteps.length;
  return { completed, total, percentage: Math.round((completed / total) * 100) };
}

/**
 * Map step status → CSS class cho status indicator.
 */
export function statusToIndicatorClass(status: StepStatus): string {
  const map: Record<StepStatus, string> = {
    waiting: 'bg-gray-500',
    queued: 'bg-sky-400 animate-pulse',
    running: 'bg-blue-500 animate-pulse',
    needs_fix: 'bg-amber-500',
    done: 'bg-green-500',
    failed: 'bg-red-500',
    blocked: 'bg-purple-500',
    cancelled: 'bg-gray-600',
    retrying: 'bg-yellow-500 animate-pulse',
  };
  return map[status] || 'bg-gray-400';
}

/**
 * Exponential backoff calculation.
 * delay(n) = min(2^n * baseDelay, maxDelay)
 */
export function calculateBackoff(attempt: number, baseDelay = 1000, maxDelay = 30000): number {
  return Math.min(Math.pow(2, attempt) * baseDelay, maxDelay);
}

/**
 * Trim log buffer to max lines, keeping most recent.
 */
export function trimLogBuffer(lines: string[], maxLines = 1000): string[] {
  if (lines.length <= maxLines) return lines;
  return lines.slice(-maxLines);
}

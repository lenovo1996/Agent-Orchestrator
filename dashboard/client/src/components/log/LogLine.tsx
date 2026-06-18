import { memo } from 'react';
import { cn } from '@/lib/utils';

interface LogLineProps {
  line: string;
  index: number;
}

/**
 * Renders a single log line with syntax highlighting for token entries.
 * Lines containing "tokens used" are highlighted in amber for visibility.
 *
 * Validates: Requirements 5.4
 */
export const LogLine = memo(function LogLine({ line, index }: LogLineProps) {
  const isTokenEntry = line.toLowerCase().includes('tokens used');

  return (
    <div
      className={cn(
        'text-[13px] leading-relaxed font-mono px-3 py-1 whitespace-pre-wrap break-all hover:bg-muted/50 transition-colors',
        isTokenEntry
          ? 'text-amber-400 bg-amber-500/10'
          : 'text-muted-foreground'
      )}
      data-line-index={index}
    >
      {line}
    </div>
  );
});

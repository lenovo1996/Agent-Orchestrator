import { ReactNode } from 'react';
import {
  ChevronsDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUp,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type PanelId = 'pipeline' | 'session' | 'output';

interface PanelHeaderProps {
  title: string;
  panel: PanelId;
  collapsed: boolean;
  expanded: boolean;
  onToggleCollapse: (panel: PanelId) => void;
  onToggleExpand: (panel: PanelId) => void;
}

export function PanelHeader({
  title,
  panel,
  collapsed,
  expanded,
  onToggleCollapse,
  onToggleExpand,
}: PanelHeaderProps) {
  const CollapseIcon = panel === 'pipeline'
    ? collapsed
      ? ChevronsDown
      : ChevronsUp
    : panel === 'output'
      ? collapsed
        ? ChevronsUp
        : ChevronsDown
      : collapsed
        ? ChevronsLeft
        : ChevronsRight;

  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/50 px-2.5">
      <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          title={expanded ? 'Restore panel' : 'Expand panel'}
          onClick={() => onToggleExpand(panel)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        {!expanded && (
          <button
            type="button"
            title={collapsed ? 'Open panel' : 'Collapse panel'}
            onClick={() => onToggleCollapse(panel)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <CollapseIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

interface PanelFrameProps {
  title: string;
  panel: PanelId;
  collapsed: boolean;
  expanded: boolean;
  onToggleCollapse: (panel: PanelId) => void;
  onToggleExpand: (panel: PanelId) => void;
  children: ReactNode;
  className?: string;
}

export function PanelFrame({
  title,
  panel,
  collapsed,
  expanded,
  onToggleCollapse,
  onToggleExpand,
  children,
  className,
}: PanelFrameProps) {
  if (collapsed && panel === 'session') {
    return (
      <button
        type="button"
        title={`Open ${title}`}
        onClick={() => onToggleCollapse(panel)}
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-2 border-l border-border/50 bg-card/50 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          className
        )}
      >
        <ChevronsLeft className="h-4 w-4" />
        <span className="text-[11px] font-semibold uppercase tracking-wide [writing-mode:vertical-rl]">
          {title}
        </span>
      </button>
    );
  }

  return (
    <section className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-background', className)}>
      <PanelHeader
        title={title}
        panel={panel}
        collapsed={collapsed}
        expanded={expanded}
        onToggleCollapse={onToggleCollapse}
        onToggleExpand={onToggleExpand}
      />
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-hidden">
          {children}
        </div>
      )}
    </section>
  );
}

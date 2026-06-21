import {
  ChevronsDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUp,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { PanelId } from "../../../types/panel";

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
  const CollapseIcon =
    panel === "pipeline"
      ? collapsed
        ? ChevronsDown
        : ChevronsUp
      : panel === "logs"
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
          title={expanded ? "Restore panel" : "Expand panel"}
          onClick={() => onToggleExpand(panel)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {expanded ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </button>
        {!expanded && (
          <button
            type="button"
            title={collapsed ? "Open panel" : "Collapse panel"}
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

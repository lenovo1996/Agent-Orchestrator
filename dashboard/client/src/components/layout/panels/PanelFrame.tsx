import type { ReactNode } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { PanelHeader } from "./PanelHeader";
import { cn } from "../../../lib/utils";
import type { PanelId } from "../../../types/panel";

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
  if (collapsed && panel !== "pipeline") {
    const OpenIcon = panel === "logs" ? ChevronsRight : ChevronsLeft;
    return (
      <button
        type="button"
        title={`Open ${title}`}
        onClick={() => onToggleCollapse(panel)}
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-2 border-border/50 bg-card/50 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          panel === "logs" ? "border-r" : "border-l",
          className,
        )}
      >
        <OpenIcon className="h-4 w-4" />
        <span className="text-[11px] font-semibold uppercase tracking-wide [writing-mode:vertical-rl]">
          {title}
        </span>
      </button>
    );
  }

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-background",
        className,
      )}
    >
      <PanelHeader
        title={title}
        panel={panel}
        collapsed={collapsed}
        expanded={expanded}
        onToggleCollapse={onToggleCollapse}
        onToggleExpand={onToggleExpand}
      />
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      )}
    </section>
  );
}

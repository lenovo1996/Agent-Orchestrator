import { useDashboardStore } from "../../store/use-dashboard-store";
import { Moon, Sun, Plus, FolderGit2 } from "lucide-react";
import { useState, useEffect } from "react";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";

interface HeaderProps {
  theme: "light" | "dark";
  onThemeToggle: () => void;
  onMenuToggle?: () => void;
}

export function Header({ theme, onThemeToggle, onMenuToggle }: HeaderProps) {
  const connected = useDashboardStore((s) => s.connected);
  const flows = useDashboardStore((s) => s.flows);
  const workspaces = useDashboardStore((s) => s.workspaces);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useDashboardStore((s) => s.selectWorkspace);
  const fetchWorkspaces = useDashboardStore((s) => s.fetchWorkspaces);

  const [dialogOpen, setDialogOpen] = useState(false);
  const flowCount = Object.keys(flows).length;

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  return (
    <header className="relative flex items-center justify-between border-b border-border/50 px-4 md:px-6 py-3 bg-card/80 glass">
      <div className="flex items-center gap-3">
        {/* Hamburger menu — visible on mobile only */}
        <button
          type="button"
          onClick={onMenuToggle}
          className="md:hidden p-1.5 rounded-lg hover:bg-accent text-muted-foreground transition-colors"
          aria-label="Toggle sidebar"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>

        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-blue-500 flex items-center justify-center shadow-md">
            <FolderGit2 className="w-4 h-4 text-white" />
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedWorkspaceId || ""}
              onChange={(e) => selectWorkspace(e.target.value || null)}
              className="text-sm md:text-base font-semibold text-foreground bg-transparent border-none focus:ring-0 cursor-pointer hover:opacity-80 transition-opacity"
            >
              <option value="">Default Workspace</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => setDialogOpen(true)}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
              title="Add Workspace"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Connection status */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onThemeToggle}
          title={
            theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
          }
          aria-label={
            theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
          }
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </button>
        <div
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${
            connected
              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              : "bg-red-500/10 text-red-400 border border-red-500/20"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected ? "bg-emerald-400 animate-pulse" : "bg-red-400"
            }`}
          />
          {connected ? "Live" : "Offline"}
        </div>
      </div>
      <NewWorkspaceDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </header>
  );
}

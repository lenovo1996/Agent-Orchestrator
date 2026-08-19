import { useDashboardStore } from '../../store/use-dashboard-store';
import { Moon, Sun, Plus, FolderGit2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useEffect } from 'react';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';
import { DeleteWorkspaceDialog } from './DeleteWorkspaceDialog';
import type { OrchestrationHealth } from '@devteam-dashboard/shared';

const API_BASE = import.meta.env.VITE_API_URL || '';

interface HeaderProps {
  theme: 'light' | 'dark';
  onThemeToggle: () => void;
  onMenuToggle?: () => void;
}

export function Header({ theme, onThemeToggle, onMenuToggle }: HeaderProps) {
  const connected = useDashboardStore((s) => s.connected);
  const flows = useDashboardStore((s) => s.flows);
  const workspaces = useDashboardStore(s => s.workspaces);
  const selectedWorkspaceId = useDashboardStore(s => s.selectedWorkspaceId);
  const selectWorkspace = useDashboardStore(s => s.selectWorkspace);
  const fetchWorkspaces = useDashboardStore(s => s.fetchWorkspaces);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteWorkspaceObj, setDeleteWorkspaceObj] = useState<{id: string, name: string} | null>(null);
  const orchestrationReady = useDashboardStore(s => s.orchestrationReady);
  const setOrchestrationReady = useDashboardStore(s => s.setOrchestrationReady);
  const flowCount = Object.keys(flows).length;

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  useEffect(() => {
    let active = true;
    const refresh = () => fetch(`${API_BASE}/api/orchestration/health`)
      .then(async (response) => ({ response, body: await response.json() as OrchestrationHealth }))
      .then(({ response, body }) => { if (active) setOrchestrationReady(response.ok && body.ready); })
      .catch(() => { if (active) setOrchestrationReady(false); });
    void refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [setOrchestrationReady]);

  return (
    <header className="relative flex items-center justify-between border-b border-border/50 px-2 md:px-6 py-1 bg-card/80 glass">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {/* Hamburger menu — visible on mobile only */}
        <button
          type="button"
          onClick={onMenuToggle}
          className="md:hidden flex-shrink-0 p-1.5 rounded-lg hover:bg-accent text-muted-foreground transition-colors"
          aria-label="Toggle sidebar"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <div className="flex items-center gap-2.5 flex-1 min-w-0 mr-4">
          <div className="h-7 w-7 rounded-lg bg-blue-500 flex-shrink-0 flex items-center justify-center shadow-md">
            <FolderGit2 className="w-4 h-4 text-white" />
          </div>
          <div className="flex items-center gap-1 flex-1 overflow-x-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
            <button
              onClick={() => selectWorkspace(null)}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors",
                !selectedWorkspaceId
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              Default Workspace
            </button>
            {workspaces.map(w => (
              <div key={w.id} className="relative group flex items-center">
                <button
                  onClick={() => selectWorkspace(w.id)}
                  className={cn(
                    "px-3 py-1.5 pr-8 text-sm font-medium rounded-md whitespace-nowrap transition-colors",
                    selectedWorkspaceId === w.id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                >
                  {w.name}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteWorkspaceObj({ id: w.id, name: w.name });
                  }}
                  className={cn(
                    "absolute right-1 p-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity",
                    selectedWorkspaceId === w.id
                      ? "text-foreground hover:bg-background"
                      : "text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                  )}
                  title="Delete Workspace"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button
              onClick={() => setDialogOpen(true)}
              className="p-1.5 ml-1 flex-shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
              title="Add Workspace"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Connection status */}
      <div className="flex items-center gap-2">
        {orchestrationReady === false && (
          <div className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-400">
            Inngest/worker unavailable
          </div>
        )}
        <button
          type="button"
          onClick={onThemeToggle}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${
          connected
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            : 'bg-red-500/10 text-red-400 border border-red-500/20'
        }`}>
          <span className={`h-1.5 w-1.5 rounded-full ${
            connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'
          }`} />
          {connected ? 'Live' : 'Offline'}
        </div>
      </div>
          <NewWorkspaceDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
          {deleteWorkspaceObj && (
            <DeleteWorkspaceDialog
              open={!!deleteWorkspaceObj}
              onClose={() => setDeleteWorkspaceObj(null)}
              workspaceId={deleteWorkspaceObj.id}
              workspaceName={deleteWorkspaceObj.name}
            />
          )}
    </header>
  );
}

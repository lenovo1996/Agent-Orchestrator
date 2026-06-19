import { useState } from 'react';
import { useDashboardStore } from '../../store/use-dashboard-store';
import { Moon, Sun, Plus } from 'lucide-react';
import { socket } from '../../lib/socket';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';

interface HeaderProps {
  theme: 'light' | 'dark';
  onThemeToggle: () => void;
  onMenuToggle?: () => void;
}

export function Header({ theme, onThemeToggle, onMenuToggle }: HeaderProps) {
  const connected = useDashboardStore((s) => s.connected);
  const flows = useDashboardStore((s) => s.flows);
  const workspaces = useDashboardStore((s) => s.workspaces);
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useDashboardStore((s) => s.setActiveWorkspace);
  const flowCount = Object.keys(flows).length;

  const [isNewWorkspaceDialogOpen, setIsNewWorkspaceDialogOpen] = useState(false);

  const handleWorkspaceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value;
    setActiveWorkspace(newId);
    socket.emit('workspace:switch', newId);
  };

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
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <div className="flex items-center gap-2">
          <select
            value={activeWorkspaceId || ''}
            onChange={handleWorkspaceChange}
            className="h-8 rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setIsNewWorkspaceDialogOpen(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Add Workspace"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Connection status */}
      <div className="flex items-center gap-2">
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
      <NewWorkspaceDialog
        open={isNewWorkspaceDialogOpen}
        onClose={() => setIsNewWorkspaceDialogOpen(false)}
      />
    </header>
  );
}

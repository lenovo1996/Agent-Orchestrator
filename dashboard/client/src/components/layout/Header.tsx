import { useDashboardStore } from '../../store/use-dashboard-store';
import { Moon, Sun } from 'lucide-react';

interface HeaderProps {
  theme: 'light' | 'dark';
  onThemeToggle: () => void;
  onMenuToggle?: () => void;
}

export function Header({ theme, onThemeToggle, onMenuToggle }: HeaderProps) {
  const connected = useDashboardStore((s) => s.connected);
  const flows = useDashboardStore((s) => s.flows);
  const flowCount = Object.keys(flows).length;

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

        <div className="flex items-center gap-2.5">
          {/* Logo icon */}
          <div className="h-7 w-7 rounded-lg bg-primary hover:scale-105 transition-transform duration-300 flex items-center justify-center shadow-md">
            <svg className="w-4 h-4 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm md:text-base font-semibold text-foreground leading-tight">
              Dev Team Dashboard
            </h1>
            {flowCount > 0 && (
              <p className="text-[10px] text-muted-foreground leading-tight hidden md:block">
                {flowCount} flow{flowCount !== 1 ? 's' : ''} tracked
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Connection status */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onThemeToggle}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground hover:scale-105 transition-all duration-300"
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
    </header>
  );
}

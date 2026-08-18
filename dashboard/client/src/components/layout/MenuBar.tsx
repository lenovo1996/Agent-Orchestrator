import { Bot, ListTodo, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';

export type DashboardView = 'flows' | 'workflows' | 'agents';

type MenuBarProps = {
  currentView: DashboardView;
  onViewChange: (view: DashboardView) => void;
};

const ITEMS: Array<{
  view: DashboardView;
  label: string;
  icon: typeof ListTodo;
}> = [
  { view: 'flows', label: 'Tasks', icon: ListTodo },
  { view: 'workflows', label: 'Workflow', icon: Workflow },
  { view: 'agents', label: 'Agents', icon: Bot },
];

export function MenuBar({ currentView, onViewChange }: MenuBarProps) {
  return (
    <nav
      aria-label="Primary navigation"
      className="relative z-30 flex w-16 shrink-0 flex-col items-center border-r border-border/70 bg-card/70 px-1.5 py-3 backdrop-blur-md md:w-20 md:px-2"
    >
      <div className="flex w-full flex-col gap-1.5">
        {ITEMS.map(({ view, label, icon: Icon }) => {
          const active = currentView === view;
          return (
            <button
              key={view}
              type="button"
              aria-current={active ? 'page' : undefined}
              aria-label={label}
              title={label}
              onClick={() => onViewChange(view)}
              className={cn(
                'group relative flex h-14 w-full flex-col items-center justify-center gap-1 rounded-xl text-muted-foreground transition-colors',
                'hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active && 'bg-primary/10 text-primary shadow-sm',
              )}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute -left-1.5 top-1/2 h-7 w-0.5 -translate-y-1/2 rounded-r-full bg-primary md:-left-2"
                />
              )}
              <Icon className={cn('h-[18px] w-[18px] transition-transform group-hover:scale-105', active && 'stroke-[2.25]')} />
              <span className="max-w-full truncate text-[9px] font-semibold tracking-tight md:text-[10px]">
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

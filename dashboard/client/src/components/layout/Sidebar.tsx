import type { ReactNode } from 'react';

interface SidebarProps {
  children?: ReactNode;
  onFlowSelect?: () => void;
}

export function Sidebar({ children, onFlowSelect }: SidebarProps) {
  return (
    <aside
      className="flex h-full w-60 flex-col gap-3 overflow-y-auto border-r border-border/50 bg-card/40 p-3"
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-flow-card]')) {
          onFlowSelect?.();
        }
      }}
    >
      {children}
    </aside>
  );
}

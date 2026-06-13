import { useEffect, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import {
  ChevronsDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUp,
  GripHorizontal,
  GripVertical,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { FlowList } from './components/flow/FlowList';
import { AgentPanel } from './components/agent/AgentPanel';
import { FlowActions } from './components/agent/FlowActions';
import { LogViewer } from './components/log/LogViewer';
import { OutputPreview } from './components/output/OutputPreview';
import { NewTaskDialog } from './components/flow/NewTaskDialog';
import { WorkflowsPage } from './components/workflows/WorkflowsPage';
import { useSocketEvents } from './hooks/use-socket-events';
import { useDashboardStore } from './store/use-dashboard-store';
import { cn } from './lib/utils';

type PanelId = 'pipeline' | 'logs' | 'output';
type Theme = 'light' | 'dark';

const MIN_PIPELINE_HEIGHT = 132;
const MAX_PIPELINE_HEIGHT = 520;
const COLLAPSED_PANEL_SIZE = 42;
const MIN_SPLIT_PERCENT = 25;
const MAX_SPLIT_PERCENT = 75;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';

  const storedTheme = window.localStorage.getItem('dashboard-theme');
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

interface PanelHeaderProps {
  title: string;
  panel: PanelId;
  collapsed: boolean;
  expanded: boolean;
  onToggleCollapse: (panel: PanelId) => void;
  onToggleExpand: (panel: PanelId) => void;
}

function PanelHeader({
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
    : panel === 'logs'
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

function PanelFrame({
  title,
  panel,
  collapsed,
  expanded,
  onToggleCollapse,
  onToggleExpand,
  children,
  className,
}: PanelFrameProps) {
  if (collapsed && panel !== 'pipeline') {
    const OpenIcon = panel === 'logs' ? ChevronsRight : ChevronsLeft;
    return (
      <button
        type="button"
        title={`Open ${title}`}
        onClick={() => onToggleCollapse(panel)}
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-2 border-border/50 bg-card/50 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          panel === 'logs' ? 'border-r' : 'border-l',
          className
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

export default function App() {
  useSocketEvents();

  const selectedFlowId = useDashboardStore((s) => s.selectedFlowId);
  const selectFlow = useDashboardStore((s) => s.selectFlow);
  const [currentView, setCurrentView] = useState<'flows' | 'workflows'>('flows');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newTaskDialogOpen, setNewTaskDialogOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [pipelineHeight, setPipelineHeight] = useState(300);
  const [logWidthPercent, setLogWidthPercent] = useState(58);
  const [expandedPanel, setExpandedPanel] = useState<PanelId | null>(null);
  const [collapsedPanels, setCollapsedPanels] = useState<Record<PanelId, boolean>>({
    pipeline: false,
    logs: false,
    output: false,
  });

  useEffect(() => {
    if (selectedFlowId) {
      setExpandedPanel(null);
      setCollapsedPanels((prev) => ({ ...prev, logs: false }));
    }
  }, [selectedFlowId]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem('dashboard-theme', theme);
  }, [theme]);

  const toggleCollapse = (panel: PanelId) => {
    setExpandedPanel(null);
    setCollapsedPanels((prev) => ({ ...prev, [panel]: !prev[panel] }));
  };

  const toggleExpand = (panel: PanelId) => {
    setCollapsedPanels((prev) => ({ ...prev, [panel]: false }));
    setExpandedPanel((current) => (current === panel ? null : panel));
  };

  const startPipelineResize = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsedPanels.pipeline || expandedPanel) return;

    event.preventDefault();
    const startY = event.clientY;
    const startHeight = pipelineHeight;

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const maxHeight = Math.min(MAX_PIPELINE_HEIGHT, window.innerHeight - 240);
      setPipelineHeight(clamp(startHeight + moveEvent.clientY - startY, MIN_PIPELINE_HEIGHT, maxHeight));
    };

    const stopResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
  };

  const startLogOutputResize = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsedPanels.logs || collapsedPanels.output || expandedPanel) return;

    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const nextPercent = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setLogWidthPercent(clamp(nextPercent, MIN_SPLIT_PERCENT, MAX_SPLIT_PERCENT));
    };

    const stopResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
  };

  const pipelinePanel = (
    <PanelFrame
      title="Agent Pipeline"
      panel="pipeline"
      collapsed={collapsedPanels.pipeline}
      expanded={expandedPanel === 'pipeline'}
      onToggleCollapse={toggleCollapse}
      onToggleExpand={toggleExpand}
      className="border-b border-border/50"
    >
      <div className="h-full overflow-auto p-3 md:p-4">
        <div className="space-y-3">
          <AgentPanel />
          <FlowActions />
        </div>
      </div>
    </PanelFrame>
  );

  const logsPanel = (
    <PanelFrame
      title="Logs"
      panel="logs"
      collapsed={collapsedPanels.logs}
      expanded={expandedPanel === 'logs'}
      onToggleCollapse={toggleCollapse}
      onToggleExpand={toggleExpand}
      className="border-r border-border/50"
    >
      <LogViewer />
    </PanelFrame>
  );

  const outputPanel = (
    <PanelFrame
      title="Output"
      panel="output"
      collapsed={collapsedPanels.output}
      expanded={expandedPanel === 'output'}
      onToggleCollapse={toggleCollapse}
      onToggleExpand={toggleExpand}
    >
      <OutputPreview />
    </PanelFrame>
  );

  const expandedContent =
    expandedPanel === 'pipeline'
      ? pipelinePanel
      : expandedPanel === 'logs'
      ? logsPanel
      : expandedPanel === 'output'
      ? outputPanel
      : null;

  const logsPaneStyle = collapsedPanels.logs
    ? { flex: `0 0 ${COLLAPSED_PANEL_SIZE}px` }
    : collapsedPanels.output
    ? { flex: '1 1 auto' }
    : { flex: `0 0 ${logWidthPercent}%` };

  const outputPaneStyle = collapsedPanels.output
    ? { flex: `0 0 ${COLLAPSED_PANEL_SIZE}px` }
    : collapsedPanels.logs
    ? { flex: '1 1 auto' }
    : { flex: '1 1 auto' };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Header
        theme={theme}
        onThemeToggle={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
        onMenuToggle={() => setSidebarOpen(!sidebarOpen)}
      />

      <div className="flex flex-1 overflow-hidden relative">
        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar: hidden on mobile unless toggled, always visible on md+ */}
        <div
          className={`
            fixed inset-y-0 left-0 z-50 w-80 transform transition-transform duration-200 ease-in-out
            md:relative md:translate-x-0 md:z-auto
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
        >
          <Sidebar onFlowSelect={() => setSidebarOpen(false)}>
            {/* Nav */}
            <div className="flex bg-muted/50 p-1 rounded-md mb-2">
              <button
                onClick={() => setCurrentView('flows')}
                className={cn('flex-1 text-xs py-1.5 font-medium rounded', currentView === 'flows' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                Tasks
              </button>
              <button
                onClick={() => setCurrentView('workflows')}
                className={cn('flex-1 text-xs py-1.5 font-medium rounded', currentView === 'workflows' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                Workflows
              </button>
            </div>

            {/* Start New Task Button */}
            <button
              onClick={() => setNewTaskDialogOpen(true)}
              className="flex items-center justify-center gap-2 w-full px-2 py-2 rounded-md text-sm font-semibold bg-blue-500 text-white border border-blue-600 hover:bg-blue-600 transition-all shadow-lg hover:shadow-xl mb-4"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Start New Task
            </button>

            <FlowList />
          </Sidebar>
        </div>

        {/* Content area */}
        <main className="flex flex-1 flex-col overflow-hidden min-w-0">
          {currentView === 'workflows' ? (
            <WorkflowsPage />
          ) : selectedFlowId ? (
            expandedContent ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                {expandedContent}
              </div>
            ) : (
              <>
                <div
                  className="shrink-0 overflow-hidden"
                  style={{ height: collapsedPanels.pipeline ? COLLAPSED_PANEL_SIZE : pipelineHeight }}
                >
                  {pipelinePanel}
                </div>
                {!collapsedPanels.pipeline && (
                  <div
                    role="separator"
                    aria-orientation="horizontal"
                    onPointerDown={startPipelineResize}
                    className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center border-b border-border/50 bg-muted/30 transition-colors hover:bg-accent"
                  >
                    <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground/70 group-hover:text-foreground" />
                  </div>
                )}

                <div className="min-h-0 flex-1 overflow-hidden">
                  <div className="flex h-full min-w-0 overflow-hidden">
                    <div className="min-w-0 overflow-hidden" style={logsPaneStyle}>
                      {logsPanel}
                    </div>
                    {!collapsedPanels.logs && !collapsedPanels.output && (
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        onPointerDown={startLogOutputResize}
                        className="group flex w-2 shrink-0 cursor-col-resize items-center justify-center border-r border-border/50 bg-muted/30 transition-colors hover:bg-accent"
                      >
                        <GripVertical className="h-3.5 w-3.5 text-muted-foreground/70 group-hover:text-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 overflow-hidden" style={outputPaneStyle}>
                      {outputPanel}
                    </div>
                  </div>
                </div>
              </>
            )
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <p className="text-muted-foreground text-center">
                Select a flow to view details.
              </p>
            </div>
          )}
        </main>
      </div>

      {/* New Task Dialog */}
      <NewTaskDialog
        open={newTaskDialogOpen}
        onClose={() => setNewTaskDialogOpen(false)}
        onSuccess={(flowId) => {
          selectFlow(flowId);
          setSidebarOpen(false);
        }}
      />
    </div>
  );
}

import { useEffect, useState } from 'react';
import {
  GripHorizontal,
  GripVertical,
} from 'lucide-react';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { MenuBar, type DashboardView } from './components/layout/MenuBar';
import { FlowList } from './components/flow/FlowList';
import { AgentPanel } from './components/agent/AgentPanel';
import { FlowActions } from './components/agent/FlowActions';
import { SessionViewer } from './components/session/SessionViewer';
import { OutputPreview } from './components/output/OutputPreview';
import { NewTaskDialog } from './components/flow/NewTaskDialog';
import { WorkflowsPage } from './components/workflows/WorkflowsPage';
import { AgentsPage } from './components/agents/AgentsPage';
import { useSocketEvents } from './hooks/use-socket-events';
import { useDashboardStore } from './store/use-dashboard-store';
import { PanelFrame, type PanelId } from './components/layout/PanelFrame';
import { usePanelResize } from './hooks/use-panel-resize';

type Theme = 'light' | 'dark';
const COLLAPSED_PANEL_SIZE = 42;

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';

  const storedTheme = window.localStorage.getItem('dashboard-theme');
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export default function App() {
  useSocketEvents();

  const selectedFlowId = useDashboardStore((s) => s.selectedFlowId);
  const selectFlow = useDashboardStore((s) => s.selectFlow);
  const fetchFlow = useDashboardStore((s) => s.fetchFlow);
  const fetchAgents = useDashboardStore((s) => s.fetchAgents);
  const [currentView, setCurrentView] = useState<DashboardView>('flows');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newTaskDialogOpen, setNewTaskDialogOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [pipelineHeight, setPipelineHeight] = useState(360);
  const [leftColumnWidthPercent, setLeftColumnWidthPercent] = useState(42);
  const [expandedPanel, setExpandedPanel] = useState<PanelId | null>(null);
  const [collapsedPanels, setCollapsedPanels] = useState<Record<PanelId, boolean>>({
    pipeline: false,
    session: false,
    output: false,
  });

  useEffect(() => {
    fetchAgents().catch((err) => {
      console.error('[App] Failed to fetch agents:', err);
    });
  }, [fetchAgents]);

  useEffect(() => {
    if (selectedFlowId) {
      setExpandedPanel(null);
      setCollapsedPanels((prev) => ({ ...prev, session: false }));
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

  const changeView = (view: DashboardView) => {
    setCurrentView(view);
    setSidebarOpen(view === 'flows');
  };

  const { startPipelineResize, startLeftSessionResize } = usePanelResize({
    collapsedPanels,
    expandedPanel,
    pipelineHeight,
    setPipelineHeight,
    setLeftColumnWidthPercent,
  });

  const pipelinePanel = (
    <PanelFrame
      title="Agent Pipeline"
      panel="pipeline"
      collapsed={collapsedPanels.pipeline}
      expanded={expandedPanel === 'pipeline'}
      onToggleCollapse={toggleCollapse}
      onToggleExpand={toggleExpand}
    >
      <div className="h-full min-h-0 overflow-hidden p-3 md:p-4">
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="min-h-40 flex-1">
            <AgentPanel colorMode={theme} />
          </div>
          <div className="shrink-0">
            <FlowActions />
          </div>
        </div>
      </div>
    </PanelFrame>
  );

  const sessionPanel = (
    <PanelFrame
      title="Session"
      panel="session"
      collapsed={collapsedPanels.session}
      expanded={expandedPanel === 'session'}
      onToggleCollapse={toggleCollapse}
      onToggleExpand={toggleExpand}
      className="border-l border-border/50"
    >
      <SessionViewer fullscreen={expandedPanel === 'session'} />
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
      : expandedPanel === 'session'
      ? sessionPanel
      : expandedPanel === 'output'
      ? outputPanel
      : null;

  const leftColumnStyle = collapsedPanels.session
    ? { flex: '1 1 auto' }
    : { flex: `0 0 ${leftColumnWidthPercent}%` };

  const sessionPaneStyle = collapsedPanels.session
    ? { flex: `0 0 ${COLLAPSED_PANEL_SIZE}px` }
    : { flex: '1 1 auto' };

  const pipelinePaneStyle = collapsedPanels.pipeline
    ? { flex: `0 0 ${COLLAPSED_PANEL_SIZE}px` }
    : collapsedPanels.output
      ? { flex: '1 1 auto' }
      : { flex: `0 0 ${pipelineHeight}px` };

  const outputPaneStyle = collapsedPanels.output
    ? { flex: `0 0 ${COLLAPSED_PANEL_SIZE}px` }
    : { flex: '1 1 auto' };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Header
        theme={theme}
        onThemeToggle={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
        onMenuToggle={() => {
          setCurrentView('flows');
          setSidebarOpen((current) => !current);
        }}
      />

      <div className="relative flex flex-1 overflow-hidden">
        <MenuBar currentView={currentView} onViewChange={changeView} />

        {currentView === 'flows' && (
          <>
            {/* Mobile sidebar overlay */}
            {sidebarOpen && (
              <button
                type="button"
                aria-label="Close task sidebar"
                className="fixed inset-0 z-40 cursor-default bg-black/60 md:hidden"
                onClick={() => setSidebarOpen(false)}
              />
            )}

            {/* Task sidebar: drawer on mobile, persistent beside the menu bar on desktop. */}
            <div
              className={`
                fixed inset-y-0 left-16 z-50 w-60 transform transition-transform duration-200 ease-in-out
                md:relative md:inset-y-auto md:left-auto md:z-auto md:translate-x-0
                ${sidebarOpen ? 'translate-x-0' : '-translate-x-[calc(100%+4rem)]'}
              `}
            >
              <Sidebar onFlowSelect={() => setSidebarOpen(false)}>
                <button
                  type="button"
                  onClick={() => setNewTaskDialogOpen(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-600 bg-blue-500 px-2 py-2 text-sm font-semibold text-white shadow-md transition-all hover:bg-blue-600 hover:shadow-lg"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Start New Task
                </button>

                <FlowList />
              </Sidebar>
            </div>
          </>
        )}

        {/* Content area */}
        <main className="flex flex-1 flex-col overflow-hidden min-w-0">
          {currentView === 'workflows' ? (
            <WorkflowsPage />
          ) : currentView === 'agents' ? (
            <AgentsPage />
          ) : selectedFlowId ? (
            expandedContent ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                {expandedContent}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div className="flex min-w-0 flex-col overflow-hidden" style={leftColumnStyle}>
                  <div className="min-h-0 overflow-hidden" style={pipelinePaneStyle}>
                    {pipelinePanel}
                  </div>
                  {!collapsedPanels.pipeline && !collapsedPanels.output && (
                    <div
                      role="separator"
                      aria-orientation="horizontal"
                      onPointerDown={startPipelineResize}
                      className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center border-y border-border/50 bg-muted/30 transition-colors hover:bg-accent"
                    >
                      <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground/70 group-hover:text-foreground" />
                    </div>
                  )}
                  <div className="min-h-0 overflow-hidden" style={outputPaneStyle}>
                    {outputPanel}
                  </div>
                </div>

                {!collapsedPanels.session && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    onPointerDown={startLeftSessionResize}
                    className="group flex w-2 shrink-0 cursor-col-resize items-center justify-center border-r border-border/50 bg-muted/30 transition-colors hover:bg-accent"
                  >
                    <GripVertical className="h-3.5 w-3.5 text-muted-foreground/70 group-hover:text-foreground" />
                  </div>
                )}

                <div className="min-w-0 overflow-hidden" style={sessionPaneStyle}>
                  {sessionPanel}
                </div>
              </div>
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
        onSuccess={async (flowId) => {
          selectFlow(flowId);
          await fetchFlow(flowId);
          selectFlow(flowId);
          setSidebarOpen(false);
        }}
      />
    </div>
  );
}

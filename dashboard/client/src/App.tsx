import { useEffect, useState } from 'react';
import {
  GripHorizontal,
  GripVertical,
} from 'lucide-react';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
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
import { cn } from './lib/utils';
import { PanelFrame, type PanelId } from './components/layout/PanelFrame';
import { usePanelResize } from './hooks/use-panel-resize';

type Theme = 'light' | 'dark';
type ViewMode = 'flows' | 'workflows' | 'agents';

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
  const [currentView, setCurrentView] = useState<'flows' | 'workflows' | 'agents'>('flows');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newTaskDialogOpen, setNewTaskDialogOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [pipelineHeight, setPipelineHeight] = useState(300);
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
      <div className="h-full overflow-auto p-3 md:p-4">
        <div className="space-y-3">
          <AgentPanel />
          <FlowActions />
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
              <button
                onClick={() => setCurrentView('agents')}
                className={cn('flex-1 text-xs py-1.5 font-medium rounded', currentView === 'agents' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                Agents
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

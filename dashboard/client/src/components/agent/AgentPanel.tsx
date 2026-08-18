import { useEffect, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Bot, Clock3, RotateCcw, Wrench } from 'lucide-react';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { AGENT_STEPS, getAgentOutputFilename, getStepDisplayName } from '@/lib/constants';
import { calculateProgress, formatTokens } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AgentConfig, AgentStep, SessionAttemptSummary, SessionUsage, StepStatus, WorkflowState } from '@devteam-dashboard/shared';

const API_BASE = import.meta.env.VITE_API_URL || '';
const NODE_WIDTH = 210;
const NODE_HEIGHT = 126;
const COLUMN_GAP = 46;
const ROW_GAP = 54;
const MAX_COLUMNS = 3;

const STATUS_CONFIG: Record<StepStatus, {
  icon: string;
  label: string;
  node: string;
  tone: string;
  dot: string;
  edge: string;
  animated: boolean;
}> = {
  waiting: {
    icon: '○', label: 'waiting', node: 'border-border bg-card', tone: 'text-muted-foreground',
    dot: 'bg-muted-foreground', edge: 'hsl(var(--muted-foreground))', animated: false,
  },
  queued: {
    icon: '◌', label: 'queued', node: 'border-sky-500/35 bg-sky-500/5', tone: 'text-sky-700 dark:text-sky-300',
    dot: 'bg-sky-500', edge: '#38bdf8', animated: true,
  },
  running: {
    icon: '●', label: 'running', node: 'border-blue-500/50 bg-blue-500/10 shadow-blue-500/10', tone: 'text-blue-700 dark:text-blue-300',
    dot: 'bg-blue-500', edge: '#3b82f6', animated: true,
  },
  retrying: {
    icon: '↻', label: 'retrying', node: 'border-amber-500/45 bg-amber-500/10', tone: 'text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500', edge: '#f59e0b', animated: true,
  },
  needs_fix: {
    icon: '↺', label: 'needs fix', node: 'border-amber-500/45 bg-amber-500/10', tone: 'text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500', edge: '#f59e0b', animated: false,
  },
  done: {
    icon: '✓', label: 'done', node: 'border-emerald-500/40 bg-emerald-500/5', tone: 'text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500', edge: '#10b981', animated: false,
  },
  failed: {
    icon: '×', label: 'failed', node: 'border-red-500/45 bg-red-500/10', tone: 'text-red-700 dark:text-red-300',
    dot: 'bg-red-500', edge: '#ef4444', animated: false,
  },
  blocked: {
    icon: '!', label: 'blocked', node: 'border-purple-500/45 bg-purple-500/10', tone: 'text-purple-700 dark:text-purple-300',
    dot: 'bg-purple-500', edge: '#a855f7', animated: false,
  },
  cancelled: {
    icon: '—', label: 'cancelled', node: 'border-border bg-muted/40 opacity-75', tone: 'text-muted-foreground',
    dot: 'bg-muted-foreground', edge: 'hsl(var(--muted-foreground))', animated: false,
  },
};

type PipelineNodeData = {
  step: AgentStep;
  label: string;
  objective: string;
  status: StepStatus;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  output: string;
  outputTime: string;
  cycle: number;
  retryCount: number;
  needsFixCount: number;
  hasTarget: boolean;
  hasSource: boolean;
  targetPosition: Position;
  sourcePosition: Position;
};

export type PipelineNode = Node<PipelineNodeData, 'pipelineStep'>;

export type StepTelemetry = {
  usage: SessionUsage | null;
  startedAt: string;
  finishedAt: string | null;
};

function metric(value: number | null): string {
  if (value === null) return '—';
  return value === 0 ? '0' : formatTokens(value);
}

function duration(startedAt: string | null, finishedAt: string | null, now: number): string {
  if (!startedAt) return '—';
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="min-w-0">
      <span className="block text-[7px] font-semibold uppercase tracking-wider text-muted-foreground/70">{label}</span>
      <strong className="block truncate text-[10px] font-semibold text-foreground">{metric(value)}</strong>
    </span>
  );
}

function PipelineStepNode({ data, selected }: NodeProps<PipelineNode>) {
  const config = STATUS_CONFIG[data.status];
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!['running', 'retrying'].includes(data.status) || data.finishedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [data.finishedAt, data.status]);

  return (
    <div
      data-pipeline-step={data.step}
      className={cn(
        'relative h-[126px] w-[210px] rounded-xl border px-3 py-2 shadow-sm transition-all',
        config.node,
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
        data.status === 'running' && 'pipeline-node-running shadow-lg',
      )}
    >
      {data.hasTarget && (
        <Handle
          type="target"
          position={data.targetPosition}
          isConnectable={false}
          className={cn('!h-2.5 !w-2.5 !border-2 !border-background', config.dot)}
        />
      )}
      {data.hasSource && (
        <Handle
          type="source"
          position={data.sourcePosition}
          isConnectable={false}
          className={cn('!h-2.5 !w-2.5 !border-2 !border-background', config.dot)}
        />
      )}

      <div className="flex min-w-0 items-start gap-2">
        <span className={cn(
          'mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-current/15 bg-background/60 text-xs font-bold',
          config.tone,
          config.animated && 'animate-pulse motion-reduce:animate-none',
        )}>
          {config.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground" title={data.objective}>{data.label}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="truncate font-mono text-[9px] text-muted-foreground">{data.step}</span>
            <span className={cn('ml-auto shrink-0 text-[9px] font-medium', config.tone)}>{config.label}</span>
          </div>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[8px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={data.model}>{data.model}</span>
        <span className="shrink-0" title="Total time"><Clock3 className="mr-0.5 inline h-2.5 w-2.5" />{duration(data.startedAt, data.finishedAt, now)}</span>
      </div>

      <div className="mt-1.5 grid grid-cols-3 gap-2 border-y border-border/60 py-1 font-mono">
        <Metric label="input" value={data.inputTokens} />
        <Metric label="output" value={data.outputTokens} />
        <Metric label="cache" value={data.cachedInputTokens} />
      </div>

      <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[8px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={data.output}>{data.output}</span>
        {data.outputTime !== '—' && <span className="shrink-0" title={`Last output ${data.outputTime}`}>{data.outputTime}</span>}
        {data.retryCount > 0 && <span className="shrink-0 text-amber-600 dark:text-amber-300" title={`${data.retryCount} technical retries`}><RotateCcw className="mr-0.5 inline h-2.5 w-2.5" />{data.retryCount}</span>}
        {data.needsFixCount > 0 && <span className="shrink-0 text-purple-600 dark:text-purple-300" title={`${data.needsFixCount} fix cycles`}><Wrench className="mr-0.5 inline h-2.5 w-2.5" />{data.needsFixCount}</span>}
        <span className="shrink-0" title={`Cycle ${data.cycle}`}>c{data.cycle}</span>
      </div>
    </div>
  );
}

const NODE_TYPES = { pipelineStep: PipelineStepNode };

function direction(from: { x: number; y: number }, to: { x: number; y: number }): Position {
  if (to.y > from.y) return Position.Bottom;
  return to.x > from.x ? Position.Right : Position.Left;
}

function incomingDirection(from: { x: number; y: number }, to: { x: number; y: number }): Position {
  if (to.y > from.y) return Position.Top;
  return to.x > from.x ? Position.Left : Position.Right;
}

export function buildPipelineGraph(
  flow: WorkflowState,
  agents: Record<string, AgentConfig>,
  outputTimes: Record<string, string | null>,
  selectedStep: AgentStep | null,
  telemetry: Partial<Record<AgentStep, StepTelemetry>> = {},
): { nodes: PipelineNode[]; edges: Edge[] } {
  const steps = flow.stepOrder.length ? flow.stepOrder : AGENT_STEPS;
  const columns = Math.max(1, Math.min(MAX_COLUMNS, steps.length));
  const positions = steps.map((_, index) => {
    const row = Math.floor(index / columns);
    const rowIndex = index % columns;
    const column = row % 2 === 0 ? rowIndex : columns - 1 - rowIndex;
    return {
      x: column * (NODE_WIDTH + COLUMN_GAP),
      y: row * (NODE_HEIGHT + ROW_GAP),
    };
  });

  const nodes: PipelineNode[] = steps.map((step, index) => {
    const detail = flow.stepDetails.find((candidate) => candidate.step === step);
    const latestAttempt = telemetry[step];
    const previous = positions[index - 1];
    const current = positions[index];
    const next = positions[index + 1];
    return {
      id: step,
      type: 'pipelineStep',
      position: current,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      draggable: false,
      deletable: false,
      selectable: true,
      selected: selectedStep === step,
      ariaLabel: `${getStepDisplayName(step, agents)}: ${flow.steps[step] || 'waiting'}`,
      data: {
        step,
        label: getStepDisplayName(step, agents),
        objective: agents[step]?.objective || getStepDisplayName(step, agents),
        status: flow.steps[step] || 'waiting',
        model: agents[step]?.model || 'default model',
        inputTokens: latestAttempt?.usage?.inputTokens ?? null,
        outputTokens: latestAttempt?.usage?.outputTokens ?? null,
        cachedInputTokens: latestAttempt?.usage?.cachedInputTokens ?? null,
        startedAt: latestAttempt?.startedAt || detail?.startedAt || null,
        finishedAt: latestAttempt?.finishedAt || detail?.finishedAt || null,
        output: getAgentOutputFilename(step, agents),
        outputTime: formatTime(outputTimes[step] || undefined),
        cycle: detail?.cycle || 1,
        retryCount: detail?.technicalRetryCount || 0,
        needsFixCount: detail?.needsFixCount || 0,
        hasTarget: index > 0,
        hasSource: index < steps.length - 1,
        targetPosition: previous ? incomingDirection(previous, current) : Position.Left,
        sourcePosition: next ? direction(current, next) : Position.Right,
      },
    };
  });

  const edges: Edge[] = steps.slice(0, -1).map((step, index) => {
    const nextStep = steps[index + 1];
    const config = STATUS_CONFIG[flow.steps[nextStep] || 'waiting'];
    return {
      id: `${step}->${nextStep}`,
      source: step,
      target: nextStep,
      type: 'smoothstep',
      animated: config.animated,
      selectable: false,
      deletable: false,
      style: { stroke: config.edge, strokeWidth: config.animated ? 2.5 : 1.75, opacity: flow.steps[nextStep] === 'waiting' ? 0.35 : 0.85 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: config.edge },
    };
  });

  return { nodes, edges };
}

function useStepTelemetry(flow: WorkflowState | undefined) {
  const [telemetry, setTelemetry] = useState<Partial<Record<AgentStep, StepTelemetry>>>({});
  const stepSignature = flow?.stepDetails
    .map((detail) => `${detail.step}:${detail.cycle}:${detail.status}:${detail.updatedAt}`)
    .join('|') || '';

  useEffect(() => {
    if (!flow) {
      setTelemetry({});
      return;
    }

    const controller = new AbortController();
    const workspaceQuery = flow.workspaceName
      ? `?workspaceName=${encodeURIComponent(flow.workspaceName)}`
      : '';
    const steps = flow.stepOrder.length ? flow.stepOrder : AGENT_STEPS;
    setTelemetry({});

    void Promise.all(steps.map(async (step) => {
      try {
        const response = await fetch(
          `${API_BASE}/api/flows/${encodeURIComponent(flow.flowId)}/sessions/${encodeURIComponent(step)}${workspaceQuery}`,
          { signal: controller.signal },
        );
        if (!response.ok) return null;
        const data = await response.json() as { enabled?: boolean; attempts?: SessionAttemptSummary[] };
        if (data.enabled === false) return null;
        const attempt = data.attempts?.at(-1);
        return attempt ? [step, {
          usage: attempt.usage,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
        } satisfies StepTelemetry] as const : null;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return null;
        return null;
      }
    })).then((entries) => {
      if (!controller.signal.aborted) {
        setTelemetry(Object.fromEntries(entries.filter((entry) => entry !== null)));
      }
    });

    return () => controller.abort();
  }, [flow?.flowId, flow?.workspaceName, stepSignature]);

  return telemetry;
}

function useFlowStepData(flowId: string | null) {
  const [data, setData] = useState<{
    perStep: Record<string, number>;
    total: number;
    outputTimes: Record<string, string | null>;
  }>({ perStep: {}, total: 0, outputTimes: {} });

  useEffect(() => {
    if (!flowId) {
      setData({ perStep: {}, total: 0, outputTimes: {} });
      return;
    }
    const controller = new AbortController();
    fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}/tokens`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to fetch step data: ${response.status}`);
        return response.json();
      })
      .then((json: { tokens: Record<string, number>; total: number; outputTimes: Record<string, string | null> }) => {
        setData({ perStep: json.tokens || {}, total: json.total || 0, outputTimes: json.outputTimes || {} });
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          console.error('[AgentPanel] Failed to fetch step data:', error);
          setData({ perStep: {}, total: 0, outputTimes: {} });
        }
      });
    return () => controller.abort();
  }, [flowId]);

  return data;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function flowStatusClass(status: WorkflowState['status']): string {
  const values: Record<WorkflowState['status'], string> = {
    queued: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    pending_dependencies: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    running: 'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300',
    blocked: 'border-purple-500/25 bg-purple-500/10 text-purple-700 dark:text-purple-300',
    completed: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    failed: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
    stopping: 'border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300',
    stopped: 'border-border bg-muted text-muted-foreground',
    expired: 'border-border bg-muted text-muted-foreground',
  };
  return values[status];
}

export function AgentPanel({ colorMode = 'dark' }: { colorMode?: 'light' | 'dark' }) {
  const selectedFlowId = useDashboardStore((state) => state.selectedFlowId);
  const flow = useDashboardStore((state) => selectedFlowId ? state.flows[selectedFlowId] : undefined);
  const agents = useDashboardStore((state) => state.agents);
  const selectedStep = useDashboardStore((state) => state.selectedStep);
  const selectStep = useDashboardStore((state) => state.selectStep);
  const { total, outputTimes } = useFlowStepData(selectedFlowId);
  const telemetry = useStepTelemetry(flow);

  if (!flow) {
    return (
      <div className="flex h-full min-h-40 items-center justify-center rounded-lg border border-dashed border-border bg-muted/20">
        <div className="space-y-2 text-center">
          <Bot className="mx-auto h-9 w-9 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">Select a flow to view pipeline graph</p>
        </div>
      </div>
    );
  }

  const progress = calculateProgress(flow.steps);
  const graph = buildPipelineGraph(flow, agents, outputTimes, selectedStep, telemetry);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg bg-card/30">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <span className="max-w-32 truncate text-xs font-semibold text-foreground" title={flow.jiraKey || flow.flowId}>{flow.jiraKey || flow.flowId}</span>
        <span className={cn('rounded-full border px-2 py-0.5 text-[9px] font-semibold', flowStatusClass(flow.status))}>{flow.status.replace('_', ' ')}</span>
        <div className="ml-auto flex items-center gap-2 font-mono text-[9px] text-muted-foreground">
          <span>{progress.completed}/{progress.total} steps</span>
          <span className="h-1 w-16 overflow-hidden rounded-full bg-muted" title={`${progress.percentage}% complete`}>
            <span className="block h-full rounded-full bg-primary transition-all" style={{ width: `${progress.percentage}%` }} />
          </span>
          <span>{formatTokens(total)} tok</span>
        </div>
      </div>

      <div className="pipeline-graph min-h-0 flex-1 bg-background/50" data-testid="pipeline-graph">
        <ReactFlow<PipelineNode, Edge>
          key={`${flow.flowId}:${flow.stepOrder.join(',')}`}
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={NODE_TYPES}
          colorMode={colorMode}
          onNodeClick={(_event, node) => selectStep(node.data.step)}
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: 0.45, maxZoom: 1.1 }}
          minZoom={0.35}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="opacity-50" />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>

      {flow.status === 'blocked' && flow.blockedReason && (
        <div className="shrink-0 truncate border-t border-purple-500/20 bg-purple-500/10 px-3 py-1.5 text-[10px] text-purple-700 dark:text-purple-300" title={flow.blockedReason}>
          <strong>Blocked at {flow.currentStep}:</strong> {flow.blockedReason}
        </div>
      )}
    </div>
  );
}

import { useDashboardStore } from '@/store/use-dashboard-store';
import { FlowCard } from './FlowCard';

export function FlowList() {
  const flows = useDashboardStore((state) => state.flows);
  const selectedFlowId = useDashboardStore((state) => state.selectedFlowId);
  const selectFlow = useDashboardStore((state) => state.selectFlow);

  const sortedFlows = Object.values(flows).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <section aria-label="Flow history" className="min-w-0">
      {sortedFlows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-[10px] text-muted-foreground">
          No flow history yet
        </div>
      ) : (
        <div role="list" className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-background/30">
          {sortedFlows.map((flow) => (
            <FlowCard
              key={flow.flowId}
              flow={flow}
              isSelected={flow.flowId === selectedFlowId}
              onSelect={selectFlow}
            />
          ))}
        </div>
      )}
    </section>
  );
}

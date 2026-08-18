import { useDashboardStore } from '@/store/use-dashboard-store';
import { FlowCard } from './FlowCard';

export function FlowList() {
  const flows = useDashboardStore((s) => s.flows);
  const selectedFlowId = useDashboardStore((s) => s.selectedFlowId);
  const selectFlow = useDashboardStore((s) => s.selectFlow);

  const sortedFlows = Object.values(flows).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  if (sortedFlows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <svg className="w-8 h-8 text-muted-foreground/30 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
        </svg>
        <p className="text-xs text-muted-foreground">No flows yet</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
        Flows ({sortedFlows.length})
      </h3>
      {sortedFlows.map((flow) => (
        <FlowCard
          key={flow.flowId}
          flow={flow}
          isSelected={flow.flowId === selectedFlowId}
          onSelect={selectFlow}
        />
      ))}
    </div>
  );
}

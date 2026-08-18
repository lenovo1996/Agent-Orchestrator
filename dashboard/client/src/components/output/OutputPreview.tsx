import { useEffect, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useDashboardStore } from '@/store/use-dashboard-store';
import { socket } from '@/lib/socket';
import { getStepDisplayName } from '@/lib/constants';
import { FileText, Clock, HardDrive, RefreshCw } from 'lucide-react';
import type { AgentStep, FileMetadata, OutputUpdatedPayload } from '@devteam-dashboard/shared';

// In dev mode, Vite proxy handles /api routing so we use empty string (relative path).
const API_BASE = import.meta.env.VITE_API_URL || '';

interface OutputData {
  content: string | null;
  exists: boolean;
  metadata?: FileMetadata;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLastModified(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString();
}

export function OutputPreview() {
  const selectedFlowId = useDashboardStore((s) => s.selectedFlowId);
  const selectedStep = useDashboardStore((s) => s.selectedStep);
  const flows = useDashboardStore((s) => s.flows);
  const agents = useDashboardStore((s) => s.agents);

  const [output, setOutput] = useState<OutputData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepStatus = selectedFlowId && selectedStep
    ? flows[selectedFlowId]?.steps[selectedStep]
    : null;

  const fetchOutput = useCallback(async () => {
    if (!selectedFlowId || !selectedStep) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `${API_BASE}/api/flows/${encodeURIComponent(selectedFlowId)}/output/${encodeURIComponent(selectedStep)}`
      );
      if (!res.ok) {
        throw new Error(`Failed to fetch output: ${res.status}`);
      }
      const data: OutputData = await res.json();
      setOutput(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setOutput(null);
    } finally {
      setLoading(false);
    }
  }, [selectedFlowId, selectedStep]);

  // Fetch output when selected step changes
  useEffect(() => {
    if (!selectedFlowId || !selectedStep) {
      setOutput(null);
      return;
    }
    fetchOutput();
  }, [selectedFlowId, selectedStep, fetchOutput]);

  // Refresh on output:updated event for current step
  useEffect(() => {
    if (!selectedFlowId || !selectedStep) return;

    const handleOutputUpdated = (payload: OutputUpdatedPayload) => {
      if (payload.flowId === selectedFlowId && payload.step === selectedStep) {
        setOutput({
          content: payload.content,
          exists: true,
          metadata: payload.metadata,
        });
      }
    };

    socket.on('output:updated', handleOutputUpdated);

    return () => {
      socket.off('output:updated', handleOutputUpdated);
    };
  }, [selectedFlowId, selectedStep]);

  // Placeholder: no step selected
  if (!selectedFlowId || !selectedStep) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
        <FileText className="w-12 h-12 mb-3 opacity-40" />
        <p className="text-sm">Select an agent step to preview its output</p>
      </div>
    );
  }

  // // Placeholder: step not completed
  // if (stepStatus && stepStatus !== 'done') {
  //   return (
  //     <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
  //       <FileText className="w-12 h-12 mb-3 opacity-40" />
  //       <p className="text-sm">
  //         {getStepDisplayName(selectedStep as AgentStep, agents)} has not completed yet
  //       </p>
  //       <p className="text-xs mt-1 opacity-60">
  //         Output will be available once the step finishes
  //       </p>
  //     </div>
  //   );
  // }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" />
        <span className="text-sm">Loading output...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={fetchOutput}
          className="mt-2 text-xs text-blue-400 hover:text-blue-300 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  // Placeholder: no output file exists
  if (!output || !output.exists || !output.content) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
        <FileText className="w-12 h-12 mb-3 opacity-40" />
        <p className="text-sm">No output file found for this step</p>
        <p className="text-xs mt-1 opacity-60">
          The step may not have produced an output file
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* File metadata header */}
      {output.metadata && (
        <div className="flex items-center gap-4 px-4 py-2 border-b border-border text-xs text-muted-foreground shrink-0">
          <span className="flex items-center gap-1">
            <HardDrive className="w-3 h-3" />
            {formatFileSize(output.metadata.size)}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatLastModified(output.metadata.lastModified)}
          </span>
        </div>
      )}

      {/* Markdown content */}
      <div className="flex-1 overflow-y-auto p-4">
        <article className="prose prose-invert prose-sm max-w-none
          prose-headings:text-foreground prose-headings:font-semibold
          prose-h1:text-xl prose-h1:border-b prose-h1:border-border prose-h1:pb-2
          prose-h2:text-lg
          prose-h3:text-base
          prose-p:text-muted-foreground
          prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
          prose-strong:text-foreground
          prose-code:text-emerald-400 prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none
          prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-pre:rounded-lg
          prose-blockquote:border-l-blue-500 prose-blockquote:text-muted-foreground
          prose-li:text-muted-foreground
          prose-table:text-sm
          prose-th:text-foreground prose-th:bg-muted prose-th:px-3 prose-th:py-2
          prose-td:px-3 prose-td:py-2 prose-td:border-border
          prose-tr:border-border
          prose-hr:border-border
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {output.content}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  );
}

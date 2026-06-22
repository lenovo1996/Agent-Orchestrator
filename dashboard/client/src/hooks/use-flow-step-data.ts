import { useEffect, useState } from 'react';
import { getAgentOutputFilename, AGENT_STEPS } from '@/lib/constants';

const API_BASE = import.meta.env.VITE_API_URL || '';

export function useFlowStepData(flowId: string | null, workspaceName?: string) {
  const [data, setData] = useState<{
    perStep: Record<string, number>;
    total: number;
    outputTimes: Record<string, string | null>;
  }>({
    perStep: {},
    total: 0,
    outputTimes: {},
  });

  useEffect(() => {
    if (!flowId) {
      setData({ perStep: {}, total: 0, outputTimes: {} });
      return;
    }

    let isMounted = true;

    const controller = new AbortController();

    async function fetchData() {
      try {
        const qs = workspaceName ? `?workspaceName=${encodeURIComponent(workspaceName)}` : '';
        const res = await fetch(`${API_BASE}/api/flows/${flowId}/tokens${qs}`, { signal: controller.signal });
        if (!res.ok) {
           throw new Error(`Failed to fetch step data: ${res.status}`);
        }
        const json = await res.json();

        if (isMounted) {
          setData({
            perStep: json.tokens || {},
            total: json.total || 0,
            outputTimes: json.outputTimes || {},
          });
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.error('[AgentPanel] Failed to fetch step data:', err);
        }
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 5000); // Poll every 5s

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [flowId, workspaceName]);

  return data;
}

import { PointerEvent } from 'react';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface UsePanelResizeOptions {
  collapsedPanels: Record<string, boolean>;
  expandedPanel: string | null;
  pipelineHeight: number;
  setPipelineHeight: (height: number) => void;
  setSessionWidthPercent: (percent: number) => void;
}

export function usePanelResize({
  collapsedPanels,
  expandedPanel,
  pipelineHeight,
  setPipelineHeight,
  setSessionWidthPercent,
}: UsePanelResizeOptions) {
  const startPipelineResize = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsedPanels.pipeline || expandedPanel) return;

    event.preventDefault();
    const startY = event.clientY;
    const startHeight = pipelineHeight;
    const MIN_PIPELINE_HEIGHT = 132;
    const MAX_PIPELINE_HEIGHT = 520;

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

  const startSessionOutputResize = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsedPanels.session || collapsedPanels.output || expandedPanel) return;

    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const MIN_SPLIT_PERCENT = 25;
    const MAX_SPLIT_PERCENT = 75;

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const nextPercent = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setSessionWidthPercent(clamp(nextPercent, MIN_SPLIT_PERCENT, MAX_SPLIT_PERCENT));
    };

    const stopResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
  };

  return { startPipelineResize, startSessionOutputResize };
}

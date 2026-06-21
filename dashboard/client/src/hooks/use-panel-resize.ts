import { useState, type PointerEvent } from "react";
import type { PanelId } from "../types/panel";

const MIN_PIPELINE_HEIGHT = 132;
const MAX_PIPELINE_HEIGHT = 520;
const MIN_SPLIT_PERCENT = 25;
const MAX_SPLIT_PERCENT = 75;

export const COLLAPSED_PANEL_SIZE = 42;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function usePanelResize(
  collapsedPanels: Record<PanelId, boolean>,
  expandedPanel: PanelId | null,
) {
  const [pipelineHeight, setPipelineHeight] = useState(300);
  const [logWidthPercent, setLogWidthPercent] = useState(58);

  const startPipelineResize = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsedPanels.pipeline || expandedPanel) return;

    event.preventDefault();
    const startY = event.clientY;
    const startHeight = pipelineHeight;

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const maxHeight = Math.min(MAX_PIPELINE_HEIGHT, window.innerHeight - 240);
      setPipelineHeight(
        clamp(
          startHeight + moveEvent.clientY - startY,
          MIN_PIPELINE_HEIGHT,
          maxHeight,
        ),
      );
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
  };

  const startLogOutputResize = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsedPanels.logs || collapsedPanels.output || expandedPanel) return;

    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const nextPercent = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setLogWidthPercent(
        clamp(nextPercent, MIN_SPLIT_PERCENT, MAX_SPLIT_PERCENT),
      );
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
  };

  return {
    pipelineHeight,
    logWidthPercent,
    startPipelineResize,
    startLogOutputResize,
  };
}

import chokidar from "chokidar";
import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs";
import { readWorkflowJson, readOutputContent } from "./flow-reader.js";
import { readNewLogLines } from "./log-tailer.js";
import type {
  WorkflowState,
  AgentStep,
  FileMetadata,
} from "@devteam-dashboard/shared";

export interface WatcherEvents {
  "workflow-changed": (flowId: string, workflow: WorkflowState) => void;
  "log-appended": (flowId: string, step: AgentStep, lines: string[]) => void;
  "output-created": (flowId: string, step: AgentStep, filePath: string) => void;
  "output-updated": (
    flowId: string,
    step: AgentStep,
    content: string,
    metadata: FileMetadata,
  ) => void;
}

/**
 * Map output filenames to AgentStep values.
 */
function mapOutputFileToStep(filename: string): AgentStep | null {
  const map: Record<string, AgentStep> = {
    "clarify.md": "clarifier",
    "architecture.md": "architect",
    "plan.md": "planner",
    "implementation.md": "implementer",
    "verification.md": "verifier",
  };
  return map[filename] || null;
}

/**
 * Create a filesystem watcher that monitors the task-flows directory
 * for changes, emitting typed events.
 *
 * Events emitted:
 * - `workflow-changed` — when a flow's workflow.json is modified
 * - `log-appended` — when new lines are appended to a step log file
 * - `output-created` — when a new output .md file appears
 * - `output-updated` — when an existing output .md file is modified
 */
export function createWatcher(taskFlowsDir: string): EventEmitter {
  const emitter = new EventEmitter();
  const logOffsets = new Map<string, number>();

  const watcher = chokidar.watch([taskFlowsDir], {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher.on("change", (filePath: string) => {
    const relative = path.relative(taskFlowsDir, filePath);
    const parts = relative.split(path.sep);
    if (parts.length < 2) return;

    let workspaceName = "";
    let flowId = "";
    let restParts = [];

    // Check if it's a workspace path (e.g. workspaceName/flowId/...)
    if (
      parts.length >= 3 &&
      parts[0] &&
      parts[0].length > 0 &&
      parts[1].startsWith("flow_")
    ) {
      workspaceName = parts[0];
      flowId = parts[1];
      restParts = parts.slice(2);
    } else {
      flowId = parts[0];
      restParts = parts.slice(1);
    }

    // workflow.json changed
    if (restParts[0] === "workflow.json") {
      const dirPath = workspaceName
        ? path.join(taskFlowsDir, workspaceName, flowId)
        : path.join(taskFlowsDir, flowId);
      const workflow = readWorkflowJson(dirPath);
      if (workflow) {
        emitter.emit("workflow-changed", flowId, workflow);
      }
      return;
    }

    // logs/{step}.log changed
    if (restParts[0] === "logs" && restParts[1]?.endsWith(".log")) {
      const step = restParts[1].replace(".log", "") as AgentStep;
      const newLines = readNewLogLines(filePath, logOffsets);
      if (newLines.length > 0) {
        emitter.emit("log-appended", flowId, step, newLines);
      }
      return;
    }

    // output/{filename}.md changed
    if (restParts[0] === "output" && restParts[1]?.endsWith(".md")) {
      const step = mapOutputFileToStep(restParts[1]);
      if (step) {
        const result = readOutputContent(filePath);
        if (result) {
          emitter.emit(
            "output-updated",
            flowId,
            step,
            result.content,
            result.metadata,
          );
        }
      }
      return;
    }
  });

  watcher.on("add", (filePath: string) => {
    const relative = path.relative(taskFlowsDir, filePath);
    const parts = relative.split(path.sep);

    let workspaceName = "";
    let flowId = "";
    let restParts = [];

    if (
      parts.length >= 3 &&
      parts[0] &&
      parts[0].length > 0 &&
      parts[1].startsWith("flow_")
    ) {
      workspaceName = parts[0];
      flowId = parts[1];
      restParts = parts.slice(2);
    } else {
      flowId = parts[0];
      restParts = parts.slice(1);
    }

    // New output file created
    if (
      restParts.length >= 2 &&
      restParts[0] === "output" &&
      restParts[1].endsWith(".md")
    ) {
      const step = mapOutputFileToStep(restParts[1]);
      if (step) {
        emitter.emit("output-created", flowId, step, filePath);
      }
    }
  });

  watcher.on("error", (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[watcher] Chokidar error:", message);
  });

  return emitter;
}

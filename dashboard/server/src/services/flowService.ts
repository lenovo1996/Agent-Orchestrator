import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { FlowSummary, AgentStep } from "@devteam-dashboard/shared";
import { readWorkflowJson } from "../flow-reader.js";
import type { DashboardConfig } from "../config.js";

const STEPS: AgentStep[] = [
  "clarifier",
  "architect",
  "planner",
  "implementer",
  "verifier",
];

export function listFlows(taskFlowsDir: string): FlowSummary[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(taskFlowsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const summaries: FlowSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const flowDir = path.join(taskFlowsDir, entry.name);
    const workflow = readWorkflowJson(flowDir);
    if (!workflow) continue;

    const stepsToUse = workflow.stepOrder || STEPS;
    const completedSteps = stepsToUse.filter(
      (s) => workflow.steps[s] === "done",
    ).length;

    summaries.push({
      flowId: workflow.flowId,
      jiraKey: workflow.jiraKey,
      status: workflow.status,
      currentStep: workflow.currentStep,
      startedAt: workflow.startedAt,
      completedSteps,
      totalSteps: stepsToUse.length,
    });
  }

  return summaries;
}

export function resolveFlowDir(taskFlowsDir: string, flowId: string, workspaceName?: string): string {
  if (workspaceName) {
    return path.join(taskFlowsDir, workspaceName, flowId);
  }

  const directPath = path.join(taskFlowsDir, flowId);
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  try {
    for (const entry of fs.readdirSync(taskFlowsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const workspaceFlowDir = path.join(taskFlowsDir, entry.name, flowId);
      if (fs.existsSync(workspaceFlowDir)) {
        return workspaceFlowDir;
      }
    }
  } catch {
    // Fall through to the direct path so callers can return their normal 404 response.
  }

  return directPath;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function parseTokenNumber(value: string): number {
  const cleaned = stripAnsi(value)
    .trim()
    .replace(/[,.\s]/g, "");
  return parseInt(cleaned, 10) || 0;
}

export function extractTokensFromLog(content: string): number[] {
  const tokens: number[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = stripAnsi(lines[i]).trim();

    if (line === "tokens used" && i + 1 < lines.length) {
      const value = parseTokenNumber(lines[i + 1]);
      if (value > 0) {
        tokens.push(value);
      }
    }
  }

  return tokens;
}

export function deleteFlow(config: DashboardConfig, flowId: string, deleteMemory: boolean): void {
  const flowDir = path.join(config.taskFlowsDir, flowId);
  if (fs.existsSync(flowDir)) {
    fs.rmSync(flowDir, { recursive: true, force: true });
  }

  if (deleteMemory) {
    const memoryTreeScript = `
      const { getFlowDir, getMetaPath } = require('./utils/memory-tree.js');
      const fs = require('fs');

      const flowId = process.argv[1];
      const flowDir = getFlowDir(flowId);
      if (fs.existsSync(flowDir)) {
        fs.rmSync(flowDir, { recursive: true, force: true });
      }

      const metaPath = getMetaPath(flowId);
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.flows = meta.flows.filter((f) => f.flow_id !== flowId);

        if (meta.flows.length === 0) {
          const taskDir = require('path').dirname(metaPath);
          fs.rmSync(taskDir, { recursive: true, force: true });
        } else {
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        }
      }
    `;
    try {
        execFileSync(process.execPath, ["-e", memoryTreeScript, flowId], {
            cwd: config.scriptDir,
            encoding: "utf8",
            timeout: 10000,
        });
    } catch (e) {
        // Log or handle memory tree deletion error if needed
        console.error("Error deleting memory:", e);
    }
  }
}

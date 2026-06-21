import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import type { DashboardConfig } from "../config.js";
import type { FlowSummary, AgentStep } from "@devteam-dashboard/shared";
import { readWorkflowJson } from "../flow-reader.js";

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
      (s: string) => workflow.steps[s as AgentStep] === "done",
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

export function resolveFlowDir(
  taskFlowsDir: string,
  flowId: string,
  workspaceName?: string,
): string {
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

export function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function parseTokenNumber(value: string): number {
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

export function startWatcher(
  config: DashboardConfig,
  scriptDir: string,
  flowId: string,
  workspaceName?: string,
): void {
  const watcherScript = path.join(scriptDir, "watcher/index.js");
  const flowDir = workspaceName
    ? path.join(config.taskFlowsDir, workspaceName, flowId)
    : path.join(config.taskFlowsDir, flowId);
  const logDir = path.join(flowDir, "logs");
  const logFile = path.join(logDir, "watcher.log");

  fs.mkdirSync(logDir, { recursive: true });

  const args = [watcherScript, flowId];
  if (workspaceName) {
    args.push("--workspace-name", workspaceName);
  }

  const watcher = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")],
  });
  watcher.unref();
}

export function restartWatcher(
  config: DashboardConfig,
  scriptDir: string,
  flowId: string,
  workspaceName?: string,
): number {
  const killedCount = stopWatcherProcesses(flowId);
  startWatcher(config, scriptDir, flowId, workspaceName);
  return killedCount;
}

export function stopWatcherProcesses(flowId: string): number {
  let output = "";
  const pgrepCommand = resolvePgrepCommand();

  try {
    output = execFileSync(pgrepCommand, ["-f", `watcher/index.js ${flowId}`], {
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    return 0;
  }

  const pids = output
    .split("\n")
    .map((pid) => Number(pid.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);

  let killedCount = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killedCount++;
    } catch {
      // Process already exited.
    }
  }

  return killedCount;
}

export function resolvePgrepCommand(): string {
  for (const candidate of ["/usr/bin/pgrep", "/bin/pgrep"]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "pgrep";
}

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { DashboardConfig } from "../config.js";

function resolvePgrepCommand(): string {
  for (const candidate of ["/usr/bin/pgrep", "/bin/pgrep"]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "pgrep";
}

export function startWatcher(
  config: DashboardConfig,
  scriptDir: string,
  flowId: string,
  workspaceName?: string
): void {
  const watcherScript = path.join(scriptDir, "watcher/index.js");
  const flowDir = workspaceName ? path.join(config.taskFlowsDir, workspaceName, flowId) : path.join(config.taskFlowsDir, flowId);
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

export function restartWatcher(
  config: DashboardConfig,
  scriptDir: string,
  flowId: string,
  workspaceName?: string
): number {
  const killedCount = stopWatcherProcesses(flowId);
  startWatcher(config, scriptDir, flowId, workspaceName);
  return killedCount;
}

export function startOrchestrator(
  scriptDir: string,
  workflowId?: string,
  workspaceName?: string,
  workspacePath?: string,
  jiraKey?: string,
  customPrompt?: string
): string {
  const orchestratorScript = path.join(scriptDir, "orchestrator/index.js");
  const args = ["start"];

  if (workflowId) {
    args.push("--workflow", workflowId);
  }

  if (workspaceName) {
    args.push("--workspace-name", workspaceName);
  }

  if (workspacePath) {
    args.push("--workspace-dir", workspacePath);
  }

  if (jiraKey && customPrompt) {
    args.push(jiraKey, customPrompt);
  } else if (jiraKey) {
    args.push(jiraKey);
  } else if (customPrompt) {
    args.push("--prompt", customPrompt);
  }

  const output = execFileSync(
    process.execPath,
    [orchestratorScript, ...args],
    {
      cwd: scriptDir,
      encoding: "utf8",
      timeout: 15000,
    },
  );

  const match = output.match(/Workflow started: (flow_\S+)/);
  if (!match) {
    throw new Error("Failed to parse flow ID from orchestrator output");
  }

  return match[1];
}

export function stopOrchestrator(scriptDir: string, flowId: string): void {
  const orchestratorScript = path.join(scriptDir, "orchestrator/index.js");
  try {
    execFileSync(process.execPath, [orchestratorScript, "stop", flowId], {
      cwd: scriptDir,
      encoding: "utf8",
      timeout: 15000,
    });
  } catch (err) {
    // Ignore if already stopped or doesn't exist
  }
}

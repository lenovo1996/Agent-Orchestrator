import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync, spawn } from "node:child_process";
import type { DashboardConfig } from "../config.js";
import { db } from "../db.js";
import type { FlowSummary, AgentStep } from "@devteam-dashboard/shared";
import { readWorkflowJson, readOutputContent } from "../flow-reader.js";
import { getOutputFilename } from "../utils.js";

const STEPS: AgentStep[] = [
  "clarifier",
  "architect",
  "planner",
  "implementer",
  "verifier",
];

export function flowsRouter(config: DashboardConfig): Router {
  const router = Router();

  /**
   * GET /api/flows
   * Returns list of FlowSummary for all valid flows in task-flows directory.
   */
  router.get("/flows", (req, res) => {
    const workspaceId = req.query.workspaceId as string;

    if (workspaceId) {
      db.get('SELECT name FROM workspaces WHERE id = ?', [workspaceId], (err, row: any) => {
        if (err || !row) {
           res.json({ flows: [] });
           return;
        }
        const dir = path.join(config.taskFlowsDir, row.name);
        const flows = listFlows(dir);
        res.json({ flows });
      });
    } else {
      const flows = listFlows(config.taskFlowsDir);
      res.json({ flows });
    }
  });

  /**
   * GET /api/flows/:flowId
   * Returns full WorkflowState for a specific flow.
   */
  router.get("/flows/:flowId", (req, res) => {
    const { flowId } = req.params;
    const workspaceName = req.query.workspaceName as string;
    const flowDir = resolveFlowDir(config.taskFlowsDir, flowId, workspaceName);
    const workflow = readWorkflowJson(flowDir);

    if (!workflow) {
      res.status(404).json({ error: "Flow not found" });
      return;
    }

    res.json({ workflow });
  });

  /**
   * GET /api/flows/:flowId/logs/:step
   * Returns last 1000 lines of the step's log file.
   */
  router.get("/flows/:flowId/logs/:step", (req, res) => {
    const { flowId, step } = req.params;
    const workspaceName = req.query.workspaceName as string;
    const flowDir = resolveFlowDir(config.taskFlowsDir, flowId, workspaceName);
    const logPath = path.join(flowDir, "logs", `${step}.log`);

    if (!fs.existsSync(logPath)) {
      res.json({ lines: [] });
      return;
    }

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n");
    // Return last 1000 lines max
    res.json({ lines: lines.slice(-1000) });
  });

  /**
   * GET /api/flows/:flowId/output/:step
   * Returns markdown content + metadata for a step's output file.
   */
  router.get("/flows/:flowId/output/:step", (req, res) => {
    const { flowId, step } = req.params;
    const workspaceName = req.query.workspaceName as string;
    const filename = getOutputFilename(step, config.scriptDir);

    if (!filename) {
      res.status(400).json({ error: "Invalid step" });
      return;
    }

    const flowDir = resolveFlowDir(config.taskFlowsDir, flowId, workspaceName);
    const filePath = path.join(flowDir, "output", filename);
    const result = readOutputContent(filePath);

    if (!result) {
      res.json({ content: null, exists: false });
      return;
    }

    res.json({
      content: result.content,
      exists: true,
      metadata: result.metadata,
    });
  });

  /**
   * GET /api/flows/:flowId/tokens
   * Returns token counts per step parsed from full log files.
   * Scans entire log (not just last 1000 lines) for "tokens used" patterns.
   */
  router.get("/flows/:flowId/tokens", (req, res) => {
    const { flowId } = req.params;
    const workspaceName = req.query.workspaceName as string;
    const flowDir = resolveFlowDir(config.taskFlowsDir, flowId, workspaceName);

    if (!fs.existsSync(flowDir)) {
      res.status(404).json({ error: "Flow not found" });
      return;
    }

    const workflow = readWorkflowJson(flowDir);
    const stepsToUse = workflow?.stepOrder || STEPS;

    const tokens: Record<string, number> = {};
    const outputTimes: Record<string, string | null> = {};
    let total = 0;

    for (const step of stepsToUse) {
      // Parse tokens from log
      const logPath = path.join(flowDir, "logs", `${step}.log`);
      if (!fs.existsSync(logPath)) {
        tokens[step] = 0;
      } else {
        try {
          const content = fs.readFileSync(logPath, "utf8");
          const stepTokens = extractTokensFromLog(content).reduce(
            (sum, value) => sum + value,
            0,
          );
          tokens[step] = stepTokens;
          total += stepTokens;
        } catch {
          tokens[step] = 0;
        }
      }

      // Get output file mtime (completion time for each step)
      const outputFilename = getOutputFilename(step, config.scriptDir);
      if (outputFilename) {
        const outputPath = path.join(flowDir, "output", outputFilename);
        try {
          const stat = fs.statSync(outputPath);
          outputTimes[step] = stat.mtime.toISOString();
        } catch {
          outputTimes[step] = null;
        }
      } else {
        outputTimes[step] = null;
      }
    }

    res.json({ tokens, total, outputTimes });
  });

  /**
   * POST /api/flows/:flowId/retry
   * Retry a specific step. Body: { step, clearOutput?: boolean, prompt?: string }
   */
  router.post("/flows/:flowId/retry", (req, res) => {
    const { flowId } = req.params;
    const {
      step,
      clearOutput = true,
      prompt,
      workspaceName,
    } = req.body as { step: string; clearOutput?: boolean; prompt?: string; workspaceName?: string };

    try {
      const scriptDir = config.scriptDir;
      const retryLib = path.join(scriptDir, "orchestrator", "retry-flow.js");

      const retryExpression = `require(${JSON.stringify(retryLib)}).prepareRetry(${JSON.stringify(flowId)}, ${JSON.stringify(step)}, { clearOutput: ${clearOutput}, source: 'manual', prompt: ${prompt !== undefined ? JSON.stringify(prompt) : "undefined"} })`;
      execFileSync(process.execPath, ["-e", retryExpression], {
        cwd: scriptDir,
        encoding: "utf8",
        timeout: 10000,
      });

      const spawnScript = path.join(scriptDir, "api/spawn.js");
      const spawnArgs = [spawnScript, flowId, step];
      if (workspaceName) {
         spawnArgs.push("--workspace-name", workspaceName);
      }

      const child = spawn(process.execPath, spawnArgs, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      const killedWatchers = restartWatcher(config, scriptDir, flowId, workspaceName);

      res.json({
        success: true,
        message: `Retrying ${step} for ${flowId}`,
        watcher: {
          restarted: true,
          killed: killedWatchers,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/flows/:flowId/stop
   * Stop a workflow (kill agents, watcher, update status).
   */
  router.post("/flows/:flowId/stop", (req, res) => {
    const { flowId } = req.params;
    const { workspaceName } = req.body || {};

    try {
      const scriptDir = config.scriptDir;
      const orchestratorScript = path.join(scriptDir, "orchestrator/index.js");

      const args = ["stop", flowId];
      if (workspaceName) {
        args.push("--workspace-name", workspaceName);
      }

      execFileSync(process.execPath, [orchestratorScript, ...args], {
        cwd: scriptDir,
        encoding: "utf8",
        timeout: 15000,
      });

      res.json({ success: true, message: `Stopped workflow ${flowId}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/flows/start
   * Start a new workflow with optional jira key and custom prompt.
   * Body: { jiraKey?: string, customPrompt?: string, workflowId?: string }
   */
  router.post("/flows/start", (req, res) => {
    const {
      jiraKey = "",
      customPrompt = "",
      workflowId = "",
      workspaceId = "",
    } = req.body as {
      jiraKey?: string;
      customPrompt?: string;
      workflowId?: string;
      workspaceId?: string;
    };

    if (!jiraKey && !customPrompt) {
      res
        .status(400)
        .json({ error: "Either jiraKey or customPrompt is required" });
      return;
    }

    try {
      const scriptDir = config.scriptDir;
      const orchestratorScript = path.join(scriptDir, "orchestrator/index.js");

      // Fetch workspace path if workspaceId is provided
      if (workspaceId) {
        db.get('SELECT name, path FROM workspaces WHERE id = ?', [workspaceId], (err, row: any) => {
          if (err || !row) {
            return res.status(404).json({ error: "Workspace not found" });
          }
          executeStart(row.name, row.path);
        });
      } else {
        executeStart();
      }

      function executeStart(workspaceName?: string, workspacePath?: string) {
        // Start workflow via orchestrator
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
        } else {
          args.push("--prompt", customPrompt);
        }

        try {
          const output = execFileSync(
            process.execPath,
            [orchestratorScript, ...args],
            {
              cwd: scriptDir,
              encoding: "utf8",
              timeout: 15000,
            },
          );

          // Extract flow ID from output
          const match = output.match(/Workflow started: (flow_\S+)/);
          if (!match) {
            res
              .status(500)
              .json({ error: "Failed to parse flow ID from orchestrator output" });
            return;
          }

          const flowId = match[1];

          startWatcher(config, scriptDir, flowId, workspaceName);

          res.json({
            success: true,
            flowId,
            message: `Workflow ${flowId} started successfully`,
          });
        } catch (execErr) {
          const message = execErr instanceof Error ? execErr.message : String(execErr);
          res.status(500).json({ error: message });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * DELETE /api/flows/:flowId
   * Delete a specific flow. Body: { deleteMemory: boolean, workspaceName?: string }
   */
  router.delete("/flows/:flowId", (req, res) => {
    const { flowId } = req.params;
    const { deleteMemory = false, workspaceName } = req.body as {
      deleteMemory?: boolean;
      workspaceName?: string;
    };

    try {
      const flowDir = resolveFlowDir(config.taskFlowsDir, flowId, workspaceName);
      const workflow = readWorkflowJson(flowDir);

      // 1. Stop the workflow first
      const scriptDir = config.scriptDir;
      const orchestratorScript = path.join(scriptDir, "orchestrator/index.js");

      try {
        const stopArgs = [orchestratorScript, "stop", flowId];
        if (workspaceName) {
          stopArgs.push("--workspace-name", workspaceName);
        }

        execFileSync(process.execPath, stopArgs, {
          cwd: scriptDir,
          encoding: "utf8",
          timeout: 15000,
        });
      } catch (err) {
        // Ignore if already stopped or doesn't exist
      }

      // 2. Remove from task-flows directory
      if (fs.existsSync(flowDir)) {
        fs.rmSync(flowDir, { recursive: true, force: true });
      }

      // 3. Optional: Delete memory context
      if (deleteMemory) {
        try {
          // Resolve task ID from workflow.json if available
          const taskId = workflow?.jiraKey || flowId;

          const teamConfigPath = path.join(config.repoRoot, "team.json");
          let teamConfig: any = {};
          if (fs.existsSync(teamConfigPath)) {
            try {
               teamConfig = JSON.parse(fs.readFileSync(teamConfigPath, "utf8"));
            } catch (e) {}
          }

          const taskDir = path.join(config.repoRoot, ".tasks", taskId);
          const memoryFlowDir = path.join(taskDir, "flows", flowId);
          const metaPath = path.join(taskDir, "meta.json");

          if (fs.existsSync(memoryFlowDir)) {
            fs.rmSync(memoryFlowDir, { recursive: true, force: true });
          }

          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (meta.flows) {
              meta.flows = meta.flows.filter((f: any) => f.flow_id !== flowId);
            }
            if (!meta.flows || meta.flows.length === 0) {
              fs.rmSync(taskDir, { recursive: true, force: true });
            } else {
              fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            }
          }
        } catch (e) {}
      }

      res.json({ success: true, message: `Deleted workflow ${flowId}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/git/status
   * Returns git status for each jinjer_* subdirectory in the repo root.
   */
  router.get("/git/status", (_req, res) => {
    try {
      const repoRoot = path.resolve(config.taskFlowsDir, "../..");

      // Find all jinjer_* directories
      const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
      const repos = entries
        .filter((e) => e.isDirectory() && e.name.startsWith("jinjer_"))
        .map((e) => e.name);

      const results: Array<{
        repo: string;
        branch: string;
        files: string[];
        error?: string;
      }> = [];

      for (const repo of repos) {
        const repoDir = path.join(repoRoot, repo);
        try {
          const branch = execSync("git branch --show-current", {
            cwd: repoDir,
            encoding: "utf8",
            timeout: 5000,
          }).trim();

          const output = execSync("git status --short", {
            cwd: repoDir,
            encoding: "utf8",
            timeout: 10000,
          });

          results.push({
            repo,
            branch,
            files: output.trim().split("\n").filter(Boolean),
          });
        } catch (err) {
          results.push({
            repo,
            branch: "",
            files: [],
            error:
              err instanceof Error ? err.message.split("\n")[0] : String(err),
          });
        }
      }

      res.json({ repos: results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}

/**
 * Scan task-flows directory and build FlowSummary list.
 */
function listFlows(taskFlowsDir: string): FlowSummary[] {
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

function resolveFlowDir(taskFlowsDir: string, flowId: string, workspaceName?: string): string {
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

function extractTokensFromLog(content: string): number[] {
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

function startWatcher(
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

function restartWatcher(
  config: DashboardConfig,
  scriptDir: string,
  flowId: string,
  workspaceName?: string
): number {
  const killedCount = stopWatcherProcesses(flowId);
  startWatcher(config, scriptDir, flowId, workspaceName);
  return killedCount;
}

function stopWatcherProcesses(flowId: string): number {
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

function resolvePgrepCommand(): string {
  for (const candidate of ["/usr/bin/pgrep", "/bin/pgrep"]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "pgrep";
}

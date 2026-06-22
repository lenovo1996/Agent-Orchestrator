import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { DashboardConfig } from "../config.js";

export interface GitStatusResult {
  repo: string;
  branch: string;
  files: string[];
  error?: string;
}

export function getGitStatuses(config: DashboardConfig): GitStatusResult[] {
  const repoRoot = path.resolve(config.taskFlowsDir, "../..");

  // Find all jinjer_* directories
  const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  const repos = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("jinjer_"))
    .map((e) => e.name);

  const results: GitStatusResult[] = [];

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

  return results;
}

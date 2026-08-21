import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OrchestrationService } from './service.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout, encoding: 'utf8' });
  return stdout.trim();
}

export class WorktreeManager {
  constructor(private readonly service: OrchestrationService) {}

  async prepare(flowId: string): Promise<{ ready: boolean; branch: string | null }> {
    const flow = this.service.getFlow(flowId);
    if (!flow.useWorktree) return { ready: true, branch: null };
    await git(flow.workspacePath, ['rev-parse', '--git-dir']);
    const worktreePath = path.join(this.service.config.worktreesDir, flowId);
    const branch = `devteam/${flowId}`;
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    if (fs.existsSync(worktreePath)) {
      try {
        if (await git(worktreePath, ['branch', '--show-current']) === branch) {
          this.service.setWorktree(flowId, worktreePath, branch);
          return { ready: true, branch };
        }
      } catch { /* recreate through git after pruning */ }
      throw new Error(`Worktree path already exists with a different branch: ${worktreePath}`);
    }
    await git(flow.workspacePath, ['worktree', 'prune']);
    try {
      await git(flow.workspacePath, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
    } catch {
      await git(flow.workspacePath, ['worktree', 'add', worktreePath, branch]);
    }
    this.service.setWorktree(flowId, worktreePath, branch);
    return { ready: true, branch };
  }

  async finalize(flowId: string): Promise<{ success: boolean; conflicts: string[] }> {
    const flow = this.service.getFlow(flowId);
    if (!flow.useWorktree || !flow.worktreePath || !flow.worktreeBranch) {
      return { success: true, conflicts: [] };
    }
    const status = await git(flow.worktreePath, ['status', '--porcelain']);
    if (status) {
      await git(flow.worktreePath, ['add', '-A']);
      await git(flow.worktreePath, ['commit', '-m', `devteam: complete ${flow.flowId}`]);
    }
    const targetBranch = await git(flow.workspacePath, ['branch', '--show-current']);
    try {
      await git(flow.workspacePath, [
        'merge', flow.worktreeBranch, '--no-ff', '-m', `devteam: merge ${flow.worktreeBranch} into ${targetBranch}`,
      ]);
      await git(flow.workspacePath, ['worktree', 'prune']);
      return { success: true, conflicts: [] };
    } catch {
      const conflicts = (await git(flow.workspacePath, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      try { await git(flow.workspacePath, ['merge', '--abort']); } catch { /* leave structured failure */ }
      return { success: false, conflicts };
    }
  }
}

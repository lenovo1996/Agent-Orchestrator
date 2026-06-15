/**
 * lib/worktree-manager.js — Git worktree lifecycle manager
 *
 * Manages creation, removal, listing, merging, and cleanup of
 * git worktrees for parallel task execution.
 *
 * Exports: WorktreeManager
 */

'use strict';

const childProcess = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolve: resolveBranch } = require('./branch-resolver');

/**
 * @typedef {Object} WorktreeInfo
 * @property {string} flowId
 * @property {string} path
 * @property {string} branch
 * @property {string} repo
 * @property {'active'|'done'|'failed'|'merged'} status
 * @property {string} createdAt
 * @property {number} [agentPid]
 */

/**
 * @typedef {Object} WorktreeError
 * @property {'GIT_ERROR'|'DIRTY_REPO'|'PATH_EXISTS'|'NOT_FOUND'} code
 * @property {string} message
 * @property {string} [stderr]
 * @property {number} [exitCode]
 */

/**
 * @typedef {Object} MergeResult
 * @property {boolean} success
 * @property {string} flowId
 * @property {string} branch
 * @property {string} targetBranch
 * @property {number} [commits]
 * @property {string[]} [conflictFiles]
 * @property {boolean} dryRun
 */

/**
 * @typedef {Object} CleanupResult
 * @property {string[]} removed
 * @property {Array<{flowId: string, error: string}>} failed
 * @property {string[]} skippedUnmerged
 */

class WorktreeManager {
  /**
   * @param {Object} config
   * @param {string} config.baseDir - Base directory for worktrees
   * @param {Object} [config.repos] - Repository path mapping
   */
  constructor(config = {}) {
    this.baseDir = config.baseDir || './.dev-team-worktrees';
    this.repos = config.repos || {};
    this._registry = new Map();
  }

  /**
   * Create a new worktree for a flow step.
   * @param {string} flowId
   * @param {string} step
   * @param {string} repoPath
   * @param {string} baseBranch
   * @returns {WorktreeInfo|WorktreeError}
   */
  create(flowId, step, repoPath, baseBranch) {
    // 1. Check for dirty repo
    try {
      const status = childProcess.execSync('git status --porcelain', {
        cwd: repoPath,
        encoding: 'utf8'
      });
      if (status.trim().length > 0) {
        return {
          code: 'DIRTY_REPO',
          message: `Repository at ${repoPath} has uncommitted changes. Commit or stash before creating a worktree.`
        };
      }
    } catch (err) {
      return {
        code: 'GIT_ERROR',
        message: `Failed to check repository status: ${err.message}`,
        stderr: err.stderr ? err.stderr.toString() : '',
        exitCode: err.status || 1
      };
    }

    // 2. Resolve branch name
    const branch = resolveBranch(flowId, step, baseBranch);

    // 3. Build worktree path from configured baseDir
    const worktreePath = path.resolve(this.baseDir, flowId, step);

    // 4. Ensure baseDir exists
    const worktreeDir = path.dirname(worktreePath);
    if (!fs.existsSync(worktreeDir)) {
      fs.mkdirSync(worktreeDir, { recursive: true });
    }

    // 5. Create worktree via git
    try {
      childProcess.execSync(`git worktree add -b ${branch} ${worktreePath} ${baseBranch}`, {
        cwd: repoPath,
        encoding: 'utf8'
      });
    } catch (err) {
      return {
        code: 'GIT_ERROR',
        message: `Failed to create worktree: ${err.message}`,
        stderr: err.stderr ? err.stderr.toString() : '',
        exitCode: err.status || 1
      };
    }

    // 6. Build WorktreeInfo and register
    const info = {
      flowId,
      path: worktreePath,
      branch,
      repo: repoPath,
      status: 'active',
      createdAt: new Date().toISOString()
    };

    this._registry.set(flowId, info);

    return info;
  }

  /**
   * Remove a worktree by flow ID.
   * @param {string} flowId
   * @returns {{success: boolean, error?: string}}
   */
  remove(flowId) {
    const entry = this._registry.get(flowId);
    if (!entry) {
      return { success: false, error: `Worktree not found for flow: ${flowId}` };
    }

    if (entry.status === 'active') {
      return { success: false, error: 'Cannot remove active worktree' };
    }

    try {
      childProcess.execSync(`git worktree remove ${entry.path}`, {
        cwd: entry.repo,
        encoding: 'utf8'
      });
    } catch (err) {
      return {
        success: false,
        error: `Failed to remove worktree: ${err.message}`
      };
    }

    this._registry.delete(flowId);
    return { success: true };
  }

  /**
   * List all tracked worktrees.
   * @returns {WorktreeInfo[]}
   */
  list() {
    return Array.from(this._registry.values());
  }

  /**
   * Get worktree path for a flow.
   * @param {string} flowId
   * @returns {string|null}
   */
  getPath(flowId) {
    const entry = this._registry.get(flowId);
    return entry ? entry.path : null;
  }

  /**
   * Check if a worktree is currently active.
   * @param {string} flowId
   * @returns {boolean}
   */
  isActive(flowId) {
    const entry = this._registry.get(flowId);
    return entry != null && entry.status === 'active';
  }

  /**
   * Merge a completed flow's branch into a target branch.
   * @param {string} flowId
   * @param {string} targetBranch
   * @param {boolean} [dryRun=false]
   * @returns {MergeResult}
   */
  merge(flowId, targetBranch, dryRun = false) {
    const entry = this._registry.get(flowId);

    // Flow not found
    if (!entry) {
      return {
        success: false,
        flowId,
        branch: '',
        targetBranch,
        commits: 0,
        conflictFiles: [],
        dryRun
      };
    }

    // Validate flow status === 'done' (Requirement 8.5)
    if (entry.status !== 'done') {
      return {
        success: false,
        flowId,
        branch: entry.branch || '',
        targetBranch,
        commits: 0,
        conflictFiles: [],
        dryRun
      };
    }

    const branch = entry.branch;
    const repoPath = entry.repo;

    // Dry-run mode: show commits that would be merged (Requirement 8.3)
    if (dryRun) {
      try {
        const logOutput = childProcess.execSync(
          `git log ${targetBranch}..${branch} --oneline`,
          { cwd: repoPath, encoding: 'utf8' }
        );
        const commits = logOutput.trim() ? logOutput.trim().split('\n').length : 0;
        return {
          success: true,
          flowId,
          branch,
          targetBranch,
          commits,
          conflictFiles: [],
          dryRun: true
        };
      } catch (err) {
        return {
          success: false,
          flowId,
          branch,
          targetBranch,
          commits: 0,
          conflictFiles: [],
          dryRun: true
        };
      }
    }

    // Actual merge (Requirement 8.1)
    try {
      // Step 1: Checkout target branch
      childProcess.execSync(`git checkout ${targetBranch}`, {
        cwd: repoPath,
        encoding: 'utf8'
      });

      // Step 2: Merge with --no-ff
      childProcess.execSync(`git merge ${branch} --no-ff`, {
        cwd: repoPath,
        encoding: 'utf8'
      });

      // Success: count merged commits
      let commits = 0;
      try {
        const logOutput = childProcess.execSync(
          `git log ${targetBranch}..${branch} --oneline`,
          { cwd: repoPath, encoding: 'utf8' }
        );
        commits = logOutput.trim() ? logOutput.trim().split('\n').length : 0;
      } catch (e) {
        // After merge, the range may be empty — that's fine, commits = 0
        commits = 0;
      }

      // Update registry status to 'merged' (Requirement 8.4)
      entry.status = 'merged';
      this._registry.set(flowId, entry);

      return {
        success: true,
        flowId,
        branch,
        targetBranch,
        commits,
        conflictFiles: [],
        dryRun: false
      };
    } catch (mergeErr) {
      // Merge conflict detected (Requirement 8.2)
      // Abort the merge
      try {
        childProcess.execSync('git merge --abort', {
          cwd: repoPath,
          encoding: 'utf8'
        });
      } catch (abortErr) {
        // Abort may fail if not in merge state, ignore
      }

      // Get conflicting files
      let conflictFiles = [];
      try {
        const diffOutput = childProcess.execSync(
          'git diff --name-only --diff-filter=U',
          { cwd: repoPath, encoding: 'utf8' }
        );
        conflictFiles = diffOutput.trim() ? diffOutput.trim().split('\n') : [];
      } catch (diffErr) {
        // Could not get conflict files, leave empty
      }

      return {
        success: false,
        flowId,
        branch,
        targetBranch,
        commits: 0,
        conflictFiles,
        dryRun: false
      };
    }
  }

  /**
   * Cleanup completed/failed worktrees.
   * Removes worktrees with status "done" or "failed", deletes merged branches,
   * and skips branch deletion for unmerged branches.
   * @returns {CleanupResult}
   */
  cleanup() {
    /** @type {CleanupResult} */
    const result = {
      removed: [],
      failed: [],
      skippedUnmerged: []
    };

    // Collect entries eligible for cleanup (status "done" or "failed")
    const entries = Array.from(this._registry.entries()).filter(
      ([, info]) => info.status === 'done' || info.status === 'failed'
    );

    for (const [flowId, entry] of entries) {
      // 1. Remove the worktree via git
      try {
        childProcess.execSync(`git worktree remove ${entry.path}`, {
          cwd: entry.repo,
          encoding: 'utf8'
        });
      } catch (err) {
        console.error(`Failed to remove worktree for flow ${flowId}: ${err.message}`);
        result.failed.push({ flowId, error: err.message });
        continue;
      }

      // 2. Check if branch is merged and delete accordingly
      try {
        const mergedOutput = childProcess.execSync(`git branch --merged HEAD`, {
          cwd: entry.repo,
          encoding: 'utf8'
        });

        // Parse merged branches list - each line has optional leading whitespace and * for current
        const mergedBranches = mergedOutput
          .split('\n')
          .map(line => line.replace(/^\*?\s*/, '').trim())
          .filter(Boolean);

        if (mergedBranches.includes(entry.branch)) {
          // Branch is merged — safe to delete
          try {
            childProcess.execSync(`git branch -d ${entry.branch}`, {
              cwd: entry.repo,
              encoding: 'utf8'
            });
          } catch (branchErr) {
            // Branch deletion failed, but worktree was already removed — log and continue
            console.error(`Failed to delete branch ${entry.branch} for flow ${flowId}: ${branchErr.message}`);
          }
        } else {
          // Branch not merged — skip deletion, warn user
          result.skippedUnmerged.push(flowId);
        }
      } catch (mergeCheckErr) {
        // Could not determine merge status — skip branch deletion
        result.skippedUnmerged.push(flowId);
      }

      // 3. Remove from registry and mark as removed
      this._registry.delete(flowId);
      result.removed.push(flowId);
    }

    return result;
  }
}

module.exports = { WorktreeManager };

/**
 * worktree-lifecycle.js — Create, merge, and clean up git worktrees
 * Used by orchestrator and watcher to manage worktree lifecycle per task.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Create a git worktree for a task.
 * @param {object} opts
 * @param {string} opts.repoPath - Absolute path to the main repo
 * @param {string} opts.worktreePath - Absolute path for the new worktree
 * @param {string} opts.flowId - Flow ID
 * @param {string} opts.step - Step name
 * @param {string} [opts.taskKey] - Task key for branch name (e.g. TASK-001)
 * @param {string} [opts.baseBranch] - Base branch to branch from (default: auto-detect)
 * @returns {{ success: boolean, branch?: string, error?: string }}
 */
function createWorktree({ repoPath, worktreePath, flowId, step, taskKey, baseBranch }) {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return { success: false, error: `Repo not found: ${repoPath}` };
  }

  // Auto-detect base branch if not specified
  if (!baseBranch) {
    try {
      baseBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
    } catch (e) {
      baseBranch = 'main';
    }
  }

  // Use task key for branch name if available (e.g. feat/TASK-001)
  // Fallback: extract suffix from flowId, then step
  const branchName = taskKey || flowId.replace(/^flow_\d+_/, '') || step;
  const branch = `feat/${branchName}`;

  // Quote paths for shell safety
  const qWp = JSON.stringify(worktreePath);
  const qRp = JSON.stringify(repoPath);
  const qBb = JSON.stringify(baseBranch);

  // Create parent dir if needed
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Check if worktree path already exists
  if (fs.existsSync(worktreePath)) {
    // Already exists — try to reuse
    try {
      const wtBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: worktreePath, encoding: 'utf8' }).trim();
      if (wtBranch === branch) {
        console.log(`♻️  Reusing existing worktree: ${worktreePath} (${branch})`);
        return { success: true, branch };
      }
    } catch (e) {
      // Not a git worktree, remove and recreate
      execSync(`rm -rf ${qWp}`, { encoding: 'utf8', timeout: 10000, shell: true });
    }
  }

  try {
    // Clean any stale worktree references first
    try { execSync('git worktree prune', { cwd: repoPath, encoding: 'utf8', timeout: 10000 }); } catch (e) {}

    // Create the worktree with a new branch
    execSync(`git worktree add -b ${branch} ${qWp} ${qBb}`, {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 30000,
      shell: true
    });

    console.log(`🌲 Created worktree: ${worktreePath} (branch: ${branch})`);
    return { success: true, branch };
  } catch (err) {
    // If branch already exists, try checking out into the worktree
    try {
      execSync(`git worktree add ${qWp} ${branch}`, {
        cwd: repoPath,
        encoding: 'utf8',
        timeout: 30000,
        shell: true
      });
      console.log(`🌲 Reattached worktree: ${worktreePath} (branch: ${branch})`);
      return { success: true, branch };
    } catch (err2) {
      return { success: false, error: `Failed to create worktree: ${err2.message}` };
    }
  }
}

/**
 * Commit all changes in a worktree.
 * @param {string} worktreePath - Path to the worktree
 * @param {string} message - Commit message
 * @returns {{ success: boolean, hash?: string, error?: string, skipped?: boolean }}
 */
function commitWorktree(worktreePath, message) {
  if (!fs.existsSync(worktreePath)) {
    return { success: false, error: `Worktree not found: ${worktreePath}` };
  }

  try {
    // Stage all changes
    execSync('git add -A', { cwd: worktreePath, encoding: 'utf8', timeout: 15000 });

    // Check if there's anything to commit
    try {
      execSync('git diff --cached --quiet', { cwd: worktreePath, encoding: 'utf8' });
      return { success: true, skipped: true }; // Nothing to commit
    } catch (e) {
      // diff --cached --quiet exits 1 if there are staged changes
    }

    // Commit — use execFileSync to avoid shell injection
    const { execFileSync } = require('child_process');
    execFileSync('git', ['commit', '-m', message], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 15000
    });

    const hash = execSync('git rev-parse --short HEAD', { cwd: worktreePath, encoding: 'utf8' }).trim();
    console.log(`📦 Committed in worktree: ${hash} — ${message}`);
    return { success: true, hash };
  } catch (err) {
    return { success: false, error: `Commit failed: ${err.message}` };
  }
}

/**
 * Merge a worktree branch into the repo's main branch.
 * @param {object} opts
 * @param {string} opts.repoPath - Path to the main repo
 * @param {string} opts.worktreePath - Path to the worktree
 * @param {string} opts.branch - Branch name to merge
 * @param {string} [opts.targetBranch] - Target branch (default: auto-detect main)
 * @returns {{ success: boolean, conflicts?: string[], error?: string }}
 */
function mergeWorktreeBranch({ repoPath, worktreePath, branch, targetBranch }) {
  if (!targetBranch) {
    try {
      targetBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
    } catch (e) {
      targetBranch = 'main';
    }
  }

  try {
    // First, make sure all changes in worktree are committed
    const commitResult = commitWorktree(worktreePath, `feat: complete ${branch}`);
    if (!commitResult.success && !commitResult.skipped) {
      return { success: false, error: `Cannot commit worktree changes: ${commitResult.error}` };
    }

    // Checkout target branch in main repo
    execSync(`git checkout ${targetBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: 15000 });

    // Merge branch (local, no need to fetch from origin)
    try {
      const { execFileSync: eF } = require('child_process');
      eF('git', ['merge', branch, '--no-ff', '-m', `merge: ${branch} into ${targetBranch}`], {
        cwd: repoPath,
        encoding: 'utf8',
        timeout: 30000
      });
      console.log(`✅ Merged ${branch} → ${targetBranch}`);
      return { success: true, conflicts: [] };
    } catch (mergeErr) {
      // Merge conflict!
      // Get list of conflicted files
      let conflictFiles = [];
      try {
        const status = execSync('git diff --name-only --diff-filter=U', {
          cwd: repoPath, encoding: 'utf8', timeout: 10000
        }).trim();
        conflictFiles = status ? status.split('\n') : [];
      } catch (e) {}

      // Abort the merge
      try { execSync('git merge --abort', { cwd: repoPath, encoding: 'utf8', timeout: 10000 }); } catch (e) {}

      console.error(`❌ Merge conflict: ${branch} → ${targetBranch} (${conflictFiles.length} files)`);
      return {
        success: false,
        conflicts: conflictFiles,
        error: `Merge conflict on ${conflictFiles.length} file(s): ${conflictFiles.join(', ')}`
      };
    }
  } catch (err) {
    return { success: false, error: `Merge failed: ${err.message}` };
  }
}

/**
 * Full lifecycle: commit + merge + cleanup.
 * @param {object} opts
 * @param {string} opts.repoPath - Main repo path
 * @param {string} opts.worktreePath - Worktree path
 * @param {string} opts.branch - Branch name
 * @param {string} [opts.targetBranch] - Target branch
 * @param {string} [opts.commitMsg] - Commit message
 * @returns {{ success: boolean, conflicts?: string[], error?: string }}
 */
function finalizeWorktree({ repoPath, worktreePath, branch, targetBranch, commitMsg }) {
  const msg = commitMsg || `feat: complete ${branch}`;

  // Step 1: Commit changes in worktree
  const commitResult = commitWorktree(worktreePath, msg);

  // Step 2: Merge branch into main repo
  const mergeResult = mergeWorktreeBranch({ repoPath, worktreePath, branch, targetBranch });

  if (!mergeResult.success) {
    return mergeResult;
  }

  // Step 3: Prune stale refs (keep worktree, don't remove)
  try { execSync('git worktree prune', { cwd: repoPath, encoding: 'utf8', timeout: 10000 }); } catch (e) {}

  console.log(`📁 Worktree preserved: ${worktreePath}`);
  return { success: true, conflicts: [] };
}

/**
 * Merge multiple dependency branches into a single base branch for a dependent task.
 * Creates a temporary merged branch that combines all dependency results.
 *
 * @param {object} opts
 * @param {string} opts.repoPath - Absolute path to the main repo
 * @param {string[]} opts.dependencyBranches - Array of branch names to merge (e.g. ['feat/TASK-001', 'feat/TASK-002'])
 * @param {string} opts.mergedBranchName - Name for the merged branch (e.g. 'merged-for-TASK-003')
 * @param {string} [opts.baseBranch] - Starting point branch (default: auto-detect main)
 * @returns {{ success: boolean, mergedBranch?: string, conflicts?: string[], error?: string }}
 */
function mergeDependencyBranches({ repoPath, dependencyBranches, mergedBranchName, baseBranch }) {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return { success: false, error: `Repo not found: ${repoPath}` };
  }

  if (!dependencyBranches || dependencyBranches.length === 0) {
    return { success: false, error: 'No dependency branches provided' };
  }

  // Auto-detect base branch if not specified
  if (!baseBranch) {
    try {
      baseBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
    } catch (e) {
      baseBranch = 'main';
    }
  }

  // If only one dependency, no need to merge — just return that branch
  if (dependencyBranches.length === 1) {
    console.log(`📌 Single dependency: using branch ${dependencyBranches[0]} directly`);
    return { success: true, mergedBranch: dependencyBranches[0] };
  }

  console.log(`🔀 Merging ${dependencyBranches.length} dependency branches...`);
  console.log(`   Branches: ${dependencyBranches.join(', ')}`);
  console.log(`   Base: ${baseBranch}`);

  try {
    // Clean any stale worktree references
    try { execSync('git worktree prune', { cwd: repoPath, encoding: 'utf8', timeout: 10000 }); } catch (e) {}

    // Delete merged branch if it exists (from previous attempt)
    try {
      execSync(`git branch -D ${mergedBranchName}`, { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
    } catch (e) { /* branch doesn't exist, ok */ }

    // Create merged branch from base
    execSync(`git checkout -b ${mergedBranchName} ${baseBranch}`, {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 15000
    });

    // Merge each dependency branch sequentially
    for (const depBranch of dependencyBranches) {
      console.log(`   🔀 Merging ${depBranch} into ${mergedBranchName}...`);

      try {
        const { execFileSync } = require('child_process');
        execFileSync('git', ['merge', depBranch, '--no-ff', '-m', `merge: ${depBranch} into ${mergedBranchName}`], {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: 30000
        });
        console.log(`   ✅ Merged ${depBranch}`);
      } catch (mergeErr) {
        // Merge conflict!
        let conflictFiles = [];
        try {
          const status = execSync('git diff --name-only --diff-filter=U', {
            cwd: repoPath, encoding: 'utf8', timeout: 10000
          }).trim();
          conflictFiles = status ? status.split('\n') : [];
        } catch (e) {}

        // Abort the merge
        try { execSync('git merge --abort', { cwd: repoPath, encoding: 'utf8', timeout: 10000 }); } catch (e) {}

        // Go back to base branch
        try { execSync(`git checkout ${baseBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: 10000 }); } catch (e) {}

        // Delete the failed merged branch
        try { execSync(`git branch -D ${mergedBranchName}`, { cwd: repoPath, encoding: 'utf8', timeout: 10000 }); } catch (e) {}

        console.error(`❌ Merge conflict: ${depBranch} into ${mergedBranchName} (${conflictFiles.length} files)`);
        return {
          success: false,
          conflicts: conflictFiles,
          error: `Merge conflict on ${conflictFiles.length} file(s) when merging ${depBranch}: ${conflictFiles.join(', ')}`
        };
      }
    }

    // Go back to base branch after merging
    execSync(`git checkout ${baseBranch}`, {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 15000
    });

    console.log(`✅ All dependency branches merged into ${mergedBranchName}`);
    return { success: true, mergedBranch: mergedBranchName };

  } catch (err) {
    // Cleanup on error
    try { execSync(`git checkout ${baseBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: 10000 }); } catch (e) {}
    try { execSync(`git branch -D ${mergedBranchName}`, { cwd: repoPath, encoding: 'utf8', timeout: 10000 }); } catch (e) {}
    return { success: false, error: `Failed to merge dependency branches: ${err.message}` };
  }
}

module.exports = { createWorktree, commitWorktree, mergeWorktreeBranch, finalizeWorktree, mergeDependencyBranches };

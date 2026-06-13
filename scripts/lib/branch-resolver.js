/**
 * lib/branch-resolver.js — Branch naming resolver for worktrees
 *
 * Determines the branch name to use when creating a worktree
 * for a given flow and step.
 *
 * Exports: resolve
 */

'use strict';

/**
 * Resolve branch name for a worktree.
 *
 * @param {string} flowId - The flow identifier
 * @param {string} step - The step name (e.g. 'implementer')
 * @param {string} baseBranch - The base branch to branch from
 * @returns {string} Branch name in format: worktree/{flowId}/{step}
 */
function resolve(flowId, step, baseBranch) {
  return `worktree/${flowId}/${step}`;
}

module.exports = { resolve };

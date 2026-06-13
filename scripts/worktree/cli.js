#!/usr/bin/env node
/**
 * worktree-cli.js — CLI for managing parallel worktrees
 *
 * Commands:
 *   list              List all tracked worktrees
 *   cleanup           Remove completed/failed worktrees
 *   merge <flow-id>   Merge a completed flow's branch
 *   status            Show parallel scheduler status
 *
 * Usage:
 *   node worktree-cli.js list
 *   node worktree-cli.js cleanup
 *   node worktree-cli.js merge <flow-id> [--target <branch>] [--dry-run]
 *   node worktree-cli.js status
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { WorktreeManager } = require('./worktree-manager');
const { ParallelScheduler } = require('./parallel-scheduler');

/**
 * Parse CLI arguments into command and options.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{command: string, args: string[], options: Object}}
 */
function parseArgs(argv) {
  const command = argv[0] || 'help';
  const args = [];
  const options = {};

  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      // Boolean flags (no value following)
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = argv[++i];
      }
    } else {
      args.push(argv[i]);
    }
  }

  return { command, args, options };
}

/**
 * Load team.json configuration.
 * @returns {Object}
 */
function loadConfig() {
  const configPath = path.resolve(__dirname, '..', 'team.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Error: Could not read team.json at ${configPath}: ${err.message}`);
    return {};
  }
}

/**
 * Display help message.
 */
function showHelp() {
  console.log(`
Usage: node worktree-cli.js <command> [options]

Commands:
  list                          List all tracked worktrees
  cleanup                       Remove completed/failed worktrees
  merge <flow-id> [options]     Merge a completed flow's branch
  status                        Show parallel scheduler status
  help                          Show this help message

Merge Options:
  --target <branch>   Target branch to merge into (default: main)
  --dry-run           Show what would be merged without executing
`.trim());
}

/**
 * Format a table row with fixed-width columns.
 * @param {string[]} values
 * @param {number[]} widths
 * @returns {string}
 */
function formatRow(values, widths) {
  return values.map((val, i) => String(val).padEnd(widths[i])).join('  ');
}

/**
 * Execute the `list` command.
 * @param {WorktreeManager} manager
 */
function cmdList(manager) {
  const worktrees = manager.list();

  if (worktrees.length === 0) {
    console.log('No tracked worktrees.');
    return;
  }

  const headers = ['FLOW ID', 'BRANCH', 'REPO', 'STATUS', 'CREATED'];
  const rows = worktrees.map(wt => [
    wt.flowId || '',
    wt.branch || '',
    wt.repo || '',
    wt.status || '',
    wt.createdAt || ''
  ]);

  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );

  console.log(formatRow(headers, widths));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(formatRow(row, widths));
  }

  console.log(`\nTotal: ${worktrees.length} worktree(s)`);
}

/**
 * Execute the `cleanup` command.
 * @param {WorktreeManager} manager
 */
function cmdCleanup(manager) {
  const result = manager.cleanup();

  console.log('Cleanup complete:');
  console.log(`  Removed:          ${result.removed.length}`);
  console.log(`  Failed:           ${result.failed.length}`);
  console.log(`  Skipped (unmerged): ${result.skippedUnmerged.length}`);

  if (result.removed.length > 0) {
    console.log('\nRemoved flows:');
    for (const flowId of result.removed) {
      console.log(`  - ${flowId}`);
    }
  }

  if (result.failed.length > 0) {
    console.log('\nFailed removals:');
    for (const { flowId, error } of result.failed) {
      console.log(`  - ${flowId}: ${error}`);
    }
  }

  if (result.skippedUnmerged.length > 0) {
    console.log('\nSkipped (branch not merged):');
    for (const flowId of result.skippedUnmerged) {
      console.log(`  - ${flowId}`);
    }
  }
}

/**
 * Execute the `merge` command.
 * @param {WorktreeManager} manager
 * @param {string} flowId
 * @param {Object} options
 */
function cmdMerge(manager, flowId, options) {
  const targetBranch = options.target || 'main';
  const dryRun = options['dry-run'] === true;

  const result = manager.merge(flowId, targetBranch, dryRun);

  if (result.success) {
    if (dryRun) {
      console.log(`Dry-run merge for flow: ${flowId}`);
      console.log(`  Branch:  ${result.branch}`);
      console.log(`  Target:  ${result.targetBranch}`);
      console.log(`  Commits: ${result.commits} commit(s) would be merged`);
    } else {
      console.log(`Merge successful for flow: ${flowId}`);
      console.log(`  Branch:  ${result.branch}`);
      console.log(`  Target:  ${result.targetBranch}`);
      console.log(`  Commits: ${result.commits} commit(s) merged`);
      console.log(`  Status updated to: merged`);
    }
  } else {
    console.error(`Merge failed for flow: ${flowId}`);
    if (result.branch) {
      console.error(`  Branch:  ${result.branch}`);
    }
    console.error(`  Target:  ${result.targetBranch}`);
    if (result.conflictFiles && result.conflictFiles.length > 0) {
      console.error(`  Conflicting files:`);
      for (const file of result.conflictFiles) {
        console.error(`    - ${file}`);
      }
    }
    if (!result.branch) {
      console.error(`  Flow not found or not in "done" status.`);
    }
    process.exit(1);
  }
}

/**
 * Execute the `status` command.
 * @param {ParallelScheduler} scheduler
 */
function cmdStatus(scheduler) {
  const status = scheduler.getStatus();

  console.log('Parallel Scheduler Status:');
  console.log(`  Max Concurrency: ${status.maxConcurrency}`);
  console.log(`  Running:         ${status.running.length}`);
  console.log(`  Queued:          ${status.queue.length}`);
  console.log(`  Completed:       ${status.completed.length}`);
  console.log(`  Last Updated:    ${status.lastUpdated}`);

  if (status.running.length > 0) {
    console.log('\nRunning:');
    for (const task of status.running) {
      console.log(`  - ${task.flowId} [${task.step}] repo=${task.repo} started=${task.startedAt || 'N/A'}`);
    }
  }

  if (status.queue.length > 0) {
    console.log('\nQueued:');
    for (const task of status.queue) {
      console.log(`  - ${task.flowId} [${task.step}] repo=${task.repo} queued=${task.queuedAt || 'N/A'}`);
    }
  }

  if (status.completed.length > 0) {
    const doneCount = status.completed.filter(t => t.status === 'done').length;
    const failedCount = status.completed.filter(t => t.status === 'failed').length;
    console.log(`\nCompleted summary: ${doneCount} done, ${failedCount} failed`);
  }
}

/**
 * Main CLI entry point.
 * @param {string[]} argv - process.argv.slice(2)
 */
function main(argv) {
  const { command, args, options } = parseArgs(argv);

  // Load config and initialize manager/scheduler
  const config = loadConfig();
  const worktreeConfig = config.worktree || {};

  const manager = new WorktreeManager({
    baseDir: worktreeConfig.baseDir || '../.dev-team-worktrees',
    repos: worktreeConfig.repos || {}
  });

  const statusFile = path.resolve(__dirname, '..', 'parallel-status.json');
  const scheduler = new ParallelScheduler({
    maxConcurrency: worktreeConfig.maxConcurrency || 3,
    statusFile
  });
  scheduler.recover();

  switch (command) {
    case 'list':
      cmdList(manager);
      break;

    case 'cleanup':
      cmdCleanup(manager);
      break;

    case 'merge':
      if (!args[0]) {
        console.error('Error: merge requires a <flow-id> argument');
        process.exit(1);
      }
      cmdMerge(manager, args[0], options);
      break;

    case 'status':
      cmdStatus(scheduler);
      break;

    case 'help':
    default:
      showHelp();
      break;
  }
}

// Run if invoked directly
if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main, parseArgs };

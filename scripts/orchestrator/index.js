#!/usr/bin/env node
// orchestrator.js - Auto-spawn dev team agents with sessions_spawn

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepareRetry } = require('../orchestrator/retry-flow');
const { ParallelScheduler } = require('../orchestrator/parallel-scheduler');
const { detectRepos } = require('../orchestrator/repo-detector');
const { initTree } = require('../utils/memory-tree');

const SKILL_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SKILL_DIR, '..');
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'team.json'), 'utf8'));
const OUTPUT_ROOT = path.resolve(REPO_ROOT, TEAM_CONFIG.outputRoot || '.dev-team/task-flows');

// Worktree parallel scheduling configuration
const WORKTREE_CONFIG = TEAM_CONFIG.worktree || { enabled: false };
const scheduler = new ParallelScheduler({
  maxConcurrency: WORKTREE_CONFIG.maxConcurrency || 3,
  statusFile: path.resolve(SKILL_DIR, 'parallel-status.json')
});

// Recover scheduler state on startup (restore pending tasks from previous run)
if (WORKTREE_CONFIG.enabled) {
  scheduler.recover();
}

// Step order
const STEPS = ['clarifier', 'architect', 'planner', 'implementer', 'verifier'];

function loadWorkflow(flowId) {
  const workDir = path.join(OUTPUT_ROOT, flowId);
  const workflowPath = path.join(workDir, 'workflow.json');
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow not found: ${flowId}`);
  }
  return JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
}

function saveWorkflow(flowId, workflow) {
  const workDir = path.join(OUTPUT_ROOT, flowId);
  const workflowPath = path.join(workDir, 'workflow.json');
  fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2));
}

function formatTimestampYmdHis(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function sanitizeFlowSuffix(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function startWorkflow(jiraKey = '', customPrompt = '') {
  const timestamp = formatTimestampYmdHis();
  const suffix = sanitizeFlowSuffix(jiraKey);
  const flowId = suffix ? `flow_${timestamp}_${suffix}` : `flow_${timestamp}`;
  const workDir = path.join(OUTPUT_ROOT, flowId);

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'scripts'), { recursive: true });

  // Initialize memory tree for this flow
  try {
    initTree(flowId);
    console.log(`🧠 Memory tree initialized`);
  } catch (e) {
    console.error(`⚠️  Memory tree init failed: ${e.message}`);
  }

  const workflow = {
    flowId,
    jiraKey,
    customPrompt,
    status: 'running',
    currentStep: 'clarifier',
    startedAt: new Date().toISOString(),
    steps: {}
  };

  STEPS.forEach(step => {
    workflow.steps[step] = step === 'clarifier' ? 'pending' : 'waiting';
  });

  saveWorkflow(flowId, workflow);

  console.log(`✅ Workflow started: ${flowId}`);
  console.log(`📁 Work dir: ${workDir}`);

  // Auto-spawn clarifier via canonical path
  const spawnScript = path.join(__dirname, 'api/spawn.js');
  const child = spawn(process.execPath, [spawnScript, flowId, 'clarifier'], {
    stdio: 'inherit'
  });
  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`❌ Failed to spawn clarifier (exit code: ${code})`);
    }
  });

  workflow.steps.clarifier = 'running';
  saveWorkflow(flowId, workflow);

  return flowId;
}

function retryStep(flowId, step, clearOutput = false) {
  if (!STEPS.includes(step)) {
    throw new Error(`Invalid step: ${step}`);
  }

  console.log(`🔄 Retrying step: ${step}`);
  console.log(`   Flow: ${flowId}`);

  const { workDir } = prepareRetry(flowId, step, { clearOutput, source: 'manual' });

  if (clearOutput) {
    console.log(`   🗑️  Output cleared`);
  }

  // Spawn via canonical path — actually starts agent process
  const spawnScript = path.join(__dirname, 'api/spawn.js');
  const child = spawn(process.execPath, [spawnScript, flowId, step], {
    stdio: 'inherit'
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`❌ spawn-via-gateway exited with code ${code}`);
    }
  });

  console.log(`✅ Retry initiated`);
}

function resumeWorkflow(flowId, step) {
  const workflow = loadWorkflow(flowId);

  if (!STEPS.includes(step)) {
    throw new Error(`Invalid step: ${step}. Valid steps: ${STEPS.join(', ')}`);
  }

  // Guard: check if workflow was created with old step structure
  const workflowStepKeys = Object.keys(workflow.steps);
  const hasOldSteps = workflowStepKeys.some(s => !STEPS.includes(s));
  if (hasOldSteps) {
    throw new Error(`Flow ${flowId} uses old step structure (${workflowStepKeys.join(', ')}). Cannot resume — start a new flow instead.`);
  }

  console.log(`▶️  Resuming workflow: ${flowId}`);
  console.log(`📍 Step: ${step}`);

  // Spawn via canonical path
  const spawnScript = path.join(__dirname, 'api/spawn.js');
  const child = spawn(process.execPath, [spawnScript, flowId, step], {
    stdio: 'inherit'
  });
  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`❌ Failed to spawn ${step} (exit code: ${code})`);
    }
  });

  workflow.currentStep = step;
  workflow.steps[step] = 'running';
  saveWorkflow(flowId, workflow);
}

function stopWorkflow(flowId) {
  const workflow = loadWorkflow(flowId);
  const workDir = path.join(OUTPUT_ROOT, flowId);

  console.log(`🛑 Stopping workflow: ${flowId}`);

  let killedCount = 0;

  // 1. Kill all agent PIDs (.pid.<step> files)
  // Use negative PID to kill entire process group (wrapper + kiro-cli/codex children)
  STEPS.forEach(step => {
    const pidFile = path.join(workDir, `.pid.${step}`);
    if (fs.existsSync(pidFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
        if (data.pid) {
          // Try to kill entire process group first (negative PID)
          try {
            process.kill(-data.pid, 'SIGTERM');
            console.log(`   💀 Killed ${step} process group (PGID ${data.pid})`);
            killedCount++;
          } catch (e) {
            if (e.code === 'ESRCH') {
              // Process group doesn't exist, try single PID
              try {
                process.kill(data.pid, 'SIGTERM');
                console.log(`   💀 Killed ${step} (PID ${data.pid})`);
                killedCount++;
              } catch (e2) {
                if (e2.code !== 'ESRCH') {
                  console.error(`   ⚠️  Error killing ${step} PID ${data.pid}: ${e2.message}`);
                }
              }
            } else {
              console.error(`   ⚠️  Error killing ${step} PGID ${data.pid}: ${e.message}`);
              // Fallback: try single PID
              try {
                process.kill(data.pid, 'SIGTERM');
                killedCount++;
              } catch (_) {}
            }
          }
        }
        fs.unlinkSync(pidFile);
      } catch (e) {
        // corrupted or already gone
      }
    }
  });

  // 2. Kill any remaining kiro-cli/codex processes for this flow
  try {
    const { execSync } = require('child_process');
    // Kill any kiro-cli processes whose command line references this flow's work dir
    const flowWorkDir = path.join(OUTPUT_ROOT, flowId);
    const agents = ['kiro-cli', 'codex', 'claude'];
    agents.forEach(agent => {
      try {
        const pids = execSync(`pgrep -f "${agent}.*${flowId}" 2>/dev/null || true`, { encoding: 'utf8' }).trim().split('\n');
        pids.forEach(pid => {
          if (pid && pid !== String(process.pid)) {
            try {
              process.kill(parseInt(pid), 'SIGTERM');
              console.log(`   💀 Killed orphan ${agent} (PID ${pid})`);
              killedCount++;
            } catch (e) { /* already gone */ }
          }
        });
      } catch (e) { /* pgrep not found or no match */ }
    });
  } catch (e) { /* best effort */ }

  // 3. Kill watcher process
  try {
    const { execSync } = require('child_process');
    const pids = execSync(`pgrep -f "watcher.js ${flowId}"`, { encoding: 'utf8' }).trim().split('\n');
    pids.forEach(pid => {
      if (pid) {
        try {
          process.kill(parseInt(pid), 'SIGTERM');
          console.log(`   💀 Killed watcher (PID ${pid})`);
          killedCount++;
        } catch (e) { /* already gone */ }
      }
    });
  } catch (e) {
    // pgrep returns non-zero if no match
  }

  // 4. Kill dashboard process
  try {
    const { execSync } = require('child_process');
    const pids = execSync(`pgrep -f "dashboard.py ${flowId}"`, { encoding: 'utf8' }).trim().split('\n');
    pids.forEach(pid => {
      if (pid) {
        try {
          process.kill(parseInt(pid), 'SIGTERM');
          console.log(`   💀 Killed dashboard (PID ${pid})`);
          killedCount++;
        } catch (e) { /* already gone */ }
      }
    });
  } catch (e) {
    // pgrep returns non-zero if no match
  }

  // 5. Update workflow status
  workflow.status = 'stopped';
  workflow.stoppedAt = new Date().toISOString();
  STEPS.forEach(step => {
    if (workflow.steps[step] === 'running' || workflow.steps[step] === 'pending') {
      workflow.steps[step] = 'cancelled';
    }
  });
  saveWorkflow(flowId, workflow);

  console.log(`\n✅ Workflow stopped. Killed ${killedCount} process(es).`);
  return { killedCount };
}

function statusWorkflow(flowId) {
  const workflow = loadWorkflow(flowId);
  const workDir = path.join(OUTPUT_ROOT, flowId);

  console.log(`📊 Workflow Status: ${flowId}\n`);
  console.log(`Jira: ${workflow.jiraKey}`);
  console.log(`Status: ${workflow.status}`);
  console.log(`Current: ${workflow.currentStep}`);
  console.log(`Started: ${workflow.startedAt}\n`);
  console.log(`Steps:`);

  Object.entries(workflow.steps).forEach(([step, status]) => {
    console.log(`  ${step}: ${status}`);
  });

  console.log(`\n📁 Outputs:`);
  const outputDir = path.join(workDir, 'output');
  if (fs.existsSync(outputDir)) {
    const outputs = fs.readdirSync(outputDir).filter(f => f.endsWith('.md'));
    if (outputs.length > 0) {
      outputs.forEach(f => console.log(`  ${f}`));
    } else {
      console.log(`  (none yet)`);
    }
  } else {
    console.log(`  (none yet)`);
  }
}

/**
 * Schedule an implementer task via ParallelScheduler.
 * Uses the scheduler's concurrency management when worktree mode is enabled.
 * Falls back to direct spawn when worktree mode is disabled.
 *
 * @param {string} flowId - The flow identifier
 * @param {string} repo - Repository name (key in worktree.repos config)
 */
function scheduleImplementer(flowId, repo) {
  if (!WORKTREE_CONFIG.enabled) {
    console.log(`⚠️  Worktree mode disabled, falling back to direct spawn`);
    const spawnScript = path.join(__dirname, 'api/spawn.js');
    const child = spawn(process.execPath, [spawnScript, flowId, 'implementer'], {
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        console.error(`❌ Failed to spawn implementer (exit code: ${code})`);
      }
    });
    return;
  }

  if (!repo) {
    console.error(`❌ Repository name required for parallel scheduling`);
    process.exit(1);
  }

  const task = scheduler.schedule(flowId, 'implementer', repo);

  if (task.status === 'running') {
    console.log(`🚀 Scheduled implementer for ${flowId} (running immediately)`);
    console.log(`   Repo: ${repo}`);

    // Spawn the agent process
    const spawnScript = path.join(__dirname, 'api/spawn.js');
    const child = spawn(process.execPath, [spawnScript, flowId, 'implementer'], {
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) {
        scheduler.onTaskComplete(flowId);
        console.log(`✅ Implementer completed for ${flowId}`);
      } else {
        scheduler.onTaskFailed(flowId);
        console.error(`❌ Implementer failed for ${flowId} (exit code: ${code})`);
      }
    });
  } else {
    console.log(`📋 Queued implementer for ${flowId} (concurrency limit reached)`);
    console.log(`   Repo: ${repo}`);
    console.log(`   Position in queue: ${scheduler.getQueue().length}`);
  }
}

/**
 * Auto-detect repos from architecture.md and schedule implementer for each.
 * Uses detectRepos to parse architecture.md; falls back to defaultRepos config.
 *
 * @param {string} flowId - The flow identifier
 */
function scheduleParallelAuto(flowId) {
  const workDir = path.join(OUTPUT_ROOT, flowId);

  if (!fs.existsSync(workDir)) {
    console.error(`❌ Flow not found: ${flowId}`);
    process.exit(1);
  }

  const defaultRepos = WORKTREE_CONFIG.defaultRepos || [];
  const repos = detectRepos(workDir, { defaultRepos });

  if (repos.length === 0) {
    console.error(`❌ No repos detected and no defaultRepos configured`);
    process.exit(1);
  }

  console.log(`🔍 Detected ${repos.length} repo(s) for flow ${flowId}:`);
  repos.forEach(r => console.log(`   - ${r}`));
  console.log('');

  for (const repo of repos) {
    // Check repo exists in worktree.repos config
    if (!WORKTREE_CONFIG.repos || !WORKTREE_CONFIG.repos[repo]) {
      console.log(`⚠️  Repo "${repo}" not in worktree.repos config, skipping`);
      continue;
    }
    scheduleImplementer(flowId, repo);
  }
}

/**
 * Show parallel scheduler status.
 */
function parallelStatus() {
  const status = scheduler.getStatus();
  console.log(`📊 Parallel Scheduler Status\n`);
  console.log(`Max Concurrency: ${status.maxConcurrency}`);
  console.log(`Running: ${status.running.length}`);
  console.log(`Queued: ${status.queue.length}`);
  console.log(`Completed: ${status.completed.length}`);
  console.log(`Last Updated: ${status.lastUpdated}\n`);

  if (status.running.length > 0) {
    console.log(`🏃 Running:`);
    status.running.forEach(t => {
      console.log(`  ${t.flowId} [${t.repo}] started: ${t.startedAt}`);
    });
  }

  if (status.queue.length > 0) {
    console.log(`\n📋 Queue:`);
    status.queue.forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.flowId} [${t.repo}] queued: ${t.queuedAt}`);
    });
  }
}

// CLI
const [,, command, ...args] = process.argv;

try {
  switch (command) {
    case 'start': {
      // Supports:
      //   orchestrator.js start <jira-key> [custom-prompt]
      //   orchestrator.js start "" <custom-prompt>
      //   orchestrator.js start --prompt <custom-prompt>
      let jiraKey = args[0] || '';
      let customPrompt = args[1] || '';
      if (args[0] === '--prompt') {
        jiraKey = '';
        customPrompt = args[1] || '';
      }
      if (!jiraKey && !customPrompt) {
        console.error('Usage: orchestrator.js start [jira-key] [custom-prompt]');
        console.error('   or: orchestrator.js start --prompt <custom-prompt>');
        process.exit(1);
      }
      startWorkflow(jiraKey, customPrompt);
      break;
    }

    case 'resume':
      if (args.length < 2) {
        console.error('Usage: orchestrator.js resume <flow-id> <step>');
        process.exit(1);
      }
      resumeWorkflow(args[0], args[1]);
      break;

    case 'retry':
      if (args.length < 2) {
        console.error('Usage: orchestrator.js retry <flow-id> <step> [--clear-output]');
        process.exit(1);
      }
      retryStep(args[0], args[1], args.includes('--clear-output'));
      break;

    case 'stop':
      if (args.length < 1) {
        console.error('Usage: orchestrator.js stop <flow-id>');
        process.exit(1);
      }
      stopWorkflow(args[0]);
      break;

    case 'status':
      if (args.length < 1) {
        console.error('Usage: orchestrator.js status <flow-id>');
        process.exit(1);
      }
      statusWorkflow(args[0]);
      break;

    case 'parallel': {
      // Subcommands: schedule, auto, status
      const subCmd = args[0];
      if (subCmd === 'schedule') {
        if (args.length < 3) {
          console.error('Usage: orchestrator.js parallel schedule <flow-id> <repo>');
          process.exit(1);
        }
        scheduleImplementer(args[1], args[2]);
      } else if (subCmd === 'auto') {
        if (args.length < 2) {
          console.error('Usage: orchestrator.js parallel auto <flow-id>');
          console.error('  Auto-detects repos from architecture.md and schedules implementer for each.');
          process.exit(1);
        }
        scheduleParallelAuto(args[1]);
      } else if (subCmd === 'status') {
        parallelStatus();
      } else {
        console.error('Usage: orchestrator.js parallel <schedule|auto|status> [args]');
        process.exit(1);
      }
      break;
    }

    default:
      console.error('Usage: orchestrator.js <start|resume|retry|status|stop|parallel> [args]');
      process.exit(1);
  }
} catch (err) {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
// orchestrator.js - Auto-spawn dev team agents with sessions_spawn

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepareRetry } = require('../orchestrator/retry-flow');
const { ParallelScheduler } = require('../worktree/parallel-scheduler');
const { detectRepos } = require('../worktree/repo-detector');
const { initTree } = require('../utils/memory-tree');

const SKILL_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SKILL_DIR, '..');
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'team.json'), 'utf8'));
const OUTPUT_ROOT = path.resolve(REPO_ROOT, TEAM_CONFIG.outputRoot || 'task-flows');

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
const { STEPS: DEFAULT_STEPS, getSteps } = require('./workflow-manager');

function loadWorkflow(flowId) {
  const workDir = workspaceName ? path.join(OUTPUT_ROOT, workspaceName, flowId) : path.join(OUTPUT_ROOT, flowId);
  const workflowPath = path.join(workDir, 'workflow.json');
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow not found: ${flowId}`);
  }
  return JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
}

function saveWorkflow(flowId, workflow) {
  const workDir = resolveWorkDir(flowId);
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

function startWorkflow(jiraKey = '', customPrompt = '', workflowId = '', workspaceName = '', workspaceDir = '') {
  const timestamp = formatTimestampYmdHis();
  const suffix = sanitizeFlowSuffix(jiraKey);
  const flowId = suffix ? `flow_${timestamp}_${suffix}` : `flow_${timestamp}`;
  const workDir = resolveWorkDir(flowId);

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'scripts'), { recursive: true });

  const workflow = {
    flowId,
    jiraKey,
    customPrompt,
    workflowId,
    workspaceName,
    workspaceDir,
    status: 'running',
    currentStep: 'clarifier',
    startedAt: new Date().toISOString(),
    steps: {}
  };

  // If workflowId is provided, fetch steps from sqlite
  let customSteps = null;
  if (workflowId) {
    try {
      const dbPath = path.resolve(REPO_ROOT, 'workflows.db');
      if (fs.existsSync(dbPath)) {
        const { execSync } = require('child_process');
        const dashboardPath = path.resolve(REPO_ROOT, 'dashboard/node_modules');
        const script = `
          const sqlite3 = require('${path.join(dashboardPath, 'sqlite3')}');
          const db = new sqlite3.Database('${dbPath.replace(/\\/g, '\\\\')}');
          db.get('SELECT steps FROM workflows WHERE id = ?', ['${workflowId}'], (err, row) => {
            if (row) console.log(row.steps);
            db.close();
          });
        `;
        const res = execSync(`node -e "${script.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
        if (res) {
          customSteps = JSON.parse(res);
        }
      }
    } catch (e) {
      console.error(`⚠️ Failed to load custom workflow steps for ${workflowId}:`, e.message);
    }
  }

  if (customSteps) {
    workflow.stepOrder = customSteps;
  }

  const stepsToUse = workflow.stepOrder || DEFAULT_STEPS;
  workflow.currentStep = stepsToUse[0];

  stepsToUse.forEach((step, idx) => {
    workflow.steps[step] = idx === 0 ? 'pending' : 'waiting';
  });

  saveWorkflow(flowId, workflow);

  // Initialize memory tree for this flow
  try {
    initTree(flowId);
    console.log(`🧠 Memory tree initialized`);
  } catch (e) {
    console.error(`⚠️  Memory tree init failed: ${e.message}`);
  }

  console.log(`✅ Workflow started: ${flowId}`);
  console.log(`📁 Work dir: ${workDir}`);

  // Auto-spawn first step via canonical path
  const spawnScript = path.join(__dirname, '../api/spawn.js');
  const firstStep = workflow.currentStep;
  const child = spawn(process.execPath, [spawnScript, flowId, firstStep], {
    stdio: 'inherit'
  });
  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`❌ Failed to spawn ${firstStep} (exit code: ${code})`);
    }
  });

  workflow.steps[firstStep] = 'running';
  saveWorkflow(flowId, workflow);

  return flowId;
}

function retryStep(flowId, step, clearOutput = false) {
  const workflow = loadWorkflow(flowId);
  const stepsToUse = getSteps(workflow);
  if (!stepsToUse.includes(step)) {
    throw new Error(`Invalid step: ${step}`);
  }

  console.log(`🔄 Retrying step: ${step}`);
  console.log(`   Flow: ${flowId}`);

  const { workDir } = prepareRetry(flowId, step, { clearOutput, source: 'manual' });

  if (clearOutput) {
    console.log(`   🗑️  Output cleared`);
  }

  // Spawn via canonical path — actually starts agent process
  const spawnScript = path.join(__dirname, '../api/spawn.js');
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
  const stepsToUse = getSteps(workflow);

  if (!stepsToUse.includes(step)) {
    throw new Error(`Invalid step: ${step}. Valid steps: ${stepsToUse.join(', ')}`);
  }

  // Guard: check if workflow was created with old step structure
  const workflowStepKeys = Object.keys(workflow.steps);
  const hasOldSteps = workflowStepKeys.some(s => !stepsToUse.includes(s));
  if (hasOldSteps) {
    throw new Error(`Flow ${flowId} uses old step structure (${workflowStepKeys.join(', ')}). Cannot resume — start a new flow instead.`);
  }

  console.log(`▶️  Resuming workflow: ${flowId}`);
  console.log(`📍 Step: ${step}`);

  // Spawn via canonical path
  const spawnScript = path.join(__dirname, '../api/spawn.js');
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
  const workDir = resolveWorkDir(flowId);

  console.log(`🛑 Stopping workflow: ${flowId}`);

  let killedCount = 0;
  const stepsToUse = getSteps(workflow);

  // 1. Kill all agent PIDs (.pid.<step> files)
  // Use negative PID to kill entire process group (wrapper + kiro-cli/codex children)
  stepsToUse.forEach(step => {
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
  stepsToUse.forEach(step => {
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
  const workDir = resolveWorkDir(flowId);

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
    const spawnScript = path.join(__dirname, '../api/spawn.js');
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
    const spawnScript = path.join(__dirname, '../api/spawn.js');
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
  const workDir = resolveWorkDir(flowId);

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
      //   orchestrator.js start [--workflow <id>] <jira-key> [custom-prompt]
      //   orchestrator.js start [--workflow <id>] "" <custom-prompt>
      //   orchestrator.js start [--workflow <id>] --prompt <custom-prompt>
      let workflowId = '';
      let i = 0;
      let workspaceName = '';
      let workspaceDir = '';
      while (i < args.length && args[i].startsWith('--')) {
        if (args[i] === '--workflow') {
          workflowId = args[i+1];
          i += 2;
        } else if (args[i] === '--workspace-name') {
          workspaceName = args[i+1];
          i += 2;
        } else if (args[i] === '--workspace-dir') {
          workspaceDir = args[i+1];
          i += 2;
        } else if (args[i] === '--prompt') {
          break; // Handled below
        } else {
          i++;
        }
      }

      let jiraKey = args[i] || '';
      let customPrompt = args[i+1] || '';
      if (args[i] === '--prompt') {
        jiraKey = '';
        customPrompt = args[i+1] || '';
      }
      if (!jiraKey && !customPrompt) {
        console.error('Usage: orchestrator.js start [--workflow <id>] [jira-key] [custom-prompt]');
        console.error('   or: orchestrator.js start [--workflow <id>] --prompt <custom-prompt>');
        process.exit(1);
      }
      startWorkflow(jiraKey, customPrompt, workflowId, workspaceName, workspaceDir);
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

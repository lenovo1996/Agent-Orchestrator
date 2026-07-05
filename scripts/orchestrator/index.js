#!/usr/bin/env node
// orchestrator.js - Auto-spawn dev team agents with sessions_spawn

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepareRetry } = require('../orchestrator/retry-flow');
const { ParallelScheduler } = require('../worktree/parallel-scheduler');
const { detectRepos } = require('../worktree/repo-detector');
const { createWorktree, finalizeWorktree, mergeDependencyBranches } = require('../worktree/worktree-lifecycle');
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
const { STEPS: DEFAULT_STEPS, getSteps, resolveWorkDir } = require('./workflow-manager');

function loadWorkflow(flowId) {
  const workDir = resolveWorkDir(flowId);
  const workflowPath = path.join(workDir, 'workflow.json');
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow not found: ${flowId}`);
  }
  return JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
}

function saveWorkflow(flowId, workflow) {
  const workDir = resolveWorkDir(flowId);
  saveWorkflowAt(workDir, workflow);
}

function saveWorkflowAt(workDir, workflow) {
  const workflowPath = path.join(workDir, 'workflow.json');
  fs.mkdirSync(workDir, { recursive: true });
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

function startWorkflow(jiraKey = '', customPrompt = '', workflowId = '', workspaceName = '', workspaceDir = '', dependsOn = [], worktreePath = '') {
  const timestamp = formatTimestampYmdHis();
  const suffix = sanitizeFlowSuffix(jiraKey);
  const flowId = suffix ? `flow_${timestamp}_${suffix}` : `flow_${timestamp}`;
  const workDir = workspaceName ? path.join(OUTPUT_ROOT, workspaceName, flowId) : resolveWorkDir(flowId);

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'scripts'), { recursive: true });

  const isPendingDeps = dependsOn && dependsOn.length > 0;

  const workflow = {
    flowId,
    jiraKey,
    customPrompt,
    workflowId,
    workspaceName,
    workspaceDir,
    worktreePath,
    dependsOn,
    status: isPendingDeps ? 'pending_dependencies' : 'running',
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

  saveWorkflowAt(workDir, workflow);

  // Initialize memory tree for this flow
  try {
    initTree(flowId);
    console.log(`🧠 Memory tree initialized`);
  } catch (e) {
    console.error(`⚠️  Memory tree init failed: ${e.message}`);
  }

  console.log(`✅ Workflow started: ${flowId}`);
  console.log(`📁 Work dir: ${workDir}`);

  if (isPendingDeps) {
    console.log(`⏳ Workflow pending dependencies: ${dependsOn.join(', ')}`);
    return flowId;
  }

  // Create git worktree if worktreePath is specified
  // DEFERRED: If workflow has dependencies, worktree creation is deferred until
  // all dependencies complete (handled in tryResumeWorkflowIfDependenciesMet).
  // This ensures dependent tasks branch from merged dependency branches, not master.
  if (worktreePath && !isPendingDeps) {
    // Extract task key from customPrompt (e.g. "TASK-001" from "Task: TASK-001 - ...")
    const taskKeyMatch = (customPrompt || '').match(/TASK-\d+/i);
    const taskKey = taskKeyMatch ? taskKeyMatch[0] : null;
    // repoPath must be the actual project repo (where .git lives)
    const repoPath = workspaceDir || workflow.workspacePath;
    if (!repoPath) {
      console.error('❌ Cannot create worktree: no repoPath (workspaceDir/workspacePath empty)');
      workflow.status = 'failed';
      workflow.error = 'Missing workspaceDir/workspacePath for worktree creation';
      saveWorkflowAt(workDir, workflow);
      return;
    }
    const wtResult = createWorktree({
      repoPath,
      worktreePath,
      flowId,
      step: workflow.currentStep,
      taskKey
    });
    if (!wtResult.success) {
      console.error(`❌ Failed to create worktree: ${wtResult.error}`);
      workflow.status = 'failed';
      workflow.error = wtResult.error;
      saveWorkflowAt(workDir, workflow);
      return;
    }
    workflow.worktreeBranch = wtResult.branch;
    saveWorkflowAt(workDir, workflow);
  } else if (worktreePath && isPendingDeps) {
    console.log(`⏳ Worktree creation DEFERRED for ${flowId} — waiting for dependencies: ${dependsOn.join(', ')}`);
    console.log(`   Worktree will be created from merged dependency branches when deps complete.`);
  }

  // Auto-spawn first step via canonical path
  const spawnScript = path.join(__dirname, '../api/spawn.js');
  const firstStep = workflow.currentStep;
  const spawnArgs = [spawnScript, flowId, firstStep];
  if (worktreePath) spawnArgs.push('--worktree-path', worktreePath);
  const child = spawn(process.execPath, spawnArgs, {
    stdio: 'inherit'
  });
  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`❌ Failed to spawn ${firstStep} (exit code: ${code})`);
    }
  });

  workflow.steps[firstStep] = 'running';
  saveWorkflowAt(workDir, workflow);

  return flowId;
}

/**
 * Check all pending workflows and resume those whose dependencies are completed.
 */
function checkAndResumeDependentWorkflows() {
  const { getWorkflowState, OUTPUT_ROOT } = require('./workflow-manager');
  if (!fs.existsSync(OUTPUT_ROOT)) return;

  const entries = fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    let flowDir;
    if (entry.isDirectory()) {
      const maybeWorkflowJson = path.join(OUTPUT_ROOT, entry.name, 'workflow.json');
      if (fs.existsSync(maybeWorkflowJson)) {
        flowDir = path.join(OUTPUT_ROOT, entry.name);
      } else {
        // Search one level deep (workspaces)
        const subEntries = fs.readdirSync(path.join(OUTPUT_ROOT, entry.name), { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isDirectory() && fs.existsSync(path.join(OUTPUT_ROOT, entry.name, sub.name, 'workflow.json'))) {
             flowDir = path.join(OUTPUT_ROOT, entry.name, sub.name);
             const flowId = sub.name;
             tryResumeWorkflowIfDependenciesMet(flowId, getWorkflowState);
          }
        }
        continue;
      }
    }

    if (flowDir) {
      const flowId = entry.name;
      tryResumeWorkflowIfDependenciesMet(flowId, getWorkflowState);
    }
  }
}

function tryResumeWorkflowIfDependenciesMet(flowId, getWorkflowState) {
  try {
    const workflow = loadWorkflow(flowId);
    if (workflow.status !== 'pending_dependencies' || !workflow.dependsOn || workflow.dependsOn.length === 0) {
      return;
    }

    const allCompleted = workflow.dependsOn.every(depFlowId => {
      try {
        const depState = getWorkflowState(depFlowId);
        if (!(depState && depState.workflow && depState.workflow.status === 'completed')) {
          return false;
        }

        const { isWorkflowCompletionValid } = require('./workflow-manager');
        return isWorkflowCompletionValid(depState.workflow, depState.statuses, depState.outputs).valid;
      } catch (e) {
        return false;
      }
    });

    if (allCompleted) {
      console.log(`\n🎉 Dependencies met for ${flowId}, resuming...`);

      // OPTION B: Merge dependency branches before creating worktree
      // This ensures the dependent task sees all dependency code
      if (workflow.worktreePath && workflow.dependsOn.length > 0) {
        const repoPath = workflow.workspaceDir || workflow.workspacePath;
        if (repoPath) {
          const taskKeyMatch = (workflow.customPrompt || '').match(/TASK-\d+/i);
          const taskKey = taskKeyMatch ? taskKeyMatch[0] : flowId.replace(/^flow_\d+_/, '');

          // Collect dependency branches from parent workflows
          const depBranches = [];
          let depError = null;

          for (const depFlowId of workflow.dependsOn) {
            try {
              const depWorkflow = loadWorkflow(depFlowId);
              if (depWorkflow.worktreeBranch) {
                depBranches.push(depWorkflow.worktreeBranch);
                console.log(`   📌 Dependency ${depFlowId} → branch: ${depWorkflow.worktreeBranch}`);
              } else {
                // Dependency has no worktree branch (e.g. ran without worktree)
                // This means its changes are on the main branch
                console.log(`   ⚠️  Dependency ${depFlowId} has no worktree branch, skipping (changes should be on main)`);
              }
            } catch (e) {
              depError = `Cannot load dependency workflow ${depFlowId}: ${e.message}`;
              break;
            }
          }

          if (depError) {
            console.error(`❌ ${depError}`);
            workflow.status = 'failed';
            workflow.error = depError;
            saveWorkflow(flowId, workflow);
            return;
          }

          // Merge dependency branches into a combined branch
          const mergedBranchName = `merged-deps-for-${taskKey}`;
          let baseBranch = null;

          if (depBranches.length > 0) {
            console.log(`\n🔀 Merging ${depBranches.length} dependency branch(es) for ${flowId}...`);

            const mergeResult = mergeDependencyBranches({
              repoPath,
              dependencyBranches: depBranches,
              mergedBranchName
            });

            if (!mergeResult.success) {
              console.error(`❌ Failed to merge dependency branches: ${mergeResult.error}`);
              workflow.status = 'blocked';
              workflow.error = `Dependency merge conflict: ${mergeResult.error}`;
              if (mergeResult.conflicts) {
                workflow.conflictFiles = mergeResult.conflicts;
              }
              saveWorkflow(flowId, workflow);
              console.error(`\n⚠️  ${flowId} is BLOCKED due to merge conflict.`);
              console.error(`   Resolve conflicts manually, then run: orchestrator.js resume ${flowId} ${workflow.currentStep || getSteps(workflow)[0]}`);
              return;
            }

            // Use the merged branch as base for the new worktree
            baseBranch = mergeResult.mergedBranch;
            console.log(`   ✅ Using merged branch as base: ${baseBranch}`);
          } else {
            // No dependency branches to merge (all deps ran without worktrees)
            // Fall back to auto-detect (main branch)
            console.log(`   ℹ️  No dependency branches to merge, using default base branch`);
          }

          // Now create the worktree with the resolved base branch
          const wtResult = createWorktree({
            repoPath,
            worktreePath: workflow.worktreePath,
            flowId,
            step: workflow.currentStep || getSteps(workflow)[0],
            taskKey,
            baseBranch  // null = auto-detect (main branch)
          });

          if (!wtResult.success) {
            console.error(`❌ Failed to create worktree: ${wtResult.error}`);
            workflow.status = 'failed';
            workflow.error = wtResult.error;
            saveWorkflow(flowId, workflow);
            return;
          }

          workflow.worktreeBranch = wtResult.branch;
          workflow.mergedDepsBranch = baseBranch || null;  // Track for debugging
          console.log(`   🌲 Worktree created: ${workflow.worktreePath} (branch: ${wtResult.branch})`);
        } else {
          console.error(`❌ Cannot create worktree: no repoPath`);
          workflow.status = 'failed';
          workflow.error = 'Missing workspaceDir/workspacePath for worktree creation';
          saveWorkflow(flowId, workflow);
          return;
        }
      }

      workflow.status = 'running';
      saveWorkflow(flowId, workflow);
      resumeWorkflow(flowId, workflow.currentStep || getSteps(workflow)[0]);
    }
  } catch (e) {
    console.error(`❌ Error in tryResumeWorkflowIfDependenciesMet for ${flowId}: ${e.message}`);
  }
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
  const spawnArgs = [spawnScript, flowId, step];
  if (workflow.worktreePath) spawnArgs.push('--worktree-path', workflow.worktreePath);
  const child = spawn(process.execPath, spawnArgs, {
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

  // Allow resuming blocked workflows (after manual conflict resolution)
  if (workflow.status === 'blocked') {
    console.log(`🔓 Unblocking workflow ${flowId} (was blocked by merge conflict)`);
    // If worktree wasn't created yet (blocked during dep merge), try creating it now
    if (workflow.worktreePath && !workflow.worktreeBranch) {
      const repoPath = workflow.workspaceDir || workflow.workspacePath;
      if (repoPath) {
        const taskKeyMatch = (workflow.customPrompt || '').match(/TASK-\d+/i);
        const taskKey = taskKeyMatch ? taskKeyMatch[0] : flowId.replace(/^flow_\d+_/, '');
        const wtResult = createWorktree({
          repoPath,
          worktreePath: workflow.worktreePath,
          flowId,
          step,
          taskKey
        });
        if (wtResult.success) {
          workflow.worktreeBranch = wtResult.branch;
          console.log(`   🌲 Worktree created: ${workflow.worktreePath} (branch: ${wtResult.branch})`);
        } else {
          console.error(`   ⚠️  Could not create worktree: ${wtResult.error}. Continuing without worktree.`);
        }
      }
    }
    workflow.status = 'running';
    delete workflow.error;
    delete workflow.conflictFiles;
    saveWorkflow(flowId, workflow);
  }

  console.log(`▶️  Resuming workflow: ${flowId}`);
  console.log(`📍 Step: ${step}`);

  // Spawn via canonical path
  const spawnScript = path.join(__dirname, '../api/spawn.js');
  const spawnArgs = [spawnScript, flowId, step];
  if (workflow.worktreePath) spawnArgs.push('--worktree-path', workflow.worktreePath);
  const child = spawn(process.execPath, spawnArgs, {
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

  // 6. Finalize worktree (commit + merge + preserve) if present
  if (workflow.worktreePath && workflow.worktreeBranch) {
    const mergeResult = finalizeWorktree({
      repoPath: workflow.workspacePath,
      worktreePath: workflow.worktreePath,
      branch: workflow.worktreeBranch,
      commitMsg: `feat: ${flowId} — stopped`
    });
    if (mergeResult.success) {
      console.log(`✅ Worktree finalized (merged, preserved)`);
    } else {
      console.error(`⚠️ Worktree finalize failed: ${mergeResult.error}`);
      if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
        console.error(`   Conflicts: ${mergeResult.conflicts.join(', ')}`);
      }
    }
  }

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
if (require.main === module) {
  const [,, command, ...args] = process.argv;

  try {
    switch (command) {
      case 'start': {
      // Supports:
      //   orchestrator.js start [--workflow <id>] [--depends-on <id1,id2>] <jira-key> [custom-prompt]
      //   orchestrator.js start [--workflow <id>] [--depends-on <id1,id2>] "" <custom-prompt>
      //   orchestrator.js start [--workflow <id>] [--depends-on <id1,id2>] --prompt <custom-prompt>
      let workflowId = '';
      let i = 0;
      let workspaceName = '';
      let workspaceDir = '';
      let worktreePath = '';
      let dependsOn = [];
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
        } else if (args[i] === '--worktree-path') {
          worktreePath = args[i+1];
          i += 2;
        } else if (args[i] === '--depends-on') {
          dependsOn = args[i+1].split(',').map(s => s.trim()).filter(Boolean);
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
        console.error('Usage: orchestrator.js start [--workflow <id>] [--depends-on <id1,id2>] [jira-key] [custom-prompt]');
        console.error('   or: orchestrator.js start [--workflow <id>] [--depends-on <id1,id2>] --prompt <custom-prompt>');
        process.exit(1);
      }
      startWorkflow(jiraKey, customPrompt, workflowId, workspaceName, workspaceDir, dependsOn, worktreePath);
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
}

module.exports = {
  checkAndResumeDependentWorkflows
};

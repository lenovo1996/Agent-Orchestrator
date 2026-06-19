#!/usr/bin/env node
// watcher.js - Watch workflow and auto-spawn next step with smart status checking and retry

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { updateTree } = require('../utils/memory-tree');
const { parseStepTokens, formatTokens } = require('../utils/token-tracker');

const SCRIPT_DIR = path.resolve(__dirname);
const SKILL_DIR = path.dirname(SCRIPT_DIR);
const REPO_ROOT = path.resolve(SKILL_DIR, '..');
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'team.json'), 'utf8'));
const OUTPUT_ROOT = path.resolve(REPO_ROOT, TEAM_CONFIG.outputRoot || 'task-flows');

const { loadWorkflow, getSteps, resolveWorkDir } = require('../orchestrator/workflow-manager');

function _getSteps(flowId) {
  let stepsToUse = ['clarifier', 'architect', 'planner', 'implementer', 'verifier'];
  try {
    const workflow = loadWorkflow(flowId);
    stepsToUse = getSteps(workflow);
  } catch (e) {}
  return stepsToUse;
}

const MAX_RETRIES = 1; // Auto-retry once on failure
const MAX_NEEDS_FIX = 5; // Max NEEDS_FIX iterations before blocking workflow

// --- PID file-based spawn guard ---
// Each running step writes a .pid.<step> file in the flow directory.
// Survives watcher restarts — on next launch we can detect leftover processes.

function pidFilePath(flowId, step) {
  const workDir = resolveWorkDir(flowId);
  return path.join(workDir, `.pid.${step}`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, does not kill
    return true;
  } catch (e) {
    return false; // ESRCH = no such process
  }
}

function registerSpawn(flowId, step, pid) {
  // PID file is now written by spawn-via-gateway.js directly
  // This function is kept for module export compatibility but is a no-op in watcher
  const filePath = pidFilePath(flowId, step);
  const payload = JSON.stringify({ pid, startedAt: new Date().toISOString() });
  fs.writeFileSync(filePath, payload);
  console.log(`🔒 PID ${pid} written to ${path.basename(filePath)}`);
}

function unregisterSpawn(flowId, step) {
  const filePath = pidFilePath(flowId, step);
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    // file may already be gone
  }
}

function isStepAlreadyRunning(flowId, step) {
  const filePath = pidFilePath(flowId, step);

  if (!fs.existsSync(filePath)) return false;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const { pid, startedAt } = data;

    if (isProcessAlive(pid)) {
      const elapsed = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
      console.log(`⚠️  ${step} already running (PID ${pid}, started ${elapsed}s ago), skipping duplicate spawn`);
      return true;
    }

    // PID no longer alive — stale file, clean up
    console.log(`🧹 Stale PID file for ${step} (PID ${pid} dead), removing`);
    fs.unlinkSync(filePath);
    return false;
  } catch (e) {
    // Corrupted pid file — remove and allow spawn
    console.log(`🧹 Corrupted PID file for ${step}, removing`);
    try { fs.unlinkSync(filePath); } catch (_) {}
    return false;
  }
}

/**
 * Silent version — checks if a step has a live PID without logging warnings.
 * Used by sequential guard to avoid noisy output on every watcher tick.
 */
function isStepStillRunning(flowId, step) {
  const filePath = pidFilePath(flowId, step);

  if (!fs.existsSync(filePath)) return false;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (isProcessAlive(data.pid)) {
      return true;
    }
    // Stale — clean up silently
    fs.unlinkSync(filePath);
    return false;
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    return false;
  }
}

function getWorkflowState(flowId) {
  const workDir = resolveWorkDir(flowId);
  const workflowPath = path.join(workDir, 'workflow.json');

  if (!fs.existsSync(workflowPath)) {
    return null;
  }

  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

  // Check which outputs exist and parse their status
  const outputs = {};
  const statuses = {};
  const stepsToUse = _getSteps(flowId);

  stepsToUse.forEach(step => {
    const member = TEAM_CONFIG.members[step];
    const outputFile = path.join(workDir, member.outputs[0]);
    outputs[step] = fs.existsSync(outputFile);

    if (outputs[step]) {
      statuses[step] = parseOutputStatus(outputFile);
    } else {
      statuses[step] = null;
    }
  });

  return { workflow, outputs, statuses, workDir, lastRetryAt: workflow.lastRetryAt };
}

function parseOutputStatus(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    // Look for status markers in output
    const statusMatch = content.match(/##\s*Status\s*[:\n]\s*(DONE|NEEDS_FIX|FAILED|BLOCKED|IN[ _]PROGRESS|NOT[ _]STARTED)/i);
    if (statusMatch) {
      return statusMatch[1].toUpperCase().replace(/ /g, '_');
    }

    // Check for common failure indicators
    if (content.includes('NOT STARTED') || content.includes('failed due to')) {
      return 'FAILED';
    }

    // If file has substantial content (>500 chars) and no explicit status, warn
    if (content.length > 500) {
      return 'UNKNOWN';
    }

    return 'UNKNOWN';
  } catch (err) {
    console.error(`⚠️  Error parsing ${filePath}:`, err.message);
    return 'UNKNOWN';
  }
}

function updateWorkflowState(flowId, updates) {
  const workDir = resolveWorkDir(flowId);
  const workflowPath = path.join(workDir, 'workflow.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

  Object.entries(updates).forEach(([key, value]) => {
    if (key.startsWith('steps.')) {
      const step = key.slice('steps.'.length);
      workflow.steps[step] = value;
    } else if (key.startsWith('retries.')) {
      const step = key.slice('retries.'.length);
      if (!workflow.retries) workflow.retries = {};
      workflow.retries[step] = value;
    } else if (key.startsWith('needsFixCount.')) {
      const step = key.slice('needsFixCount.'.length);
      if (!workflow.needsFixCount) workflow.needsFixCount = {};
      workflow.needsFixCount[step] = value;
    } else {
      workflow[key] = value;
    }
  });

  fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2));
}

function getRetryCount(workflow, step) {
  return (workflow.retries && workflow.retries[step]) || 0;
}

function spawnStep(flowId, step, isRetry = false) {
  console.log(`[spawnStep] called: ${step} (retry=${isRetry})`);

  // --- PID guard: prevent duplicate spawn ---
  if (isStepAlreadyRunning(flowId, step)) {
    console.log(`[spawnStep] BLOCKED: ${step} PID still alive`);
    return;
  }

  // --- Sequential guard: ensure no previous step is still running ---
  // Only block if a previous step has a live PID AND its status is not yet 'done'
  // (output file may be written before wrapper fully exits)
  const stepsToUse = _getSteps(flowId);
  const stepIdx = stepsToUse.indexOf(step);
  const state2 = getWorkflowState(flowId);
  if (state2) {
    for (let i = 0; i < stepIdx; i++) {
      const prevStep = stepsToUse[i];
      // If the step is already marked done (output confirmed), allow spawn even if PID lingers
      if (state2.statuses[prevStep] === 'DONE' || state2.workflow.steps[prevStep] === 'done') {
        continue;
      }
      if (isStepStillRunning(flowId, prevStep)) {
        console.log(`⏳ Waiting for ${prevStep} to finish before spawning ${step}`);
        return;
      }
    }
  }

  const state = getWorkflowState(flowId);
  if (state && state.outputs[step] && !isRetry) {
    const status = state.statuses[step];
    console.log(`⏭️  ${step} output already exists (${status || 'UNKNOWN'}), not spawning again`);
    if (status === 'DONE') {
      updateWorkflowState(flowId, { [`steps.${step}`]: 'done' });
    }
    return;
  }

  const retryLabel = isRetry ? ' (retry)' : '';
  console.log(`\n🚀 ${isRetry ? 'Retrying' : 'Spawning'}: ${step}${retryLabel}`);

  const spawnScript = path.join(SKILL_DIR, 'api/spawn.js');
  const child = spawn(process.execPath, [spawnScript, flowId, step], {
    stdio: 'inherit'
  });

  child.on('exit', (code) => {
    if (code === 0) {
      console.log(`✅ ${step} spawned successfully`);
      updateWorkflowState(flowId, {
        currentStep: step,
        [`steps.${step}`]: 'running'
      });
    } else {
      console.error(`❌ ${step} spawn failed with code ${code}`);
      updateWorkflowState(flowId, {
        [`steps.${step}`]: 'failed'
      });
    }
  });
}

function watchWorkflow(flowId, interval = 5000) {
  console.log(`👀 Watching workflow: ${flowId}`);
  console.log(`   Check interval: ${interval}ms`);
  console.log(`   Auto-retry: ${MAX_RETRIES} time(s) on failure`);
  console.log(`   Started: ${new Date().toISOString()}`);
  console.log('');

  let lastStatuses = {};
  let prevLastRetryAt = null;

  const checkInterval = setInterval(() => {
    const state = getWorkflowState(flowId);

    if (!state) {
      console.error('❌ Workflow not found, stopping watcher');
      clearInterval(checkInterval);
      return;
    }

    // Cache invalidation: detect external retry via lastRetryAt timestamp change
    if (state.lastRetryAt && state.lastRetryAt !== prevLastRetryAt) {
      console.log('🔄 Manual retry detected, invalidating status cache');
      lastStatuses = {};
      prevLastRetryAt = state.lastRetryAt;
      return; // Skip this tick, re-read on next
    }

    const { workflow, outputs, statuses, workDir } = state;
    const stepsToUse = _getSteps(flowId);

    // Check each step for status changes
    stepsToUse.forEach((step, idx) => {
      const currentStatus = statuses[step];
      const lastStatus = lastStatuses[step];

      // Skip if no change
      if (currentStatus === lastStatus) {
        return;
      }

      // New output file detected
      if (outputs[step] && !lastStatus) {
        console.log(`📄 ${step} output detected: ${TEAM_CONFIG.members[step].outputs[0]}`);
      }

      // Status changed
      if (currentStatus && currentStatus !== lastStatus) {
        const statusIcon = currentStatus === 'DONE' ? '✅' :
                          currentStatus === 'NEEDS_FIX' ? '🔄' :
                          currentStatus === 'FAILED' ? '❌' :
                          currentStatus === 'BLOCKED' ? '🚫' :
                          currentStatus === 'IN_PROGRESS' ? '⏳' :
                          currentStatus === 'NOT_STARTED' ? '⏸️' : '❓';
        console.log(`${statusIcon} ${step} status: ${currentStatus}`);

        if (currentStatus === 'DONE') {
          // Mark as done
          updateWorkflowState(flowId, {
            [`steps.${step}`]: 'done'
          });

          // Log token usage for completed step
          const tokenData = parseStepTokens(flowId, step);
          if (tokenData.total > 0) {
            console.log(`💰 ${step} tokens: ${formatTokens(tokenData.total)}`);
          }

          // Update memory tree with completed step
          try {
            updateTree(flowId, step);
          } catch (e) {
            console.error(`⚠️  Memory tree update failed for ${step}: ${e.message}`);
          }

          // Clean up PID file — output DONE confirms step finished
          // Kill the process first if still alive (codex may linger after writing output)
          const donePidFile = pidFilePath(flowId, step);
          if (fs.existsSync(donePidFile)) {
            try {
              const pidData = JSON.parse(fs.readFileSync(donePidFile, 'utf8'));
              if (isProcessAlive(pidData.pid)) {
                console.log(`💀 Stopping ${step} process (PID ${pidData.pid}) — output already DONE`);
                try { process.kill(pidData.pid, 'SIGTERM'); } catch (_) {}
              }
            } catch (_) {}
            fs.unlinkSync(donePidFile);
            console.log(`🧹 Removed .pid.${step} (output confirmed DONE)`);
          }

          // Clean up stale feedback files when implementer completes successfully
          if (step === 'implementer') {
            const feedbackFiles = ['feedback-from-verifier.md'];
            feedbackFiles.forEach(name => {
              const fbPath = path.join(workDir, 'output', name);
              if (fs.existsSync(fbPath)) {
                fs.unlinkSync(fbPath);
                console.log(`🧹 Cleaned stale feedback: ${name}`);
              }
            });
          }

          // Spawn next step if exists
          const nextStep = stepsToUse[idx + 1];
          if (nextStep && workflow.steps[nextStep] === 'waiting') {
            if (outputs[nextStep]) {
              const nextStatus = statuses[nextStep];
              console.log(`⏭️  ${nextStep} output already exists (${nextStatus || 'UNKNOWN'}), skip spawn`);
              if (nextStatus === 'DONE') {
                updateWorkflowState(flowId, { [`steps.${nextStep}`]: 'done' });
              }
            } else {
              console.log(`➡️  Scheduling spawn of ${nextStep} in 2s`);
              setTimeout(() => spawnStep(flowId, nextStep), 2000);
            }
          } else if (!nextStep) {
            console.log('');
            console.log('🎉 All steps completed!');
            // Mark workflow as completed
            updateWorkflowState(flowId, {
              status: 'completed',
              stoppedAt: new Date().toISOString()
            });
            // Print flow token summary
            const { getFlowTokens: getFlowTokensFn } = require('../utils/token-tracker');
            const { flowTotal } = getFlowTokensFn(flowId);
            if (flowTotal > 0) {
              console.log(`💰 Flow total tokens: ${formatTokens(flowTotal)}`);
            }
            console.log('');
            clearInterval(checkInterval);
          } else if (nextStep) {
            console.log(`⏸️  ${nextStep} not spawned (steps.${nextStep}=${workflow.steps[nextStep]}, expected 'waiting')`);
          }
        } else if (currentStatus === 'NEEDS_FIX') {
          // Check NEEDS_FIX iteration limit
          const count = (workflow.needsFixCount && workflow.needsFixCount[step]) || 0;

          if (count >= MAX_NEEDS_FIX) {
            console.error(`🚫 ${step} NEEDS_FIX loop limit (${MAX_NEEDS_FIX}) reached, blocking workflow`);
            updateWorkflowState(flowId, {
              [`steps.${step}`]: 'blocked',
              status: 'blocked',
              blockedStep: step,
              blockedReason: 'needs_fix_loop',
              stoppedAt: new Date().toISOString()
            });
            clearInterval(checkInterval);
            return;
          }

          // Increment NEEDS_FIX counter
          updateWorkflowState(flowId, {
            [`needsFixCount.${step}`]: count + 1
          });

          // Verifier found issues, send back to Implementer
          console.log(`🔁 ${step} found issues, sending back to Implementer...`);

          // Save current verifier findings as feedback
          const feedbackFile = path.join(workDir, 'output', `feedback-from-${step}.md`);
          const currentOutput = path.join(workDir, TEAM_CONFIG.members[step].outputs[0]);
          if (fs.existsSync(currentOutput)) {
            fs.copyFileSync(currentOutput, feedbackFile);
            console.log(`📝 Saved feedback: feedback-from-${step}.md`);
          }

          // Clear implementer output to trigger re-run
          const implOutput = path.join(workDir, TEAM_CONFIG.members.implementer.outputs[0]);
          if (fs.existsSync(implOutput)) {
            fs.unlinkSync(implOutput);
            console.log(`🗑️  Cleared: implementation.md`);
          }

          // Reset downstream steps
          const resetSteps = {};
          const stepsToUse = _getSteps(flowId);
          const implIndex = stepsToUse.indexOf('implementer');
          if (implIndex >= 0) {
            for (let i = implIndex; i < stepsToUse.length; i++) {
              resetSteps[`steps.${stepsToUse[i]}`] = 'waiting';
            }
          }
          updateWorkflowState(flowId, resetSteps);

          // Clear verifier output so it can re-run after fix
          if (step === 'verifier') {
            const verifierOutput = path.join(workDir, TEAM_CONFIG.members.verifier.outputs[0]);
            if (fs.existsSync(verifierOutput)) {
              fs.unlinkSync(verifierOutput);
              console.log(`🗑️  Cleared: verification.md`);
            }
          }

          // Re-spawn implementer with feedback
          // Kill stale implementer process if still running
          const implPidFile = pidFilePath(flowId, 'implementer');
          if (fs.existsSync(implPidFile)) {
            try {
              const pidData = JSON.parse(fs.readFileSync(implPidFile, 'utf8'));
              if (isProcessAlive(pidData.pid)) {
                console.log(`💀 Killing stale implementer (PID ${pidData.pid}) before re-spawn`);
                try { process.kill(pidData.pid, 'SIGTERM'); } catch (_) {}
              }
              fs.unlinkSync(implPidFile);
            } catch (e) {
              try { fs.unlinkSync(implPidFile); } catch (_) {}
            }
          }
          console.log('🚀 Re-spawning Implementer with feedback...');
          setTimeout(() => spawnStep(flowId, 'implementer'), 3000);

        } else if (currentStatus === 'BLOCKED') {
          // Blocked needs human/environment input; stop safely without retry
          console.error(`🚫 ${step} is BLOCKED. Workflow paused for human intervention.`);
          updateWorkflowState(flowId, {
            [`steps.${step}`]: 'blocked',
            status: 'blocked',
            blockedStep: step,
            stoppedAt: new Date().toISOString()
          });
          clearInterval(checkInterval);

        } else if (currentStatus === 'IN_PROGRESS' || currentStatus === 'NOT_STARTED') {
          // Informational only; keep waiting
          updateWorkflowState(flowId, {
            [`steps.${step}`]: currentStatus === 'IN_PROGRESS' ? 'running' : 'waiting'
          });

        } else if (currentStatus === 'UNKNOWN') {
          // Unknown status should not advance workflow
          console.error(`❓ ${step} status UNKNOWN. Explicit ## Status marker required. Workflow paused.`);
          updateWorkflowState(flowId, {
            [`steps.${step}`]: 'unknown',
            status: 'blocked',
            blockedStep: step,
            blockedReason: 'unknown_status',
            stoppedAt: new Date().toISOString()
          });
          clearInterval(checkInterval);

        } else if (currentStatus === 'FAILED') {
          // Check retry count
          const retryCount = getRetryCount(workflow, step);

          if (retryCount < MAX_RETRIES) {
            console.log(`⚠️  ${step} failed, will retry (attempt ${retryCount + 1}/${MAX_RETRIES})`);

            // Update retry count
            updateWorkflowState(flowId, {
              [`retries.${step}`]: retryCount + 1,
              [`steps.${step}`]: 'retrying'
            });

            // Clear failed output file
            const outputFile = path.join(workDir, TEAM_CONFIG.members[step].outputs[0]);
            if (fs.existsSync(outputFile)) {
              fs.unlinkSync(outputFile);
              console.log(`🗑️  Cleared failed output: ${TEAM_CONFIG.members[step].outputs[0]}`);
            }

            // Retry after delay
            setTimeout(() => spawnStep(flowId, step, true), 3000);
          } else {
            console.error(`❌ ${step} failed after ${MAX_RETRIES} retry(ies), stopping workflow`);
            updateWorkflowState(flowId, {
              [`steps.${step}`]: 'failed',
              status: 'failed',
              stoppedAt: new Date().toISOString()
            });
            clearInterval(checkInterval);
          }
        }
      }
    });

    lastStatuses = { ...statuses };
  }, interval);

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n\n⏸️  Watcher stopped (workflow continues in background)');
    clearInterval(checkInterval);
    process.exit(0);
  });
}

// --- NEEDS_FIX handling for parallel mode (flow-isolated) ---

function handleNeedsFix(flowId, step) {
  const state = getWorkflowState(flowId);
  if (!state) {
    console.error(`[${flowId}] ❌ Cannot handle NEEDS_FIX: workflow state not found`);
    return;
  }

  const { workflow, workDir } = state;

  // Check NEEDS_FIX iteration limit
  const count = (workflow.needsFixCount && workflow.needsFixCount[step]) || 0;

  if (count >= MAX_NEEDS_FIX) {
    console.error(`[${flowId}] 🚫 ${step} NEEDS_FIX loop limit (${MAX_NEEDS_FIX}) reached, marking flow as blocked`);
    updateWorkflowState(flowId, {
      [`steps.${step}`]: 'blocked',
      status: 'blocked',
      blockedStep: step,
      blockedReason: 'needs_fix_loop'
    });
    return;
  }

  // Increment NEEDS_FIX counter
  updateWorkflowState(flowId, {
    [`needsFixCount.${step}`]: count + 1
  });

  console.log(`[${flowId}] 🔁 ${step} found issues, sending back to Implementer...`);

  // Save current verifier findings as feedback
  const feedbackFile = path.join(workDir, 'output', `feedback-from-${step}.md`);
  const currentOutput = path.join(workDir, TEAM_CONFIG.members[step].outputs[0]);
  if (fs.existsSync(currentOutput)) {
    fs.copyFileSync(currentOutput, feedbackFile);
    console.log(`[${flowId}] 📝 Saved feedback: feedback-from-${step}.md`);
  }

  // Clear implementer output to trigger re-run
  const implOutput = path.join(workDir, TEAM_CONFIG.members.implementer.outputs[0]);
  if (fs.existsSync(implOutput)) {
    fs.unlinkSync(implOutput);
    console.log(`[${flowId}] 🗑️  Cleared: implementation.md`);
  }

  // Reset downstream steps
  const stepsToUse = _getSteps(flowId);
  const resetSteps = {};
  const implIndex = stepsToUse.indexOf('implementer');
  if (implIndex >= 0) {
    for (let i = implIndex; i < stepsToUse.length; i++) {
      resetSteps[`steps.${stepsToUse[i]}`] = 'waiting';
    }
  }
  updateWorkflowState(flowId, resetSteps);

  // Clear verifier output so it can re-run after fix
  if (step === 'verifier') {
    const verifierOutput = path.join(workDir, TEAM_CONFIG.members.verifier.outputs[0]);
    if (fs.existsSync(verifierOutput)) {
      fs.unlinkSync(verifierOutput);
      console.log(`[${flowId}] 🗑️  Cleared: verification.md`);
    }
  }

  // Re-spawn implementer with feedback
  // Kill stale implementer process if still running
  const implPidFile = pidFilePath(flowId, 'implementer');
  if (fs.existsSync(implPidFile)) {
    try {
      const pidData = JSON.parse(fs.readFileSync(implPidFile, 'utf8'));
      if (isProcessAlive(pidData.pid)) {
        console.log(`[${flowId}] 💀 Killing stale implementer (PID ${pidData.pid}) before re-spawn`);
        try { process.kill(pidData.pid, 'SIGTERM'); } catch (_) {}
      }
      fs.unlinkSync(implPidFile);
    } catch (e) {
      try { fs.unlinkSync(implPidFile); } catch (_) {}
    }
  }
  console.log(`[${flowId}] 🚀 Re-spawning Implementer with feedback...`);
  setTimeout(() => spawnStep(flowId, 'implementer'), 3000);
}

// --- Parallel monitoring ---

const PARALLEL_STATUS_FILE = path.join(SKILL_DIR, 'parallel-status.json');

function readParallelStatus() {
  try {
    const content = fs.readFileSync(PARALLEL_STATUS_FILE, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`❌ Cannot read parallel-status.json: ${err.message}`);
    return null;
  }
}

function watchParallel(interval = 5000) {
  console.log(`👀 Watching parallel flows`);
  console.log(`   Status file: ${PARALLEL_STATUS_FILE}`);
  console.log(`   Check interval: ${interval}ms`);
  console.log('');

  const startTime = Date.now();
  const flowResults = {}; // { flowId: { status: 'pass'|'fail', elapsed: number } }
  let lastStatuses = {}; // { flowId: { step: status } }
  let allDone = false;

  const checkInterval = setInterval(() => {
    const parallelStatus = readParallelStatus();
    if (!parallelStatus) {
      console.error('❌ parallel-status.json unreadable, stopping watcher');
      clearInterval(checkInterval);
      return;
    }

    const activeFlows = parallelStatus.running || [];

    if (activeFlows.length === 0 && (parallelStatus.queue || []).length === 0) {
      // No running and no queued flows - check if we tracked any
      if (Object.keys(flowResults).length > 0 && !allDone) {
        allDone = true;
        emitSummary(flowResults, startTime);
        clearInterval(checkInterval);
      }
      return;
    }

    // Monitor each active flow
    activeFlows.forEach(flow => {
      const { flowId } = flow;
      const state = getWorkflowState(flowId);

      if (!state) {
        // Flow directory may not exist yet
        return;
      }

      const { statuses } = state;
      const prevFlowStatuses = lastStatuses[flowId] || {};
      const stepsToUse = _getSteps(flowId);

      stepsToUse.forEach((step) => {
        const currentStatus = statuses[step];
        const lastStatus = prevFlowStatuses[step];

        if (currentStatus && currentStatus !== lastStatus) {
          const statusIcon = currentStatus === 'DONE' ? '✅' :
                            currentStatus === 'NEEDS_FIX' ? '🔄' :
                            currentStatus === 'FAILED' ? '❌' :
                            currentStatus === 'BLOCKED' ? '🚫' :
                            currentStatus === 'IN_PROGRESS' ? '⏳' :
                            currentStatus === 'NOT_STARTED' ? '⏸️' : '❓';
          console.log(`[${flowId}] ${statusIcon} ${step} status: ${currentStatus}`);

          // Trigger flow-isolated fix loop for NEEDS_FIX
          if (currentStatus === 'NEEDS_FIX') {
            handleNeedsFix(flowId, step);
          }

          // Update memory tree in parallel mode
          if (currentStatus === 'DONE') {
            // Log token usage
            const tokenData = parseStepTokens(flowId, step);
            if (tokenData.total > 0) {
              console.log(`[${flowId}] 💰 ${step} tokens: ${formatTokens(tokenData.total)}`);
            }

            try {
              updateTree(flowId, step);
            } catch (e) {
              console.error(`[${flowId}] ⚠️  Memory tree update failed for ${step}: ${e.message}`);
            }
          }

          // Clean up stale feedback when implementer completes in parallel mode
          if (currentStatus === 'DONE' && step === 'implementer') {
            const flowState = getWorkflowState(flowId);
            if (flowState) {
              const feedbackFiles = ['feedback-from-verifier.md'];
              feedbackFiles.forEach(name => {
                const fbPath = path.join(flowState.workDir, 'output', name);
                if (fs.existsSync(fbPath)) {
                  fs.unlinkSync(fbPath);
                  console.log(`[${flowId}] 🧹 Cleaned stale feedback: ${name}`);
                }
              });
            }
          }
        }
      });

      lastStatuses[flowId] = { ...statuses };

      // Determine if flow completed
      const stepsToUseLocal = _getSteps(flowId);
      const lastStep = stepsToUseLocal[stepsToUseLocal.length - 1];
      const lastStepStatus = statuses[lastStep];
      if (lastStepStatus === 'DONE' && !flowResults[flowId]) {
        flowResults[flowId] = { status: 'pass', elapsed: Date.now() - startTime };
        // Mark workflow.json as completed
        updateWorkflowState(flowId, {
          status: 'completed',
          stoppedAt: new Date().toISOString()
        });
      } else if (lastStepStatus === 'FAILED' && !flowResults[flowId]) {
        flowResults[flowId] = { status: 'fail', elapsed: Date.now() - startTime };
        // Mark workflow.json as failed
        updateWorkflowState(flowId, {
          status: 'failed',
          stoppedAt: new Date().toISOString()
        });
      }

      // Also check if any step is in a terminal failure state (blocked/failed in workflow)
      if (!flowResults[flowId] && state.workflow && state.workflow.status === 'failed') {
        flowResults[flowId] = { status: 'fail', elapsed: Date.now() - startTime };
      }
    });

    // Re-read status to check if all flows completed (running drained + queue empty)
    const updatedStatus = readParallelStatus();
    if (updatedStatus) {
      const stillRunning = (updatedStatus.running || []).length;
      const stillQueued = (updatedStatus.queue || []).length;

      if (stillRunning === 0 && stillQueued === 0 && Object.keys(flowResults).length > 0 && !allDone) {
        allDone = true;
        emitSummary(flowResults, startTime);
        clearInterval(checkInterval);
      }
    }
  }, interval);

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n\n⏸️  Parallel watcher stopped');
    clearInterval(checkInterval);
    process.exit(0);
  });
}

function emitSummary(flowResults, startTime) {
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  let passCount = 0;
  let failCount = 0;
  let totalTokens = 0;

  console.log('');
  console.log('━'.repeat(50));
  Object.entries(flowResults).forEach(([flowId, result]) => {
    const icon = result.status === 'pass' ? '✅' : '❌';
    const elapsed = (result.elapsed / 1000).toFixed(1);
    const { flowTotal } = require('../utils/token-tracker').getFlowTokens(flowId);
    totalTokens += flowTotal;
    const tokenStr = flowTotal > 0 ? ` | ${formatTokens(flowTotal)} tokens` : '';
    console.log(`  ${icon} ${flowId}: ${result.status.toUpperCase()} (${elapsed}s${tokenStr})`);
    if (result.status === 'pass') passCount++;
    else failCount++;
  });
  console.log('━'.repeat(50));
  console.log(`🏁 Parallel batch complete: ${passCount} passed, ${failCount} failed, elapsed: ${totalElapsed}s`);
  if (totalTokens > 0) {
    console.log(`💰 Total tokens: ${formatTokens(totalTokens)}`);
  }
  console.log('');
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const parallelFlag = args.includes('--parallel');
  const nonFlagArgs = args.filter(a => !a.startsWith('--'));

  if (parallelFlag) {
    const interval = parseInt(nonFlagArgs[0]) || 5000;
    watchParallel(interval);
  } else {
    const flowId = nonFlagArgs[0];
    const intervalStr = nonFlagArgs[1];

    if (!flowId) {
      console.error('Usage: watcher.js <flow-id> [interval-ms]');
      console.error('       watcher.js --parallel [interval-ms]');
      process.exit(1);
    }

    const interval = parseInt(intervalStr) || 5000;
    watchWorkflow(flowId, interval);
  }
}

module.exports = { watchWorkflow, watchParallel, getWorkflowState, emitSummary, readParallelStatus, handleNeedsFix, isStepAlreadyRunning, isStepStillRunning, registerSpawn, unregisterSpawn };

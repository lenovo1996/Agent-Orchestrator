const fs = require('fs');
const path = require('path');
const { OUTPUT_ROOT, STEPS } = require('./workflow-manager');

// --- PID file-based spawn guard ---

function pidFilePath(flowId, step) {
  const workDir = path.join(OUTPUT_ROOT, flowId);
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

function killWorkflowProcesses(flowId) {
  const workDir = path.join(OUTPUT_ROOT, flowId);
  let killedCount = 0;

  // 1. Kill all agent PIDs (.pid.<step> files)
  STEPS.forEach(step => {
    const pidFile = path.join(workDir, `.pid.${step}`);
    if (fs.existsSync(pidFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
        if (data.pid) {
          try {
            process.kill(-data.pid, 'SIGTERM');
            console.log(`   💀 Killed ${step} process group (PGID ${data.pid})`);
            killedCount++;
          } catch (e) {
            if (e.code === 'ESRCH') {
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
  } catch (e) { /* pgrep returns non-zero if no match */ }

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
  } catch (e) { /* pgrep returns non-zero if no match */ }

  return killedCount;
}

module.exports = {
  pidFilePath,
  isProcessAlive,
  registerSpawn,
  unregisterSpawn,
  isStepAlreadyRunning,
  isStepStillRunning,
  killWorkflowProcesses
};

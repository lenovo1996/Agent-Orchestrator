#!/usr/bin/env node
// spawn-via-gateway.js - Spawn agents via Codex CLI wrapper (no Gateway API needed)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { initTree, generateActiveContext, getActiveContextPath, getTaskDir, getTreePath } = require('../utils/memory-tree');

const SCRIPT_DIR = path.resolve(__dirname);

// Parse --worktree-path option from argv (before positional args processing)
function parseWorktreePath(argv) {
  const idx = argv.indexOf('--worktree-path');
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return null;
}

async function main() {
  const worktreePath = parseWorktreePath(process.argv);
  // Filter out --worktree-path and its value from argv for positional parsing
  const positionalArgs = process.argv.filter((arg, i, arr) => {
    if (arg === '--worktree-path') return false;
    if (i > 0 && arr[i - 1] === '--worktree-path') return false;
    return true;
  });
  const [,, flowId, stepArg] = positionalArgs;

  if (!flowId) {
    console.error('Usage: spawn-via-gateway.js <flow-id> [step]');
    process.exit(1);
  }

  const scriptsDir = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(scriptsDir, '..');
  const realRepoRoot = path.resolve(scriptsDir, '../..');
  const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(repoRoot, 'team.json'), 'utf8'));
  const outputRoot = path.resolve(repoRoot, TEAM_CONFIG.outputRoot || 'task-flows');

  function resolveWorkDir(flowId) {
    const directPath = path.join(outputRoot, flowId);
    if (fs.existsSync(path.join(directPath, 'workflow.json'))) return directPath;

    // Search in workspaces
    if (fs.existsSync(outputRoot)) {
        for (const ws of fs.readdirSync(outputRoot)) {
           const potentialPath = path.join(outputRoot, ws, flowId);
           if (fs.existsSync(path.join(potentialPath, 'workflow.json'))) return potentialPath;
        }
    }
    return directPath; // default fallback
  }

  const workDir = resolveWorkDir(flowId);

  if (!fs.existsSync(workDir)) {
    console.error(`❌ Flow not found: ${flowId}`);
    process.exit(1);
  }

  const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));
  const workspaceDir = workflow.workspaceDir;
  const jiraKey = workflow.jiraKey;
  const customPrompt = workflow.customPrompt || '';

  console.log(`📋 Flow: ${flowId}`);
  console.log(`🎫 Jira: ${jiraKey}`);
  if (customPrompt) {
    console.log(`📝 Custom: ${customPrompt}`);
  }
  console.log('');

  // Determine which step to spawn
  const step = stepArg || 'clarifier';
  const member = TEAM_CONFIG.members[step];

  if (!member) {
    console.error(`❌ Unknown step: ${step}`);
    process.exit(1);
  }

  // Build previous outputs list
  const { getSteps } = require('../orchestrator/workflow-manager');
  const stepsToUse = getSteps(workflow);
  const stepIndex = stepsToUse.indexOf(step);
  const prevOutputs = [];

  for (let i = 0; i < stepIndex; i++) {
    const prevStep = stepsToUse[i];
    const prevMember = TEAM_CONFIG.members[prevStep];
    const prevFile = path.join(workDir, prevMember.outputs[0]);
    if (fs.existsSync(prevFile)) {
      prevOutputs.push(prevFile);
    }
  }

  // --- Memory Tree: generate active-context for this step ---
  const flowTreePath = getTreePath(flowId);
  if (!fs.existsSync(flowTreePath)) {
    initTree(flowId);
  }
  const activeContextFile = generateActiveContext(flowId, step);

  // Build task prompt
  let task = `You are the **${member.role}** on a dev team.\n\n`;
  task += `## Instructions\n\nRead your full instructions from:\n${repoRoot}/prompts/${step}.md\n\n`;
  task += `## Context\n\n`;
  task += `- Jira ticket: ${jiraKey}\n`;
  task += `- Repo root: ${realRepoRoot}\n`;
  if (workspaceDir) task += `- Workspace dir: ${workspaceDir}\n`;
  task += `- Work dir: ${workDir}\n`;

  // Inject active-context reference
  if (activeContextFile && fs.existsSync(activeContextFile)) {
    task += `\n## Quick Context (Memory Tree)\n\n`;
    task += `Read this file FIRST for a compact summary of all prior steps:\n`;
    task += `- ${activeContextFile}\n\n`;
    task += `This contains the essential context from previous agents. Only read full output files if you need more detail.\n`;
  }

  if (customPrompt) {
    task += `\n## Custom Requirement\n\n${customPrompt}\n`;
  }

  if (prevOutputs.length > 0) {
    task += `\n## Previous Outputs (full files — read only if active-context lacks detail)\n\n`;
    prevOutputs.forEach(f => {
      task += `- ${f}\n`;
    });
    task += `\nPrefer active-context.md above. Only read these if you need full detail on a specific section.\n`;
  }

  // Include feedback from verifier when re-running implementer
  if (step === 'implementer') {
    const feedbackFiles = ['feedback-from-verifier.md']
      .map(name => path.join(workDir, 'output', name))
      .filter(file => fs.existsSync(file));
    if (feedbackFiles.length > 0) {
      task += `\n## Fix Feedback\n\n`;
      feedbackFiles.forEach(f => {
        task += `- ${f}\n`;
      });
      task += `\nYou are re-running because Verifier requested fixes. Read all feedback files and fix the code.\n`;
    }
  }

  task += `\n## Your Output\n\n`;
  task += `Write your output to: ${workDir}/output/${member.outputs[0].replace('output/', '')}\n\n`;
  task += `Follow the prompt instructions exactly.`;
  task = task.replace(/{{REPO_ROOT}}/g, realRepoRoot);


  // Write prompt to file and run agent through Codex CLI for realtime streaming logs
  const promptsDir = path.join(workDir, 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true });
  const promptFile = path.join(promptsDir, `${step}-prompt.txt`);
  fs.writeFileSync(promptFile, task);

  const wrapperScript = path.join(SCRIPT_DIR, '../agent/wrapper.sh');

  console.log(`🚀 Spawning ${step} via ${member.runtime || TEAM_CONFIG.defaultRuntime || 'codex'} runtime...`);
  console.log(`📝 Prompt: ${promptFile}`);
  console.log(`📜 Log: ${path.join(workDir, 'logs', `${step}.log`)}`);
  console.log(`🤖 Model: ${member.model || 'default'}`);
  console.log(`🧠 Reasoning: ${member.thinking || 'default'}`);
  console.log(`⚙️  Runtime: ${member.runtime || 'codex'}`);
  if (workspaceDir) {
    console.log(`🌲 Workspace: ${workspaceDir}`);
  } else if (worktreePath) {
    console.log(`🌲 Worktree: ${worktreePath}`);
  }

  // Pass runtime config as env vars to wrapper
  const env = { ...process.env };
  env.AGENT_RUNTIME = member.runtime || TEAM_CONFIG.defaultRuntime || 'codex';
  if (member.model) {
    env.AGENT_MODEL = member.model;
    env.CODEX_MODEL = member.model; // backward compat
  }
  if (member.thinking) {
    env.AGENT_REASONING = member.thinking;
    env.CODEX_REASONING = member.thinking; // backward compat
  }
  if (member.runtimeCommand) {
    env.AGENT_COMMAND = member.runtimeCommand;
  }
  if (member.permission) {
    env.AGENT_PERMISSION = member.permission;
  }
  if (member.maxTurns) {
    env.AGENT_MAX_TURNS = String(member.maxTurns);
  }

  const spawnArgs = [wrapperScript, flowId, step, workDir, promptFile];
  if (workspaceDir) {
    spawnArgs.push(workspaceDir);
  } else if (worktreePath) {
    spawnArgs.push(worktreePath);
  }

  const child = spawn('bash', spawnArgs, {
    cwd: workspaceDir || worktreePath || repoRoot,
    env: env,
    stdio: 'ignore',
    detached: true
  });
  child.unref();

  // Write PID file for duplicate spawn prevention
  if (child.pid) {
    const pidFile = path.join(workDir, `.pid.${step}`);
    fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
    console.log(`🔒 PID ${child.pid} → .pid.${step}`);
  }

  const result = { ok: true, step, flowId, pid: child.pid };

  if (!result) {
    console.error(`❌ Failed to spawn ${step}`);
    process.exit(1);
  }

  console.log('');
  console.log(`✅ ${step} spawned successfully`);
  console.log('📺 Monitor in tmux or check output files');
  console.log('');

  const nextStepIndex = stepIndex + 1;
  if (nextStepIndex < stepsToUse.length) {
    console.log('Next steps will auto-spawn when current step completes.');
    console.log('Or manually spawn next step:');
    console.log(`  node ${__filename} ${flowId} ${stepsToUse[nextStepIndex]}`);
  } else {
    console.log('This is the final step.');
  }
}

// Only run main() when executed directly (not when required by tests)
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

// Export helpers for testing
module.exports = { parseWorktreePath };

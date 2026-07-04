const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'team.json'), 'utf8'));
const OUTPUT_ROOT = path.resolve(REPO_ROOT, TEAM_CONFIG.outputRoot || 'task-flows');
const DEFAULT_STEPS = ['clarifier', 'architect', 'planner', 'implementer', 'verifier'];

function getSteps(workflow) {
  return workflow?.stepOrder || DEFAULT_STEPS;
}

function resolveWorkDir(flowId) {
    const directPath = path.join(OUTPUT_ROOT, flowId);
    if (fs.existsSync(path.join(directPath, 'workflow.json'))) return directPath;

    // Search in workspaces
    if (fs.existsSync(OUTPUT_ROOT)) {
        for (const ws of fs.readdirSync(OUTPUT_ROOT)) {
           const potentialPath = path.join(OUTPUT_ROOT, ws, flowId);
           if (fs.existsSync(path.join(potentialPath, 'workflow.json'))) return potentialPath;
        }
    }
    return directPath; // default fallback
}

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
  const workflowPath = path.join(workDir, 'workflow.json');
  fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2));
}

function getWorkflowState(flowId) {
  const workDir = resolveWorkDir(flowId);
  const workflowPath = path.join(workDir, 'workflow.json');

  if (!fs.existsSync(workflowPath)) {
    return null;
  }

  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const steps = getSteps(workflow);

  // Check which outputs exist and parse their status
  const outputs = {};
  const statuses = {};

  steps.forEach(step => {
    const member = TEAM_CONFIG.members[step];
    const outputFile = path.join(workDir, member.outputs[0]);
    outputs[step] = fs.existsSync(outputFile);

    if (outputs[step]) {
      statuses[step] = parseOutputStatus(outputFile, step);
    } else {
      if (['developer', 'reviewer', 'qa'].includes(step) && workflow.steps && workflow.steps[step] === 'done') {
        statuses[step] = 'NEEDS_FIX';
      } else {
        statuses[step] = null;
      }
    }
  });

  return { workflow, outputs, statuses, workDir, lastRetryAt: workflow.lastRetryAt };
}

function parseOutputStatus(filePath, step) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    // Look for status markers in output
    const statusMatch = content.match(/##\s*Status\s*[:\n]\s*(DONE|NEEDS_FIX|FAILED|BLOCKED|IN[ _]PROGRESS|NOT[ _]STARTED)/i);
    if (statusMatch) {
      let status = statusMatch[1].toUpperCase().replace(/ /g, '_');

      if (status === 'DONE' && ['reviewer', 'qa'].includes(step) && content.toLowerCase().includes('need fix')) {
         status = 'NEEDS_FIX';
      }
      return status;
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
    } else if (key.startsWith('needsFixHandled.')) {
      const step = key.slice('needsFixHandled.'.length);
      if (!workflow.needsFixHandled) workflow.needsFixHandled = {};
      if (value === null || value === undefined) {
        delete workflow.needsFixHandled[step];
      } else {
        workflow.needsFixHandled[step] = value;
      }
    } else {
      workflow[key] = value;
    }
  });

  fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2));
}

module.exports = { resolveWorkDir,
  OUTPUT_ROOT,
  STEPS: DEFAULT_STEPS,
  getSteps,
  TEAM_CONFIG,
  loadWorkflow,
  saveWorkflow,
  getWorkflowState,
  updateWorkflowState,
  parseOutputStatus
};

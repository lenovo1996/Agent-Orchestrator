const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = path.resolve(__dirname, '..');
const SKILL_DIR = path.dirname(SCRIPT_DIR);
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'team.json'), 'utf8'));
const REPO_ROOT = path.resolve(SKILL_DIR, '..');
const OUTPUT_ROOT = path.resolve(REPO_ROOT, TEAM_CONFIG.outputRoot || '.dev-team/task-flows');
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

function getWorkflowState(flowId) {
  const workDir = path.join(OUTPUT_ROOT, flowId);
  const workflowPath = path.join(workDir, 'workflow.json');

  if (!fs.existsSync(workflowPath)) {
    return null;
  }

  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

  // Check which outputs exist and parse their status
  const outputs = {};
  const statuses = {};

  STEPS.forEach(step => {
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
  const workDir = path.join(OUTPUT_ROOT, flowId);
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

module.exports = {
  OUTPUT_ROOT,
  STEPS,
  TEAM_CONFIG,
  loadWorkflow,
  saveWorkflow,
  getWorkflowState,
  updateWorkflowState,
  parseOutputStatus
};

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'team.json'), 'utf8'));
const OUTPUT_ROOT = path.resolve(REPO_ROOT, TEAM_CONFIG.outputRoot || 'task-flows');
const DEFAULT_STEPS = ['clarifier', 'architect', 'planner', 'implementer', 'verifier'];

function getFixTargetStep(workflow) {
  const steps = getSteps(workflow);
  if (steps.includes('developer')) return 'developer';
  if (steps.includes('implementer')) return 'implementer';

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (/(developer|implementer|frontend|backend|dev)/i.test(step)) return step;
  }

  return steps[0] || null;
}

function isReviewLikeOutput(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return lower.endsWith('/output/review.md') || lower.endsWith('/output/qa.md') || lower.endsWith('/output/verification.md');
}

function contentImpliesNeedsFix(content) {
  const text = String(content || '');

  // Negation words that indicate a keyword is used in a POSITIVE context
  // e.g. "no blockers", "no critical bugs", "no failed tests"
  const negationRe = /\b(?:no|not|without|zero|none|n\/a|any)\b/i;

  // Keywords that, when found WITHOUT negation, imply NEEDS_FIX
  const keywordPatterns = [
    /\bneeds?_fix\b/i,
    /\bneed\s+fix(?:es)?\b/i,
    /\bmust\s+fix\b/i,
    /\brequires?\s+fix(?:es)?\b/i,
    /\bfix\s+required\b/i,
    /\bfix\s+before\b/i,
    /\bnot\s+ready\b/i,
    /\bqa\s*[:\-]?\s*failed\b/i,
    /\breview\s*[:\-]?\s*failed\b/i,
    /\bfailed\b(?!\s*:\s*\d)/i,
    /\bblocker(s)?\b/i,
    /\bcritical\s+bug(s)?\b/i,
    /\bmajor\s+bug(s)?\b/i,
    /\bphải\s+sửa\b/i,
    /\bcần\s+sửa\b/i,
    /\bkhông\s+đạt\b/i
  ];

  // Split text into sentences (by newline or period)
  const sentences = text.split(/[.\n]+/);

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    // Skip test result summary lines (e.g. "- Passed: 12 (86%)", "- Failed: 1 (7%)")
    // These are metric counts, not actual failure indicators
    if (/^\s*[-*]\s*(Passed|Failed|Warning|Warnings?|Total|Tests?|Success|Error|Skip(?:ped)?)\s*[:\-]/i.test(trimmed)) {
      continue;
    }

    // Skip overall verdict lines (e.g. "- Overall: ✅ PASS", "- Overall: ⚠️ MINOR ISSUES")
    if (/^\s*[-*]\s*Overall\s*[:\-]/i.test(trimmed)) {
      continue;
    }

    // Skip test case result lines (e.g. "- **Actual**: ✅ PASS", "- **Actual**: ❌ FAIL")
    if (/^\s*[-*]\s*\*\*Actual\*\*\s*[:\-]/i.test(trimmed)) {
      continue;
    }

    // Skip lines that are purely numeric/metric (e.g. "Passed: 12", "Failed: 0", "14 total")
    if (/^(Passed|Failed|Warning|Total|Tests?)\s*[:\-]\s*\d+/i.test(trimmed)) {
      continue;
    }

    for (const re of keywordPatterns) {
      if (re.test(trimmed)) {
        // Keyword found — check if the SAME sentence has a negation word
        if (negationRe.test(trimmed)) {
          continue; // Negated, e.g. "no blockers" — skip
        }
        return true; // Un-negated keyword found
      }
    }
  }

  return false;
}

function isWorkflowCompletionValid(workflow, statuses, outputs) {
  const steps = getSteps(workflow);
  if (!steps.length) return { valid: false, reason: 'no_steps' };

  for (const step of steps) {
    const stepState = workflow.steps && workflow.steps[step];

    // If output file exists, check its parsed status
    if (outputs && outputs[step]) {
      const status = statuses ? statuses[step] : null;
      if (status !== 'DONE') {
        return { valid: false, reason: `non_done_status:${step}:${status || 'MISSING'}`, step, status };
      }
    } else if (stepState === 'done') {
      // Output file was cleared (e.g. by NEEDS_FIX reset) but workflow state
      // records this step as done from a prior successful run. Accept it.
      continue;
    } else {
      return { valid: false, reason: `missing_output:${step}`, step };
    }
  }

  return { valid: true };
}

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
      const parsed = statusMatch[1].toUpperCase().replace(/ /g, '_');
      // OPTION A: Explicit status marker is authoritative — never override.
      // The agent wrote ## Status: DONE intentionally. Content analysis is only
      // used as fallback when no explicit marker exists.
      return parsed;
    }

    if (isReviewLikeOutput(filePath) && contentImpliesNeedsFix(content)) {
      return 'NEEDS_FIX';
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
  getFixTargetStep,
  TEAM_CONFIG,
  loadWorkflow,
  saveWorkflow,
  getWorkflowState,
  updateWorkflowState,
  parseOutputStatus,
  isWorkflowCompletionValid
};

#!/usr/bin/env node
/**
 * retry-handler.js — Smart retry logic for ar-meter-clone flows
 *
 * Logic:
 * 1. Step failed/blocked + no output → retry step
 * 2. Step failed/blocked + output has fix request → extract bugs, update customPrompt, retry
 * 3. Step failed/blocked + output has no fix request → mark step done, resume dependents
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'task-flows');
const WORKSPACE = 'ar-meter-clone';
const FLOW_DIR = path.join(OUTPUT_ROOT, WORKSPACE);

// Step output file mapping (from team.json member.outputs)
const STEP_OUTPUTS = {
  planner: 'output/plan.md',
  developer: 'output/developer.md',
  reviewer: 'output/review.md',
  qa: 'output/qa.md',
  clarifier: 'output/clarify.md',
  'frontend-dev': 'output/frontend.md',
  'backend-dev': 'output/backend.md',
};

function loadWorkflow(flowDir) {
  const wfPath = path.join(flowDir, 'workflow.json');
  if (!fs.existsSync(wfPath)) return null;
  return JSON.parse(fs.readFileSync(wfPath, 'utf8'));
}

function saveWorkflow(flowDir, workflow) {
  fs.writeFileSync(
    path.join(flowDir, 'workflow.json'),
    JSON.stringify(workflow, null, 2)
  );
}

function getTaskName(workflow) {
  const prompt = workflow.customPrompt || '';
  for (const line of prompt.split('\n')) {
    if (line.startsWith('Task:')) {
      return line.split(' - ')[0].replace('Task: ', '').trim();
    }
  }
  return workflow.flowId || '?';
}

function findFailedStep(workflow) {
  const steps = workflow.steps || {};
  for (const [step, status] of Object.entries(steps)) {
    if (status === 'failed') {
      return step;
    }
  }
  return null;
}

function findBlockedStep(workflow) {
  const steps = workflow.steps || {};
  for (const [step, status] of Object.entries(steps)) {
    if (status === 'blocked') {
      return step;
    }
  }
  return null;
}

function getOutputFile(flowDir, step) {
  const relPath = STEP_OUTPUTS[step];
  if (!relPath) return null;
  const fullPath = path.join(flowDir, relPath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
}

function checkNeedsFix(content) {
  if (!content) return { needsFix: false, issues: [] };

  // First: check explicit status marker (authoritative)
  const statusMatch = content.match(/##\s*Status\s*[:\n]\s*(DONE|NEEDS_FIX|BLOCKED|FAILED|IN_PROGRESS)/i);
  if (statusMatch) {
    const status = statusMatch[1].toUpperCase();
    if (status === 'DONE') {
      return { needsFix: false, issues: [] }; // DONE = no fix needed
    }
    if (status === 'NEEDS_FIX' || status === 'FAILED') {
      return { needsFix: true, issues: [`Status marker: ${status}`] };
    }
    if (status === 'BLOCKED') {
      return { needsFix: true, issues: [`Status marker: BLOCKED`] };
    }
  }

  // No clear status marker → check for issues in content
  const lines = content.split('\n');
  const issues = [];

  // Check for critical/major bugs in output
  const bugPatterns = [
    { re: /\bcritical\s+bug/i, label: 'Critical bug' },
    { re: /\bmajor\s+bug/i, label: 'Major bug' },
    { re: /\bcompilation\s+error/i, label: 'Compilation error' },
    { re: /\bbuild\s+(error|fail)/i, label: 'Build error' },
    { re: /\bblocker/i, label: 'Blocker' },
    { re: /\bmust\s+fix/i, label: 'Must fix' },
    { re: /\bphải\s+sửa/i, label: 'Phải sửa' },
    { re: /\bcần\s+sửa/i, label: 'Cần sửa' },
    { re: /\bnot\s+ready/i, label: 'Not ready' },
    { re: /\bfail(?:ed)?\s*(?:test|case|scenario)/i, label: 'Failed test' },
  ];

  // Skip test result summary lines (e.g. "- Failed: 4 (22%)")
  const skipRe = /^\s*-\s*(Passed|Failed|Warning|Total|Tests|Overall|Blocked)\s*:/i;

  for (const line of lines) {
    if (skipRe.test(line)) continue;
    for (const { re, label } of bugPatterns) {
      if (re.test(line)) {
        // Check for negation
        const negRe = /\b(?:no|not|without|zero|none)\b/i;
        if (!negRe.test(line)) {
          issues.push(`${label}: ${line.trim().substring(0, 120)}`);
        }
        break;
      }
    }
  }

  return {
    needsFix: issues.length > 0,
    issues
  };
}

function extractFixItems(content) {
  if (!content) return '';

  const fixSections = [];
  const lines = content.split('\n');
  let inRelevantSection = false;
  let sectionLines = [];

  for (const line of lines) {
    const lower = line.toLowerCase();

    // Start capturing on relevant headers
    if (/^#{1,3}\s/.test(line) && (
      lower.includes('critical') ||
      lower.includes('blocker') ||
      lower.includes('bug') ||
      lower.includes('issue') ||
      lower.includes('fix') ||
      lower.includes('error') ||
      lower.includes('failed') ||
      lower.includes('important finding')
    )) {
      inRelevantSection = true;
      sectionLines = [line];
      continue;
    }

    // Stop on next header of same/higher level
    if (inRelevantSection && /^#{1,3}\s/.test(line)) {
      if (sectionLines.length > 1) {
        fixSections.push(sectionLines.join('\n'));
      }
      inRelevantSection = false;
      sectionLines = [];
      // Check if new section is also relevant
      if (lower.includes('critical') || lower.includes('blocker') || lower.includes('bug') ||
          lower.includes('issue') || lower.includes('fix') || lower.includes('error') ||
          lower.includes('failed') || lower.includes('important finding')) {
        inRelevantSection = true;
        sectionLines = [line];
      }
      continue;
    }

    if (inRelevantSection) {
      sectionLines.push(line);
    }
  }

  // Flush last section
  if (inRelevantSection && sectionLines.length > 1) {
    fixSections.push(sectionLines.join('\n'));
  }

  return fixSections.join('\n\n').substring(0, 3000); // Limit size
}

async function main() {
  if (!fs.existsSync(FLOW_DIR)) {
    console.log(`❌ Flow directory not found: ${FLOW_DIR}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(FLOW_DIR, { withFileTypes: true });
  const results = { retried: [], fixed: [], completed: [], skipped: [], errors: [] };

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const flowDir = path.join(FLOW_DIR, entry.name);
    const workflow = loadWorkflow(flowDir);
    if (!workflow) continue;

    const taskName = getTaskName(workflow);
    const failedStep = findFailedStep(workflow);
    const blockedStep = findBlockedStep(workflow);
    const problemStep = failedStep || blockedStep;
    const stepLabel = failedStep ? 'failed' : 'blocked';

    if (!problemStep) {
      continue;
    }

    const stepStatus = workflow.steps[problemStep];
    console.log(`\n🔍 ${taskName} — step '${problemStep}' is ${stepStatus} (${stepLabel})`);

    // Get output for the problem step
    const output = getOutputFile(flowDir, problemStep);

    if (!output || output.trim().length === 0) {
      // CASE 1: No output → retry step
      console.log(`   📭 No output → retrying ${problemStep}`);
      try {
        retryStep(entry.name, problemStep);
        results.retried.push({ task: taskName, step: problemStep, reason: 'no output' });
      } catch (e) {
        console.log(`   ❌ Retry failed: ${e.message}`);
        results.errors.push({ task: taskName, step: problemStep, error: e.message });
      }
      continue;
    }

    // Has output — check if it needs fix
    const { needsFix, issues } = checkNeedsFix(output);

    if (needsFix) {
      // CASE 2: Output has fix requests → update customPrompt with bugs, retry
      console.log(`   🔧 Output needs fix (${issues.length} issues):`);
      issues.slice(0, 5).forEach(i => console.log(`      - ${i}`));

      const fixItems = extractFixItems(output);
      updateCustomPromptWithFixes(workflow, problemStep, fixItems, flowDir);

      try {
        retryStep(entry.name, problemStep);
        results.fixed.push({ task: taskName, step: problemStep, issues: issues.length });
      } catch (e) {
        console.log(`   ❌ Retry failed: ${e.message}`);
        results.errors.push({ task: taskName, step: problemStep, error: e.message });
      }
      continue;
    }

    // CASE 3: Output exists, no fix needed → mark step done, resume dependents
    console.log(`   ✅ Output looks clean → marking ${problemStep} as done`);
    workflow.steps[problemStep] = 'done';

    // Check if all steps are done
    const allSteps = workflow.stepOrder || Object.keys(workflow.steps);
    const allDone = allSteps.every(s => workflow.steps[s] === 'done');
    if (allDone) {
      workflow.status = 'completed';
      workflow.stoppedAt = new Date().toISOString();
      console.log(`   🎉 All steps done → flow completed!`);
    } else {
      workflow.status = 'running';
    }

    saveWorkflow(flowDir, workflow);
    results.completed.push({ task: taskName, step: failedStep });
  }

  // Resume dependent workflows if any flows were fixed
  if (results.completed.length > 0 || results.fixed.length > 0) {
    console.log(`\n🔄 Checking dependent workflows...`);
    const { checkAndResumeDependentWorkflows } = require('../orchestrator/index.js');
    checkAndResumeDependentWorkflows();
  }

  // Print summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 Summary:`);
  console.log(`   🔁 Retried (no output): ${results.retried.length}`);
  console.log(`   🔧 Retried (with fix):  ${results.fixed.length}`);
  console.log(`   ✅ Marked done:          ${results.completed.length}`);
  console.log(`   ❌ Errors:               ${results.errors.length}`);

  if (results.retried.length + results.fixed.length + results.completed.length === 0) {
    console.log(`   💤 Nothing to do — all quiet`);
  }
}

function retryStep(flowId, step) {
  const { execSync } = require('child_process');
  const cmd = `node scripts/orchestrator/index.js retry ${flowId} ${step}`;
  console.log(`   ▶️  ${cmd}`);
  execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
}

function updateCustomPromptWithFixes(workflow, failedStep, fixItems, flowDir) {
  const taskName = getTaskName(workflow);
  const fixNote = `\n\n## ⚠️ RETRY CONTEXT — ${failedStep} reported issues:\n${fixItems}\n\nPlease fix the above issues and re-run.`;

  // Append fix context to customPrompt
  if (!workflow.customPrompt.includes('RETRY CONTEXT')) {
    workflow.customPrompt += fixNote;
    saveWorkflow(flowDir, workflow);
    console.log(`   📝 Updated customPrompt with fix context`);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * retry-handler-plantnanny2.js — Retry logic for fourdesire-plantnanny2-clone flows
 *
 * Logic:
 * 1. Step status=failed + no output file → retry that step
 * 2. Step reviewer/qa status=done but output has fix request → retry developer step
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'task-flows');
const WORKSPACE = 'fourdesire-plantnanny2-clone';
const FLOW_DIR = path.join(OUTPUT_ROOT, WORKSPACE);

// Step output file mapping
const STEP_OUTPUTS = {
  planner: 'output/plan.md',
  developer: 'output/developer.md',
  reviewer: 'output/review.md',
  qa: 'output/qa.md',
  clarifier: 'output/clarify.md',
  'devteam-task-dispatcher': 'output/dispatch.md',
};

function loadWorkflow(flowDir) {
  const wfPath = path.join(flowDir, 'workflow.json');
  if (!fs.existsSync(wfPath)) return null;
  return JSON.parse(fs.readFileSync(wfPath, 'utf8'));
}

function saveWorkflow(flowDir, workflow) {
  const tmpPath = path.join(flowDir, 'workflow.json.tmp');
  const wfPath = path.join(flowDir, 'workflow.json');
  fs.writeFileSync(tmpPath, JSON.stringify(workflow, null, 2));
  fs.renameSync(tmpPath, wfPath);
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

function getOutputFile(flowDir, step) {
  const relPath = STEP_OUTPUTS[step];
  if (!relPath) return null;
  const fullPath = path.join(flowDir, relPath);
  if (!fs.existsSync(fullPath)) return null;
  const content = fs.readFileSync(fullPath, 'utf8');
  return content.trim().length > 0 ? content : null;
}

function checkNeedsFix(content) {
  if (!content) return { needsFix: false, issues: [] };

  // Check explicit status marker
  const statusMatch = content.match(/##\s*Status\s*[:\n]\s*(DONE|NEEDS_FIX|BLOCKED|FAILED|IN_PROGRESS)/i);
  if (statusMatch) {
    const status = statusMatch[1].toUpperCase();
    if (status === 'DONE') return { needsFix: false, issues: [] };
    if (status === 'NEEDS_FIX' || status === 'FAILED') {
      return { needsFix: true, issues: [`Status marker: ${status}`] };
    }
    if (status === 'BLOCKED') {
      return { needsFix: true, issues: [`Status marker: BLOCKED`] };
    }
  }

  const lines = content.split('\n');
  const issues = [];

  const bugPatterns = [
    { re: /\bcritical\s+bug/i, label: 'Critical bug' },
    { re: /\bmajor\s+bug/i, label: 'Major bug' },
    { re: /\bcompilation\s+error/i, label: 'Compilation error' },
    { re: /\bbuild\s+(error|fail)/i, label: 'Build error' },
    { re: /\bblocker/i, label: 'Blocker' },
    { re: /\bmust\s+fix/i, label: 'Must fix' },
    { re: /\bphải\s+sửa/i, label: 'Phải sửa' },
    { re: /\bcần\s+sửa/i, label: 'Cần sửa' },
    { re: /\bneeds?\s*fix/i, label: 'Needs fix' },
    { re: /\bnot\s+ready/i, label: 'Not ready' },
    { re: /\bfail(?:ed)?\s*(?:test|case|scenario)/i, label: 'Failed test' },
    { re: /\bNEEDS_FIX\b/i, label: 'NEEDS_FIX' },
  ];

  const skipRe = /^\s*-\s*(Passed|Failed|Warning|Total|Tests|Overall|Blocked)\s*:/i;

  for (const line of lines) {
    if (skipRe.test(line)) continue;
    for (const { re, label } of bugPatterns) {
      if (re.test(line)) {
        const negRe = /\b(?:no|not|without|zero|none)\b/i;
        if (!negRe.test(line)) {
          issues.push(`${label}: ${line.trim().substring(0, 120)}`);
        }
        break;
      }
    }
  }

  return { needsFix: issues.length > 0, issues };
}

function extractFixItems(content) {
  if (!content) return '';
  const fixSections = [];
  const lines = content.split('\n');
  let inRelevantSection = false;
  let sectionLines = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/^#{1,3}\s/.test(line) && (
      lower.includes('critical') || lower.includes('blocker') || lower.includes('bug') ||
      lower.includes('issue') || lower.includes('fix') || lower.includes('error') ||
      lower.includes('failed') || lower.includes('important finding')
    )) {
      inRelevantSection = true;
      sectionLines = [line];
      continue;
    }
    if (inRelevantSection && /^#{1,3}\s/.test(line)) {
      if (sectionLines.length > 1) fixSections.push(sectionLines.join('\n'));
      inRelevantSection = false;
      sectionLines = [];
      if (lower.includes('critical') || lower.includes('blocker') || lower.includes('bug') ||
          lower.includes('issue') || lower.includes('fix') || lower.includes('error') ||
          lower.includes('failed') || lower.includes('important finding')) {
        inRelevantSection = true;
        sectionLines = [line];
      }
      continue;
    }
    if (inRelevantSection) sectionLines.push(line);
  }
  if (inRelevantSection && sectionLines.length > 1) fixSections.push(sectionLines.join('\n'));
  return fixSections.join('\n\n').substring(0, 3000);
}

function retryStep(flowId, step) {
  const cmd = `node scripts/orchestrator/index.js retry ${flowId} ${step}`;
  console.log(`   ▶️  ${cmd}`);
  execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
}

function updateCustomPromptWithFixes(workflow, fixStep, fixItems, flowDir) {
  const fixNote = `\n\n## ⚠️ RETRY CONTEXT — ${fixStep} reported issues:\n${fixItems}\n\nPlease fix the above issues and re-run.`;
  if (!workflow.customPrompt.includes('RETRY CONTEXT')) {
    workflow.customPrompt += fixNote;
    saveWorkflow(flowDir, workflow);
    console.log(`   📝 Updated customPrompt with fix context from ${fixStep}`);
  }
}

async function main() {
  if (!fs.existsSync(FLOW_DIR)) {
    console.log(`❌ Flow directory not found: ${FLOW_DIR}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(FLOW_DIR, { withFileTypes: true });
  const results = { retriedNoOutput: [], retriedFixFromReview: [], retriedFixFromQA: [], errors: [] };

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const flowDir = path.join(FLOW_DIR, entry.name);
    const workflow = loadWorkflow(flowDir);
    if (!workflow) continue;

    // Skip non-FEATURE_IMPLEMENT flows
    if (!workflow.flowId?.includes('FEATURE_IMPLEMENT')) continue;

    const taskName = getTaskName(workflow);
    const steps = workflow.steps || {};

    // RULE 1: Any step with status=failed + no output → retry that step
    for (const [step, status] of Object.entries(steps)) {
      if (status !== 'failed') continue;

      const output = getOutputFile(flowDir, step);
      if (!output) {
        console.log(`\n🔁 ${taskName} — step '${step}' FAILED, no output → retry`);
        try {
          retryStep(entry.name, step);
          results.retriedNoOutput.push({ task: taskName, step });
        } catch (e) {
          console.log(`   ❌ Retry failed: ${e.message}`);
          results.errors.push({ task: taskName, step, error: e.message });
        }
      }
    }

    // RULE 2: reviewer/qa status=done but output has fix request → retry developer
    const reviewSteps = ['reviewer', 'qa'];
    for (const reviewStep of reviewSteps) {
      if (steps[reviewStep] !== 'done') continue;

      const output = getOutputFile(flowDir, reviewStep);
      if (!output) continue;

      const { needsFix, issues } = checkNeedsFix(output);
      if (!needsFix) continue;

      // Find the developer step to retry
      const devStep = steps.hasOwnProperty('developer') ? 'developer' : null;
      if (!devStep) {
        console.log(`\n⚠️ ${taskName} — ${reviewStep} needs fix but no developer step found`);
        continue;
      }

      console.log(`\n🔧 ${taskName} — ${reviewStep} done but needs fix (${issues.length} issues) → retry developer`);
      issues.slice(0, 3).forEach(i => console.log(`   - ${i}`));

      try {
        // Update customPrompt with fix items from review/qa
        const fixItems = extractFixItems(output);
        updateCustomPromptWithFixes(workflow, reviewStep, fixItems, flowDir);

        // Reset developer step and downstream
        workflow.steps['developer'] = 'pending';
        if (workflow.steps['reviewer']) workflow.steps['reviewer'] = 'waiting';
        if (workflow.steps['qa']) workflow.steps['qa'] = 'waiting';
        workflow.status = 'running';
        saveWorkflow(flowDir, workflow);

        retryStep(entry.name, 'developer');
        const bucket = reviewStep === 'qa' ? 'retriedFixFromQA' : 'retriedFixFromReview';
        results[bucket].push({ task: taskName, fromStep: reviewStep, issues: issues.length });
      } catch (e) {
        console.log(`   ❌ Retry failed: ${e.message}`);
        results.errors.push({ task: taskName, step: `developer(from ${reviewStep})`, error: e.message });
      }
    }
  }

  // Summary
  const total = results.retriedNoOutput.length + results.retriedFixFromReview.length + results.retriedFixFromQA.length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 PlantNanny2 Retry Handler Summary:`);
  console.log(`   🔁 Retried (no output):     ${results.retriedNoOutput.length}`);
  console.log(`   🔧 Retried dev (from review): ${results.retriedFixFromReview.length}`);
  console.log(`   🔧 Retried dev (from qa):     ${results.retriedFixFromQA.length}`);
  console.log(`   ❌ Errors:                    ${results.errors.length}`);

  if (total === 0 && results.errors.length === 0) {
    console.log(`   💤 All quiet — nothing to retry`);
  }

  // Exit with error if any retries failed
  if (results.errors.length > 0) process.exit(1);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});

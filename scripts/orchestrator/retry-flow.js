#!/usr/bin/env node
/**
 * lib/retry-flow.js — Shared retry state mutator
 *
 * Canonical module for resetting workflow state before any retry.
 * Used by orchestrator.js, watcher.js, and tmux-helper-template.sh.
 *
 * Exports: prepareRetry, resetDownstream, markStaleAfterRetry, STEPS
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'team.json'), 'utf8'));
const OUTPUT_ROOT = path.resolve(REPO_ROOT, TEAM_CONFIG.outputRoot || 'task-flows');

const { getSteps, resolveWorkDir } = require('./workflow-manager');

/**
 * Staleness threshold for markStaleAfterRetry (3 years in ms).
 * If lastRetryAt is older than this, it's considered irrelevant/ancient.
 * Generous window to account for workflows that ran weeks/months ago but
 * might still be retried by users.
 */
const STALE_THRESHOLD_MS = 3 * 365 * 24 * 60 * 60 * 1000;

/**
 * Reset all downstream steps (after the given step) to 'waiting'.
 * Pure function — mutates the workflow object in place, no I/O.
 *
 * @param {object} workflow - The workflow object (must have workflow.steps)
 * @param {string} step - The current step name
 */
function resetDownstream(workflow, step) {
  const stepsToUse = getSteps(workflow);
  const idx = stepsToUse.indexOf(step);
  for (let i = idx + 1; i < stepsToUse.length; i++) {
    workflow.steps[stepsToUse[i]] = 'waiting';
  }
}

/**
 * Check if cached workflow data is stale due to a recent retry.
 * Returns true if lastRetryAt exists and is within a reasonable recency window.
 * Used by watcher to decide if status cache should be invalidated.
 *
 * @param {object} workflow - The workflow object
 * @param {string} step - The step name (unused currently, reserved for future)
 * @returns {boolean}
 */
function markStaleAfterRetry(workflow, step) {
  if (!workflow.lastRetryAt) {
    return false;
  }

  const retryTime = Date.parse(workflow.lastRetryAt);
  if (isNaN(retryTime)) {
    return false;
  }

  const elapsed = Date.now() - retryTime;
  // If lastRetryAt is within the staleness threshold, cache is stale
  return elapsed < STALE_THRESHOLD_MS;
}

/**
 * Prepare workflow state for a retry of the given step.
 * Performs all state mutations atomically (write to tmp, then rename).
 *
 * @param {string} flowId - The flow identifier (directory name under OUTPUT_ROOT)
 * @param {string} step - The step to retry (must be in STEPS)
 * @param {object} [opts] - Options
 * @param {boolean} [opts.clearOutput=false] - Whether to unlink the step's output file
 * @param {string} [opts.source='manual'] - Retry source ('manual' resets needsFixCount)
 * @param {string} [opts.prompt] - Optional new prompt to overwrite the workflow's customPrompt
 * @returns {{ workDir: string, member: object, outputFile: string }}
 */
function prepareRetry(flowId, step, { clearOutput = false, source = 'manual', prompt } = {}) {
  // Resolve paths
  const workDir = resolveWorkDir(flowId);
  const workflowPath = path.join(workDir, 'workflow.json');

  // Read workflow
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow not found: ${flowId} (path: ${workflowPath} does not exist)`);
  }

  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const stepsToUse = getSteps(workflow);

  // Validate step
  if (!stepsToUse.includes(step)) {
    throw new Error(`Invalid step: "${step}". Valid steps: ${stepsToUse.join(', ')}`);
  }

  // Update prompt if provided
  if (prompt !== undefined) {
    workflow.customPrompt = prompt;
  }

  // Mutate state
  workflow.steps[step] = 'running';
  resetDownstream(workflow, step);

  // Initialize and reset retries
  workflow.retries = workflow.retries || {};
  workflow.retries[step] = 0;

  // Reset needsFixCount only for manual retries
  if (source === 'manual') {
    workflow.needsFixCount = workflow.needsFixCount || {};
    workflow.needsFixCount[step] = 0;
    if (workflow.needsFixHandled) {
      delete workflow.needsFixHandled[step];
    }
  }

  // Clear blocked state
  delete workflow.blockedStep;
  delete workflow.blockedReason;

  // Set running state
  workflow.status = 'running';
  workflow.currentStep = step;
  workflow.lastRetryAt = new Date().toISOString();

  // Resolve member and output file
  const member = TEAM_CONFIG.members[step];
  const outputFile = path.join(workDir, member.outputs[0]);

  // Clear output of the retried step if requested
  if (clearOutput) {
    if (fs.existsSync(outputFile)) {
      const backupPath = outputFile + '.bak-' + Date.now();
      fs.copyFileSync(outputFile, backupPath);
      fs.unlinkSync(outputFile);
    }
  }

  // Backup and clear downstream step outputs so watcher can re-spawn them
  const idx = stepsToUse.indexOf(step);
  for (let i = idx + 1; i < stepsToUse.length; i++) {
    const downstreamMember = TEAM_CONFIG.members[stepsToUse[i]];
    const downstreamOutput = path.join(workDir, downstreamMember.outputs[0]);
    if (fs.existsSync(downstreamOutput)) {
      const backupPath = downstreamOutput + '.bak-' + Date.now();
      fs.copyFileSync(downstreamOutput, backupPath);
      fs.unlinkSync(downstreamOutput);
    }
  }

  // Atomic write: write to .tmp then rename
  const tmpPath = workflowPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(workflow, null, 2));
  fs.renameSync(tmpPath, workflowPath);

  return { workDir, member, outputFile };
}

module.exports = {
  prepareRetry,
  resetDownstream,
  markStaleAfterRetry
};

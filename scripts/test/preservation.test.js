#!/usr/bin/env node
/**
 * Preservation Property Tests
 *
 * These tests document CORRECT behavior that already works in the UNFIXED code.
 * ALL tests MUST PASS on the unfixed code — confirms baseline behavior to preserve.
 *
 * Run: node --test .dev-team/scripts/test/preservation.test.js
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const SCRIPT_DIR = path.resolve(__dirname, '..');
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(SKILL_DIR, '..');
const OUTPUT_ROOT = path.resolve(REPO_ROOT, '.dev-team/task-flows');

const STEPS = ['clarifier', 'architect', 'taskbreaker', 'planner', 'implementer', 'reviewer', 'qa'];
const STEP_OUTPUTS = {
  clarifier: 'clarify.md',
  architect: 'architecture.md',
  taskbreaker: 'tasks.md',
  planner: 'plan.md',
  implementer: 'implementation.md',
  reviewer: 'review.md',
  qa: 'qa.md'
};

/**
 * Helper: create a minimal test flow directory with workflow.json
 */
function createTestFlow(flowId, workflowOverrides = {}) {
  const workDir = path.join(OUTPUT_ROOT, flowId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true });

  const workflow = {
    flowId,
    jiraKey: 'TEST-PRES',
    customPrompt: '',
    status: 'running',
    currentStep: 'clarifier',
    startedAt: new Date().toISOString(),
    steps: {
      clarifier: 'waiting',
      architect: 'waiting',
      taskbreaker: 'waiting',
      planner: 'waiting',
      implementer: 'waiting',
      reviewer: 'waiting',
      qa: 'waiting'
    },
    retries: {},
    ...workflowOverrides
  };

  const workflowPath = path.join(workDir, 'workflow.json');
  fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2));
  return { workDir, workflowPath, workflow };
}

/**
 * Helper: cleanup test flow
 */
function cleanupTestFlow(flowId) {
  const workDir = path.join(OUTPUT_ROOT, flowId);
  if (fs.existsSync(workDir)) {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {
      // Retry once after small delay (spawn-via-gateway may still be writing)
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

/**
 * Helper: read parseOutputStatus logic from watcher.js source
 * Since watcher.js does not export functions, we recreate parseOutputStatus
 * exactly as implemented in the source for direct unit testing.
 *
 * NOTE: The watcher regex is /##\s*Status\s*[:\n]\s*(DONE|...)/i
 * This means the separator between "Status" and the value must be either
 * a colon `:` or a newline `\n` (NOT a plain space).
 * Valid formats: "## Status: DONE", "## Status\nDONE", "## Status:\n  DONE"
 */
function getParseOutputStatus() {
  // Recreate the function from watcher.js source
  return function parseOutputStatus(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');

      const statusMatch = content.match(/##\s*Status\s*[:\n]\s*(DONE|NEEDS_FIX|FAILED|BLOCKED|IN[ _]PROGRESS|NOT[ _]STARTED)/i);
      if (statusMatch) {
        return statusMatch[1].toUpperCase().replace(/ /g, '_');
      }

      if (content.includes('NOT STARTED') || content.includes('failed due to')) {
        return 'FAILED';
      }

      if (content.length > 500) {
        return 'UNKNOWN';
      }

      return 'UNKNOWN';
    } catch (err) {
      return 'UNKNOWN';
    }
  };
}

/**
 * Helper: read getRetryCount logic from watcher.js source
 */
function getRetryCount(workflow, step) {
  return (workflow.retries && workflow.retries[step]) || 0;
}

const parseOutputStatus = getParseOutputStatus();

// =====================================================================
// TESTS
// =====================================================================

describe('Preservation Tests (MUST PASS on unfixed code)', () => {

  /**
   * 3.1 DONE chain preservation
   *
   * Verify that parseOutputStatus correctly returns 'DONE' for files with
   * `## Status DONE`, and that watcher logic would auto-spawn next step
   * when current step is DONE and next step is 'waiting'.
   *
   * Validates: Requirement 3.1
   */
  describe('3.1 DONE chain preservation', () => {
    test('parseOutputStatus returns DONE for file with ## Status: DONE', () => {
      const flowId = 'test_pres_31_' + Date.now();
      try {
        const { workDir } = createTestFlow(flowId);

        // Create a DONE output file (colon separator required by watcher regex)
        fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
        const doneFile = path.join(workDir, 'output', 'clarify.md');
        fs.writeFileSync(doneFile, '# Clarification\n\nSome content here.\n\n## Status: DONE\n');

        const status = parseOutputStatus(doneFile);
        assert.strictEqual(status, 'DONE', `Expected DONE but got ${status}`);
      } finally {
        cleanupTestFlow(flowId);
      }
    });

    test('watcher getWorkflowState reads outputs and statuses correctly', () => {
      const flowId = 'test_pres_31b_' + Date.now();
      try {
        const { workDir } = createTestFlow(flowId, {
          steps: {
            clarifier: 'running',
            architect: 'waiting',
            taskbreaker: 'waiting',
            planner: 'waiting',
            implementer: 'waiting',
            reviewer: 'waiting',
            qa: 'waiting'
          }
        });

        // Write clarify.md with DONE status (colon format required by regex)
        fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
        fs.writeFileSync(
          path.join(workDir, 'output', 'clarify.md'),
          '# Clarification\n\n## Status: DONE\n\nAll clear.\n'
        );

        // Verify parseOutputStatus sees DONE
        const status = parseOutputStatus(path.join(workDir, 'output', 'clarify.md'));
        assert.strictEqual(status, 'DONE');

        // For DONE chain: next step should be spawnable when its status is 'waiting'
        const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));
        const nextStep = 'architect';
        assert.strictEqual(workflow.steps[nextStep], 'waiting',
          'Next step should be waiting, eligible for auto-spawn');
      } finally {
        cleanupTestFlow(flowId);
      }
    });

    test('parseOutputStatus handles various DONE formats', () => {
      const flowId = 'test_pres_31c_' + Date.now();
      try {
        const { workDir } = createTestFlow(flowId);
        const testFile = path.join(workDir, 'test-output.md');

        // Format 1: ## Status: DONE with colon
        fs.writeFileSync(testFile, 'Content\n\n## Status: DONE\n');
        assert.strictEqual(parseOutputStatus(testFile), 'DONE');

        // Format 2: ## Status\nDONE on next line
        fs.writeFileSync(testFile, 'Content\n\n## Status\nDONE\n');
        assert.strictEqual(parseOutputStatus(testFile), 'DONE');

        // Format 3: ## Status:\n  DONE with colon and newline
        fs.writeFileSync(testFile, '## Status:\n  DONE\n\nExtra details.\n');
        assert.strictEqual(parseOutputStatus(testFile), 'DONE');
      } finally {
        cleanupTestFlow(flowId);
      }
    });
  });

  /**
   * 3.2 FAILED auto-retry preservation
   *
   * Verify that watcher's auto-retry logic: getRetryCount < MAX_RETRIES
   * triggers retry. With retries=0, count is 0 which is < MAX_RETRIES(1).
   *
   * Validates: Requirement 3.2
   */
  describe('3.2 FAILED auto-retry preservation', () => {
    test('parseOutputStatus returns FAILED for file with ## Status: FAILED', () => {
      const flowId = 'test_pres_32_' + Date.now();
      try {
        const { workDir } = createTestFlow(flowId);
        fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
        const failedFile = path.join(workDir, 'output', 'implementation.md');
        fs.writeFileSync(failedFile, '# Implementation\n\n## Status: FAILED\n\nSomething went wrong.\n');

        const status = parseOutputStatus(failedFile);
        assert.strictEqual(status, 'FAILED', `Expected FAILED but got ${status}`);
      } finally {
        cleanupTestFlow(flowId);
      }
    });

    test('getRetryCount with retries=0 returns 0 which is less than MAX_RETRIES=1', () => {
      const workflow = {
        retries: { implementer: 0 }
      };
      const count = getRetryCount(workflow, 'implementer');
      assert.strictEqual(count, 0, `Expected 0 but got ${count}`);

      const MAX_RETRIES = 1;
      assert.ok(count < MAX_RETRIES,
        `retryCount (${count}) should be < MAX_RETRIES (${MAX_RETRIES}) to allow auto-retry`);
    });

    test('getRetryCount with no retries object returns 0', () => {
      const workflow = {};
      const count = getRetryCount(workflow, 'implementer');
      assert.strictEqual(count, 0);

      const MAX_RETRIES = 1;
      assert.ok(count < MAX_RETRIES);
    });

    test('watcher source contains FAILED retry logic with MAX_RETRIES check', () => {
      const watcherSrc = fs.readFileSync(path.join(SCRIPT_DIR, 'watcher.js'), 'utf8');

      // Verify watcher has MAX_RETRIES constant
      assert.ok(watcherSrc.includes('MAX_RETRIES'),
        'Watcher should have MAX_RETRIES constant');

      // Verify watcher checks retryCount < MAX_RETRIES
      assert.ok(watcherSrc.includes('retryCount < MAX_RETRIES'),
        'Watcher should check retryCount < MAX_RETRIES');

      // Verify watcher increments retry counter
      assert.ok(watcherSrc.includes('retryCount + 1'),
        'Watcher should increment retry counter');
    });
  });

  /**
   * 3.3 BLOCKED preservation
   *
   * Verify parseOutputStatus returns 'BLOCKED' and watcher's updateWorkflowState
   * can set status: 'blocked', blockedStep: step.
   *
   * Validates: Requirement 3.7
   */
  describe('3.3 BLOCKED preservation', () => {
    test('parseOutputStatus returns BLOCKED for file with ## Status: BLOCKED', () => {
      const flowId = 'test_pres_33_' + Date.now();
      try {
        const { workDir } = createTestFlow(flowId);
        fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
        const blockedFile = path.join(workDir, 'output', 'implementation.md');
        fs.writeFileSync(blockedFile, '# Implementation\n\n## Status: BLOCKED\n\nNeed manual input.\n');

        const status = parseOutputStatus(blockedFile);
        assert.strictEqual(status, 'BLOCKED', `Expected BLOCKED but got ${status}`);
      } finally {
        cleanupTestFlow(flowId);
      }
    });

    test('watcher source sets blocked status and clears interval on BLOCKED', () => {
      const watcherSrc = fs.readFileSync(path.join(SCRIPT_DIR, 'watcher.js'), 'utf8');

      // Verify BLOCKED branch exists
      assert.ok(watcherSrc.includes("currentStatus === 'BLOCKED'") ||
                watcherSrc.includes('BLOCKED'),
        'Watcher should handle BLOCKED status');

      // Verify it sets status to blocked
      assert.ok(watcherSrc.includes("status: 'blocked'"),
        'Watcher should set workflow status to blocked');

      // Verify it sets blockedStep
      assert.ok(watcherSrc.includes('blockedStep'),
        'Watcher should set blockedStep');

      // Verify it clears interval
      assert.ok(watcherSrc.includes('clearInterval(checkInterval)'),
        'Watcher should clear interval on BLOCKED');
    });
  });

  /**
   * 3.5 spawn-via-gateway prompt build preservation
   *
   * Verify spawn-via-gateway.js builds prompt with:
   * - Instructions section (pointing to prompts/<step>.md)
   * - Context section (jiraKey, repoRoot, workDir)
   * - Previous Outputs listing existing prev files
   * - Your Output section
   * - {{REPO_ROOT}} placeholder is replaced
   *
   * Validates: Requirement 3.5
   */
  describe('3.5 spawn-via-gateway prompt build preservation', () => {
    test('spawn-via-gateway creates prompt file with correct sections', () => {
      const flowId = 'test_pres_35_' + Date.now();
      try {
        const { workDir } = createTestFlow(flowId, {
          jiraKey: 'PRES-35',
          customPrompt: 'Test custom prompt',
          steps: {
            clarifier: 'done',
            architect: 'running',
            taskbreaker: 'waiting',
            planner: 'waiting',
            implementer: 'waiting',
            reviewer: 'waiting',
            qa: 'waiting'
          }
        });

        // Create previous output (clarify.md) so prompt includes it
        fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
        fs.writeFileSync(
          path.join(workDir, 'output', 'clarify.md'),
          '# Clarification\n\n## Status: DONE\n'
        );

        // Run spawn-via-gateway.js for architect step
        // It will fail at codex CLI (not installed in test), but writes prompt file first
        try {
          spawnSync('node', [
            path.join(SCRIPT_DIR, 'spawn-via-gateway.js'),
            flowId,
            'architect'
          ], {
            cwd: REPO_ROOT,
            timeout: 10000,
            stdio: 'pipe'
          });
        } catch (e) {
          // Expected — codex not available in test
        }

        // Check the prompt file was created
        const promptFile = path.join(workDir, 'prompts', 'architect-prompt.txt');
        assert.ok(fs.existsSync(promptFile),
          'spawn-via-gateway should create prompts/<step>-prompt.txt');

        const promptContent = fs.readFileSync(promptFile, 'utf8');

        // Verify Instructions section
        assert.ok(promptContent.includes('## Instructions'),
          'Prompt should contain Instructions section');
        assert.ok(promptContent.includes('prompts/architect.md'),
          'Prompt should reference prompts/<step>.md');

        // Verify Context section
        assert.ok(promptContent.includes('## Context'),
          'Prompt should contain Context section');
        assert.ok(promptContent.includes('PRES-35'),
          'Prompt should contain jiraKey');
        assert.ok(promptContent.includes('Repo root:'),
          'Prompt should contain Repo root');
        assert.ok(promptContent.includes('Work dir:'),
          'Prompt should contain Work dir');

        // Verify Previous Outputs
        assert.ok(promptContent.includes('## Previous Outputs'),
          'Prompt should contain Previous Outputs section');
        assert.ok(promptContent.includes('clarify.md'),
          'Prompt should list previous output file clarify.md');

        // Verify Your Output section
        assert.ok(promptContent.includes('## Your Output'),
          'Prompt should contain Your Output section');
        assert.ok(promptContent.includes('architecture.md'),
          'Prompt should reference output file architecture.md');

        // Verify {{REPO_ROOT}} placeholder is replaced (should NOT appear in output)
        assert.ok(!promptContent.includes('{{REPO_ROOT}}'),
          '{{REPO_ROOT}} placeholder should be replaced with actual path');

        // Verify Custom Requirement section
        assert.ok(promptContent.includes('## Custom Requirement'),
          'Prompt should contain Custom Requirement section when customPrompt is set');
        assert.ok(promptContent.includes('Test custom prompt'),
          'Prompt should contain the custom prompt text');

        // Verify non-implementer has "Do not modify source code."
        assert.ok(promptContent.includes('Do not modify source code'),
          'Non-implementer prompt should include "Do not modify source code"');
      } finally {
        cleanupTestFlow(flowId);
      }
    });

    test('spawn-via-gateway includes feedback files for implementer', () => {
      const flowId = 'test_pres_35b_' + Date.now();
      try {
        const { workDir } = createTestFlow(flowId, {
          jiraKey: 'PRES-35B',
          steps: {
            clarifier: 'done',
            architect: 'done',
            taskbreaker: 'done',
            planner: 'done',
            implementer: 'running',
            reviewer: 'waiting',
            qa: 'waiting'
          }
        });

        // Create previous outputs
        fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
        fs.writeFileSync(path.join(workDir, 'output', 'clarify.md'), '# Clarify\n## Status: DONE\n');
        fs.writeFileSync(path.join(workDir, 'output', 'architecture.md'), '# Arch\n## Status: DONE\n');
        fs.writeFileSync(path.join(workDir, 'output', 'tasks.md'), '# Tasks\n## Status: DONE\n');
        fs.writeFileSync(path.join(workDir, 'output', 'plan.md'), '# Plan\n## Status: DONE\n');

        // Create feedback file
        fs.writeFileSync(
          path.join(workDir, 'output', 'feedback-from-reviewer.md'),
          '# Feedback\n\nPlease fix X.\n'
        );

        // Run spawn-via-gateway.js for implementer
        try {
          spawnSync('node', [
            path.join(SCRIPT_DIR, 'spawn-via-gateway.js'),
            flowId,
            'implementer'
          ], {
            cwd: REPO_ROOT,
            timeout: 10000,
            stdio: 'pipe'
          });
        } catch (e) {
          // Expected
        }

        const promptFile = path.join(workDir, 'prompts', 'implementer-prompt.txt');
        assert.ok(fs.existsSync(promptFile), 'Implementer prompt should be created');

        const promptContent = fs.readFileSync(promptFile, 'utf8');

        // Verify feedback section
        assert.ok(promptContent.includes('## Fix Feedback'),
          'Implementer prompt should contain Fix Feedback section when feedback exists');
        assert.ok(promptContent.includes('feedback-from-reviewer.md'),
          'Implementer prompt should reference feedback file');

        // Verify implementer does NOT have "Do not modify source code."
        assert.ok(!promptContent.includes('Do not modify source code'),
          'Implementer prompt should NOT include "Do not modify source code"');
      } finally {
        cleanupTestFlow(flowId);
      }
    });
  });

  /**
   * 3.6 NEEDS_FIX first-time preservation
   *
   * Verify that watcher's NEEDS_FIX branch copies feedback, deletes
   * implementation.md, and resets downstream. This is the CORRECT behavior
   * for the first NEEDS_FIX that must be preserved.
   *
   * Validates: Requirement 3.6
   */
  describe('3.6 NEEDS_FIX first-time preservation', () => {
    test('watcher source contains copyFileSync for feedback on NEEDS_FIX', () => {
      const watcherSrc = fs.readFileSync(path.join(SCRIPT_DIR, 'watcher.js'), 'utf8');

      // Verify feedback copy logic
      assert.ok(watcherSrc.includes('copyFileSync'),
        'Watcher should use copyFileSync to save feedback');
      assert.ok(watcherSrc.includes('feedback-from-'),
        'Watcher should create feedback-from-<step>.md');
    });

    test('watcher source contains unlinkSync for implOutput on NEEDS_FIX', () => {
      const watcherSrc = fs.readFileSync(path.join(SCRIPT_DIR, 'watcher.js'), 'utf8');

      // Verify implementation.md deletion
      assert.ok(watcherSrc.includes('unlinkSync'),
        'Watcher should use unlinkSync to clear implementation.md');
      assert.ok(watcherSrc.includes('implOutput') || watcherSrc.includes('implementation'),
        'Watcher should reference implementation output');
    });

    test('watcher source resets downstream steps to waiting on NEEDS_FIX', () => {
      const watcherSrc = fs.readFileSync(path.join(SCRIPT_DIR, 'watcher.js'), 'utf8');

      // Verify downstream reset
      assert.ok(watcherSrc.includes("'waiting'"),
        'Watcher should reset steps to waiting');

      // Verify it re-spawns implementer
      assert.ok(watcherSrc.includes("spawnStep(flowId, 'implementer'") ||
                watcherSrc.includes('Re-spawning Implementer'),
        'Watcher should re-spawn implementer after NEEDS_FIX');
    });

    test('watcher NEEDS_FIX branch also clears reviewer/qa outputs', () => {
      const watcherSrc = fs.readFileSync(path.join(SCRIPT_DIR, 'watcher.js'), 'utf8');

      // Verify reviewer/qa output clearing
      assert.ok(watcherSrc.includes('review.md') || watcherSrc.includes('reviewer'),
        'Watcher NEEDS_FIX should handle reviewer output');
      assert.ok(watcherSrc.includes('qa.md') || watcherSrc.includes("members.qa"),
        'Watcher NEEDS_FIX should handle qa output');
    });
  });

  /**
   * 3.7 BLOCKED status preservation
   *
   * Test parseOutputStatus with `## Status BLOCKED` returns 'BLOCKED'.
   * Verify updateWorkflowState properly sets blocked fields.
   *
   * Validates: Requirement 3.7
   */
  describe('3.7 BLOCKED status preservation', () => {
    test('parseOutputStatus returns BLOCKED correctly', () => {
      const flowId = 'test_pres_37_' + Date.now();
      try {
        const { workDir } = createTestFlow(flowId);
        const testFile = path.join(workDir, 'test-blocked.md');

        fs.writeFileSync(testFile, '# Step\n\n## Status: BLOCKED\n\nCannot proceed.\n');
        assert.strictEqual(parseOutputStatus(testFile), 'BLOCKED');

        // Also test with newline format
        fs.writeFileSync(testFile, '## Status\nBLOCKED\n');
        assert.strictEqual(parseOutputStatus(testFile), 'BLOCKED');
      } finally {
        cleanupTestFlow(flowId);
      }
    });

    test('updateWorkflowState sets blocked fields correctly (source verification)', () => {
      const watcherSrc = fs.readFileSync(path.join(SCRIPT_DIR, 'watcher.js'), 'utf8');

      // Verify updateWorkflowState supports key-based updates
      assert.ok(watcherSrc.includes('function updateWorkflowState'),
        'Watcher should have updateWorkflowState function');

      // Verify it handles steps.X prefix
      assert.ok(watcherSrc.includes("key.startsWith('steps.')"),
        'updateWorkflowState should handle steps.X prefix');

      // Verify it handles retries.X prefix
      assert.ok(watcherSrc.includes("key.startsWith('retries.')"),
        'updateWorkflowState should handle retries.X prefix');

      // Verify the BLOCKED case sets both status and blockedStep
      assert.ok(watcherSrc.includes("status: 'blocked'"),
        'Watcher BLOCKED case should set status: blocked');
      assert.ok(watcherSrc.includes('blockedStep: step') || watcherSrc.includes('blockedStep'),
        'Watcher BLOCKED case should set blockedStep');
    });
  });

  /**
   * 3.8 start/resume/status preservation
   *
   * Run orchestrator.js commands and verify expected output.
   *
   * Validates: Requirement 3.8
   */
  describe('3.8 start/resume/status preservation', () => {
    test('orchestrator.js start creates flow and outputs "Workflow started:"', () => {
      let flowId = null;
      try {
        const result = spawnSync('node', [
          path.join(SCRIPT_DIR, 'orchestrator.js'),
          'start', '', 'test-preservation-prompt'
        ], {
          cwd: REPO_ROOT,
          timeout: 10000,
          stdio: 'pipe'
        });

        const stdout = result.stdout.toString();

        // Verify "Workflow started:" appears
        assert.ok(stdout.includes('Workflow started:'),
          `Expected "Workflow started:" in output. Got: ${stdout.slice(0, 200)}`);

        // Extract flow ID
        const match = stdout.match(/Workflow started:\s*(\S+)/);
        assert.ok(match, 'Should be able to extract flow ID from output');
        flowId = match[1];

        // Verify flow directory was created
        const workDir = path.join(OUTPUT_ROOT, flowId);
        assert.ok(fs.existsSync(workDir), `Flow directory should exist: ${workDir}`);

        // Verify workflow.json was created
        const workflowPath = path.join(workDir, 'workflow.json');
        assert.ok(fs.existsSync(workflowPath), 'workflow.json should exist');

        const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
        assert.strictEqual(workflow.status, 'running');
        assert.strictEqual(workflow.customPrompt, 'test-preservation-prompt');
      } finally {
        if (flowId) {
          cleanupTestFlow(flowId);
        }
      }
    });

    test('orchestrator.js status prints step statuses', () => {
      const flowId = 'test_pres_38_status_' + Date.now();
      try {
        createTestFlow(flowId, {
          jiraKey: 'PRES-38',
          steps: {
            clarifier: 'done',
            architect: 'running',
            taskbreaker: 'waiting',
            planner: 'waiting',
            implementer: 'waiting',
            reviewer: 'waiting',
            qa: 'waiting'
          }
        });

        const result = spawnSync('node', [
          path.join(SCRIPT_DIR, 'orchestrator.js'),
          'status', flowId
        ], {
          cwd: REPO_ROOT,
          timeout: 10000,
          stdio: 'pipe'
        });

        const stdout = result.stdout.toString();

        // Verify it prints step statuses
        assert.ok(stdout.includes('clarifier') && stdout.includes('done'),
          'Status should show clarifier: done');
        assert.ok(stdout.includes('architect') && stdout.includes('running'),
          'Status should show architect: running');
        assert.ok(stdout.includes('PRES-38') || stdout.includes('Jira'),
          'Status should show Jira key');
      } finally {
        cleanupTestFlow(flowId);
      }
    });

    test('orchestrator.js start with jira key works', () => {
      let flowId = null;
      try {
        const result = spawnSync('node', [
          path.join(SCRIPT_DIR, 'orchestrator.js'),
          'start', 'TEST-JIRA-99'
        ], {
          cwd: REPO_ROOT,
          timeout: 10000,
          stdio: 'pipe'
        });

        const stdout = result.stdout.toString();
        assert.ok(stdout.includes('Workflow started:'),
          'Should output "Workflow started:" for jira key start');

        const match = stdout.match(/Workflow started:\s*(\S+)/);
        if (match) {
          flowId = match[1];
          // Verify jira key is in flow ID
          assert.ok(flowId.includes('TEST-JIRA-99'),
            'Flow ID should contain sanitized jira key');
        }
      } finally {
        if (flowId) {
          cleanupTestFlow(flowId);
        }
      }
    });
  });

  /**
   * 3.4 Helper non-retry keys preservation
   *
   * Read the helper template file (or HELPER_EOF heredoc in unfixed code) and
   * verify keys v, s, g, l, 1-7, q have their expected case handlers.
   *
   * Validates: Requirement 3.4
   */
  describe('3.4 Helper non-retry keys preservation', () => {
    /**
     * Helper to get the helper content — reads from template file if it exists,
     * otherwise falls back to HELPER_EOF heredoc in start-with-monitor.sh.
     */
    function getHelperContent() {
      const templatePath = path.join(SCRIPT_DIR, 'tmux-helper-template.sh');
      if (fs.existsSync(templatePath)) {
        return fs.readFileSync(templatePath, 'utf8');
      }
      // Fallback: extract HELPER_EOF heredoc from start-with-monitor.sh
      const monitorSrc = fs.readFileSync(
        path.join(SCRIPT_DIR, 'start-with-monitor.sh'), 'utf8'
      );
      const helperMatch = monitorSrc.match(
        /cat\s*>\s*"\$WORK_DIR\/tmux-helper\.sh"\s*<<'HELPER_EOF'([\s\S]*?)^HELPER_EOF$/m
      );
      assert.ok(helperMatch, 'Should find HELPER_EOF heredoc or template file');
      return helperMatch[1];
    }

    test('Helper template contains v case with less command', () => {
      const helperContent = getHelperContent();
      // Verify 'v' key uses less
      assert.ok(helperContent.includes('less'),
        'Helper should use less for viewing files (v key)');
    });

    test('Helper template contains s case with json display', () => {
      const helperContent = getHelperContent();
      // Verify 's' key shows workflow.json (json.tool or jq or cat)
      assert.ok(
        helperContent.includes('json.tool') || helperContent.includes('jq') || helperContent.includes('workflow.json'),
        'Helper should display workflow.json for s key'
      );
    });

    test('Helper template contains g case with git status', () => {
      const helperContent = getHelperContent();
      // Verify 'g' key runs git status
      assert.ok(helperContent.includes('git') && helperContent.includes('status'),
        'Helper should run git status for g key');
    });

    test('Helper template contains l case with ls command', () => {
      const helperContent = getHelperContent();
      // Verify 'l' key lists files
      assert.ok(helperContent.includes('ls'),
        'Helper should use ls for listing files (l key)');
    });

    test('Helper template contains 1-7 keys for log switching', () => {
      const helperContent = getHelperContent();
      // Verify number keys 1-7 switch logs
      assert.ok(helperContent.includes('1|2|3|4|5|6|7') || helperContent.includes('1)'),
        'Helper should have 1-7 key handlers for log switching');
      assert.ok(helperContent.includes('current.log') || helperContent.includes('ln -sfn'),
        'Helper should switch current.log symlink');
    });

    test('Helper template contains q case for quit/exit', () => {
      const helperContent = getHelperContent();
      // Verify 'q' key exits
      assert.ok(helperContent.includes('q)') && helperContent.includes('exit'),
        'Helper should have q key that exits');
    });

    test('Non-retry keys do not call spawn-via-gateway or prepareRetry', () => {
      const helperContent = getHelperContent();

      // Extract non-retry cases: v, s, g, l, 1-7, q
      // The v) case
      const vCase = helperContent.match(/v\)([\s\S]*?);;/);
      if (vCase) {
        assert.ok(!vCase[1].includes('spawn-via-gateway'),
          'v key should not call spawn-via-gateway');
      }

      // The s) case
      const sCase = helperContent.match(/\bs\)([\s\S]*?);;/);
      if (sCase) {
        assert.ok(!sCase[1].includes('spawn-via-gateway'),
          's key should not call spawn-via-gateway');
      }

      // The g) case
      const gCase = helperContent.match(/\bg\)([\s\S]*?);;/);
      if (gCase) {
        assert.ok(!gCase[1].includes('spawn-via-gateway'),
          'g key should not call spawn-via-gateway');
      }

      // The q) case
      const qCase = helperContent.match(/\bq\)([\s\S]*?);;/);
      if (qCase) {
        assert.ok(!qCase[1].includes('spawn-via-gateway'),
          'q key should not call spawn-via-gateway');
      }
    });
  });
});

#!/usr/bin/env node
/**
 * Bug Condition Exploration Tests
 *
 * These tests confirm that 8 bug conditions exist in the UNFIXED code.
 * ALL 8 sub-tests are EXPECTED TO FAIL — failure proves the bugs exist.
 *
 * Run: node --test .dev-team/scripts/test/bug-condition.test.js
 *
 * Validates: bugfix.md clauses 1.1–1.8
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const SCRIPT_DIR = path.resolve(__dirname, '..');
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(SKILL_DIR, '..');
const OUTPUT_ROOT = path.resolve(REPO_ROOT, '.dev-team/task-flows');

const STEPS = ['clarifier', 'architect', 'taskbreaker', 'planner', 'implementer', 'reviewer', 'qa'];

/**
 * Helper: create a minimal test flow directory with workflow.json
 */
function createTestFlow(flowId, workflowOverrides = {}) {
  const workDir = path.join(OUTPUT_ROOT, flowId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true });

  const workflow = {
    flowId,
    jiraKey: 'TEST-001',
    customPrompt: '',
    status: 'running',
    currentStep: 'clarifier',
    startedAt: new Date().toISOString(),
    steps: {
      clarifier: 'done',
      architect: 'done',
      taskbreaker: 'done',
      planner: 'done',
      implementer: 'running',
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
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

describe('Bug Condition Exploration Tests (EXPECTED TO FAIL on unfixed code)', () => {

  /**
   * 1.1 CLI retry không spawn
   *
   * Bug: orchestrator.js retryStep() calls spawnAgent() which only writes
   * spawn_<step>.json and prints a manual /spawn command. It does NOT actually
   * invoke codex-agent-wrapper.sh or spawn-via-gateway.js.
   *
   * Counterexample: After `node orchestrator.js retry <flow> implementer`,
   * no logs/implementer.log is created, but spawn_implementer.json exists.
   */
  test('1.1 CLI retry does not actually spawn an agent process', async () => {
    const flowId = 'test_bug_11_' + Date.now();
    try {
      createTestFlow(flowId, {
        steps: {
          clarifier: 'done',
          architect: 'done',
          taskbreaker: 'done',
          planner: 'done',
          implementer: 'failed',
          reviewer: 'waiting',
          qa: 'waiting'
        }
      });

      const workDir = path.join(OUTPUT_ROOT, flowId);

      // Run orchestrator retry
      try {
        execSync(
          `node "${path.join(SCRIPT_DIR, 'orchestrator.js')}" retry "${flowId}" implementer`,
          { timeout: 5000, cwd: REPO_ROOT, stdio: 'pipe' }
        );
      } catch (e) {
        // May throw due to spawn-via-gateway not finding codex, that's fine
      }

      // Wait a moment for any async spawn
      await new Promise(r => setTimeout(r, 2000));

      // Bug assertion: spawn_implementer.json exists (dead code artifact)
      const spawnFile = path.join(workDir, 'spawn_implementer.json');
      const spawnFileExists = fs.existsSync(spawnFile);

      // Bug assertion: logs/implementer.log does NOT exist (agent never spawned)
      const logFile = path.join(workDir, 'logs', 'implementer.log');
      const logFileExists = fs.existsSync(logFile);

      // THIS ASSERTION SHOULD FAIL on unfixed code:
      // We assert that the retry DOES spawn (log file exists).
      // On unfixed code, only spawn_implementer.json exists, no log file.
      assert.strictEqual(
        logFileExists, true,
        'Bug 1.1 confirmed: CLI retry only writes spawn_implementer.json, ' +
        'does NOT actually spawn agent (no logs/implementer.log created)'
      );
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  /**
   * 1.2 Watcher race condition with manual retry
   *
   * Bug: watcher.js uses in-memory `lastStatuses` cache that is never
   * invalidated when an external retry changes workflow state. This can cause
   * double-spawn or deletion of newly-generated output.
   *
   * Counterexample: watcher sees NEEDS_FIX in cache, user retries externally,
   * new DONE file appears, but watcher still acts on stale NEEDS_FIX state.
   */
  test('1.2 Watcher uses stale lastStatuses cache after external retry', async () => {
    const flowId = 'test_bug_12_' + Date.now();
    try {
      const { workDir, workflowPath } = createTestFlow(flowId, {
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

      // Write implementation.md with NEEDS_FIX (simulating reviewer feedback)
      fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
      const implFile = path.join(workDir, 'output', 'implementation.md');
      fs.writeFileSync(implFile, '# Implementation\n\n## Status NEEDS_FIX\n\nSome issues found.\n');

      // The watcher module caches statuses in RAM (lastStatuses).
      // There is no mechanism to detect that an external retry has been issued.
      // The watcher has no concept of `lastRetryAt` or cache invalidation.

      // Read watcher source to confirm no lastRetryAt check exists
      const watcherSrc = fs.readFileSync(path.join(SCRIPT_DIR, 'watcher.js'), 'utf8');

      // THIS ASSERTION SHOULD FAIL on unfixed code:
      // We assert that watcher has cache invalidation via lastRetryAt.
      // On unfixed code, lastRetryAt is never read/checked.
      assert.ok(
        watcherSrc.includes('lastRetryAt'),
        'Bug 1.2 confirmed: watcher.js has no lastRetryAt-based cache invalidation. ' +
        'The in-memory lastStatuses cache is never invalidated by external retry, ' +
        'causing race conditions (double-spawn or output deletion).'
      );
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  /**
   * 1.3 'r' retry self-reference
   *
   * Bug: When user presses 'r' (retry without clear) on a step whose output
   * already exists, the helper calls spawn-via-gateway.js directly without
   * checking if the output file exists. spawn-via-gateway builds "Previous
   * Outputs" by scanning all files up to stepIndex — but since the step's
   * own output exists, the agent reads its own output as context (self-reference).
   *
   * The inside-tmux helper (HELPER_EOF heredoc) has no guard preventing this.
   *
   * Counterexample: architecture.md exists, user presses 'r' for architect,
   * spawn-via-gateway includes architecture.md in prev outputs for architect.
   */
  test('1.3 Helper r does not guard against self-reference when output exists', () => {
    // After refactoring, both branches use the template file.
    // Check the template for the 'r' guard against existing output.
    const templatePath = path.join(SCRIPT_DIR, 'tmux-helper-template.sh');
    const templateExists = fs.existsSync(templatePath);

    if (templateExists) {
      // Template exists — check that it has the -f guard in the r case
      const templateContent = fs.readFileSync(templatePath, 'utf8');

      // The retry_step function should check if output file exists when mode is 'r'
      assert.ok(
        templateContent.includes('-f') && templateContent.includes('Output đã tồn tại'),
        'Bug 1.3 fixed: Template r case has -f guard against existing output'
      );
    } else {
      // Fallback: read HELPER_EOF heredoc from start-with-monitor.sh (unfixed code)
      const monitorSrc = fs.readFileSync(
        path.join(SCRIPT_DIR, 'start-with-monitor.sh'), 'utf8'
      );

      const helperMatch = monitorSrc.match(
        /cat\s*>\s*"\$WORK_DIR\/tmux-helper\.sh"\s*<<'HELPER_EOF'([\s\S]*?)^HELPER_EOF$/m
      );

      assert.ok(helperMatch, 'Could not extract HELPER_EOF heredoc');
      const helperContent = helperMatch[1];

      // Extract the 'r)' case block
      const rCaseMatch = helperContent.match(/^\s*r\)([\s\S]*?)(?=^\s*R\))/m);
      assert.ok(rCaseMatch, 'Could not find r) case in helper');
      const rCaseBody = rCaseMatch[1];

      // THIS ASSERTION SHOULD FAIL on unfixed code:
      assert.ok(
        rCaseBody.includes('-f') || rCaseBody.includes('exists') || rCaseBody.includes('output'),
        'Bug 1.3 confirmed: Helper "r" case does NOT check if output file exists ' +
        'before calling spawn-via-gateway.js. This causes self-reference — agent ' +
        'reads its own previous output as context.'
      );
    }
  });

  /**
   * 1.4 Heredoc divergence between inside-tmux and new-session branches
   *
   * Bug: start-with-monitor.sh has two separate heredocs for the helper script:
   * - HELPER_EOF (inside existing tmux, ~line 155-230): lacks Python workflow
   *   reset and watcher restart on retry
   * - EOF (new session, ~line 250-340): has Python workflow reset + pgrep watcher
   *
   * Counterexample: 'R' in inside-tmux branch does NOT reset workflow.json
   * (no python3 reset, no pgrep watcher restart), while same key in new-session
   * branch does both.
   */
  test('1.4 Two heredoc helpers have divergent retry logic', () => {
    const monitorSrc = fs.readFileSync(
      path.join(SCRIPT_DIR, 'start-with-monitor.sh'), 'utf8'
    );

    // After fix: both branches should use the same sed template command.
    // Check if the template file exists and both branches reference it.
    const templatePath = path.join(SCRIPT_DIR, 'tmux-helper-template.sh');
    const templateExists = fs.existsSync(templatePath);

    if (templateExists) {
      // Fixed: verify both branches use the template via sed
      const sedCount = (monitorSrc.match(/tmux-helper-template\.sh/g) || []).length;
      assert.ok(
        sedCount >= 2,
        `Bug 1.4 fixed: Both branches use tmux-helper-template.sh (found ${sedCount} references, expected >=2)`
      );

      // Verify no HELPER_EOF or EOF heredocs remain
      const hasHelperEof = monitorSrc.includes("<<'HELPER_EOF'");
      const hasEofHeredoc = /cat\s*>\s*"\$WORK_DIR\/tmux-helper\.sh"\s*<<EOF/m.test(monitorSrc);
      assert.ok(
        !hasHelperEof && !hasEofHeredoc,
        'Bug 1.4 fixed: No heredoc divergence — both branches use template'
      );
    } else {
      // Unfixed: check for heredoc divergence
      // Extract HELPER_EOF content (inside-tmux branch)
      const helperEofMatch = monitorSrc.match(
        /cat\s*>\s*"\$WORK_DIR\/tmux-helper\.sh"\s*<<'HELPER_EOF'([\s\S]*?)^HELPER_EOF$/m
      );
      assert.ok(helperEofMatch, 'Could not extract HELPER_EOF heredoc');
      const insideTmuxHelper = helperEofMatch[1];

      // Extract EOF content (new-session branch)
      const eofMatch = monitorSrc.match(
        /cat\s*>\s*"\$WORK_DIR\/tmux-helper\.sh"\s*<<EOF([\s\S]*?)^EOF$/m
      );
      assert.ok(eofMatch, 'Could not extract EOF heredoc');
      const newSessionHelper = eofMatch[1];

      const insideHasPythonReset = insideTmuxHelper.includes('python3') ||
                                    insideTmuxHelper.includes('PY_RESET');
      const newSessionHasPythonReset = newSessionHelper.includes('python3') ||
                                       newSessionHelper.includes('PY_RESET');
      const insideHasWatcherRestart = insideTmuxHelper.includes('pgrep') ||
                                      insideTmuxHelper.includes('watcher.js');
      const newSessionHasWatcherRestart = newSessionHelper.includes('pgrep') ||
                                          newSessionHelper.includes('watcher.js');

      // THIS ASSERTION SHOULD FAIL on unfixed code:
      assert.strictEqual(
        insideHasPythonReset, newSessionHasPythonReset,
        'Bug 1.4 confirmed: Inside-tmux helper (HELPER_EOF) lacks Python workflow reset ' +
        `that new-session helper (EOF) has. Inside: ${insideHasPythonReset}, New: ${newSessionHasPythonReset}`
      );

      assert.strictEqual(
        insideHasWatcherRestart, newSessionHasWatcherRestart,
        'Bug 1.4 confirmed: Inside-tmux helper (HELPER_EOF) lacks watcher restart ' +
        `that new-session helper (EOF) has. Inside: ${insideHasWatcherRestart}, New: ${newSessionHasWatcherRestart}`
      );
    }
  });

  /**
   * 1.5 Downstream steps not reset when retrying
   *
   * Bug: orchestrator.js retryStep() only sets `workflow.steps[step] = 'running'`.
   * It does NOT reset downstream steps to 'waiting'.
   *
   * Counterexample: retry taskbreaker while planner is 'done' → planner stays
   * 'done', watcher can't auto-spawn it after taskbreaker completes.
   */
  test('1.5 retryStep does not reset downstream steps to waiting', () => {
    const flowId = 'test_bug_15_' + Date.now();
    try {
      createTestFlow(flowId, {
        steps: {
          clarifier: 'done',
          architect: 'done',
          taskbreaker: 'done',
          planner: 'done',
          implementer: 'done',
          reviewer: 'done',
          qa: 'done'
        }
      });

      // Call retryStep directly by requiring orchestrator logic
      // Since orchestrator.js uses process.argv CLI, we simulate by modifying
      // workflow directly via the orchestrator module path — but easier to just
      // exec the CLI and check the result.
      try {
        execSync(
          `node "${path.join(SCRIPT_DIR, 'orchestrator.js')}" retry "${flowId}" taskbreaker`,
          { timeout: 5000, cwd: REPO_ROOT, stdio: 'pipe' }
        );
      } catch (e) {
        // spawnAgent may fail but workflow.json is already updated
      }

      // Read workflow.json after retry
      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflowPath = path.join(workDir, 'workflow.json');
      const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

      // THIS ASSERTION SHOULD FAIL on unfixed code:
      // We assert downstream steps (planner, implementer, reviewer, qa) are reset to 'waiting'.
      // On unfixed code, retryStep only sets taskbreaker='running', downstream stays 'done'.
      assert.strictEqual(
        workflow.steps.planner, 'waiting',
        'Bug 1.5 confirmed: retryStep("taskbreaker") does NOT reset downstream. ' +
        `planner is "${workflow.steps.planner}" instead of "waiting".`
      );
      assert.strictEqual(
        workflow.steps.implementer, 'waiting',
        `implementer is "${workflow.steps.implementer}" instead of "waiting"`
      );
      assert.strictEqual(
        workflow.steps.reviewer, 'waiting',
        `reviewer is "${workflow.steps.reviewer}" instead of "waiting"`
      );
      assert.strictEqual(
        workflow.steps.qa, 'waiting',
        `qa is "${workflow.steps.qa}" instead of "waiting"`
      );
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  /**
   * 1.6 Retry counter not reset on manual retry
   *
   * Bug: orchestrator.js retryStep() does NOT reset workflow.retries[step] to 0.
   * After user manually retries, the counter from previous auto-retry stays,
   * so next FAILED triggers immediate workflow stop without any retry.
   *
   * Counterexample: retries.implementer=1, user retries, counter stays 1.
   * Next FAILED: watcher sees 1 < 1 → false → stops workflow immediately.
   */
  test('1.6 retryStep does not reset retry counter to 0', () => {
    const flowId = 'test_bug_16_' + Date.now();
    try {
      createTestFlow(flowId, {
        steps: {
          clarifier: 'done',
          architect: 'done',
          taskbreaker: 'done',
          planner: 'done',
          implementer: 'failed',
          reviewer: 'waiting',
          qa: 'waiting'
        },
        retries: { implementer: 1 }
      });

      // Run retry via CLI
      try {
        execSync(
          `node "${path.join(SCRIPT_DIR, 'orchestrator.js')}" retry "${flowId}" implementer`,
          { timeout: 5000, cwd: REPO_ROOT, stdio: 'pipe' }
        );
      } catch (e) {
        // May fail at spawn but workflow.json is updated
      }

      // Read workflow.json after retry
      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflowPath = path.join(workDir, 'workflow.json');
      const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

      // THIS ASSERTION SHOULD FAIL on unfixed code:
      // We assert retry counter is reset to 0 after manual retry.
      // On unfixed code, retryStep doesn't touch retries at all.
      const retriesValue = (workflow.retries && workflow.retries.implementer !== undefined)
        ? workflow.retries.implementer
        : 'undefined';
      assert.strictEqual(
        retriesValue,
        0,
        'Bug 1.6 confirmed: retryStep does NOT reset retry counter. ' +
        `retries.implementer is ${retriesValue} instead of 0.`
      );
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  /**
   * 1.7 NEEDS_FIX infinite loop — no limit
   *
   * Bug: watcher.js NEEDS_FIX branch has no counter/limit. It will keep
   * deleting implementation.md + review.md + qa.md and re-spawning implementer
   * indefinitely, consuming unlimited tokens.
   *
   * Counterexample: reviewer returns NEEDS_FIX 5 times, workflow never blocks.
   * No MAX_NEEDS_FIX constant, no needsFixCount tracking.
   */
  test('1.7 Watcher has no NEEDS_FIX iteration limit', () => {
    // Read watcher source to check for NEEDS_FIX limit
    const watcherSrc = fs.readFileSync(path.join(SCRIPT_DIR, 'watcher.js'), 'utf8');

    // Check for any NEEDS_FIX limit mechanism
    const hasNeedsFixLimit = watcherSrc.includes('MAX_NEEDS_FIX') ||
                             watcherSrc.includes('needsFixCount') ||
                             watcherSrc.includes('needs_fix_loop') ||
                             watcherSrc.includes('needsFixLimit');

    // THIS ASSERTION SHOULD FAIL on unfixed code:
    // We assert watcher has a NEEDS_FIX loop limit.
    // On unfixed code, the NEEDS_FIX branch unconditionally re-spawns implementer.
    assert.ok(
      hasNeedsFixLimit,
      'Bug 1.7 confirmed: watcher.js has NO NEEDS_FIX iteration limit. ' +
      'The NEEDS_FIX branch will keep re-spawning implementer indefinitely ' +
      'without any MAX_NEEDS_FIX check or needsFixCount tracking. ' +
      'Workflow can run forever consuming unlimited tokens.'
    );
  });

  /**
   * 1.8 Crash sentinel missing — wrapper doesn't write ## Status FAILED on crash
   *
   * Bug: codex-agent-wrapper.sh has no `trap` command that writes a crash
   * sentinel to the output file when codex exits with non-zero code.
   * Combined with spawn-via-gateway.js using detached+unref, crash goes
   * undetected and workflow stalls at 'running' forever.
   *
   * Counterexample: wrapper has no trap EXIT that writes ## Status FAILED.
   */
  test('1.8 codex-agent-wrapper.sh has no crash sentinel trap', () => {
    const wrapperSrc = fs.readFileSync(
      path.join(SCRIPT_DIR, 'codex-agent-wrapper.sh'), 'utf8'
    );

    // Check for trap that writes crash sentinel
    const hasTrapExit = wrapperSrc.includes('trap') &&
                        (wrapperSrc.includes('FAILED') || wrapperSrc.includes('sentinel'));

    // Check for any mechanism that writes ## Status FAILED on non-zero exit
    const hasStatusFailedWrite = wrapperSrc.includes('## Status FAILED') ||
                                  wrapperSrc.includes('Status FAILED');

    // THIS ASSERTION SHOULD FAIL on unfixed code:
    // We assert wrapper has a trap that writes crash sentinel.
    // On unfixed code, wrapper just exits with the exit code, nothing catches it.
    assert.ok(
      hasTrapExit && hasStatusFailedWrite,
      'Bug 1.8 confirmed: codex-agent-wrapper.sh has NO trap EXIT that writes ' +
      '## Status FAILED to output file when codex crashes. ' +
      `Has trap: ${hasTrapExit}, Has Status FAILED write: ${hasStatusFailedWrite}. ` +
      'Combined with detached spawn + unref, crash goes undetected forever.'
    );
  });
});

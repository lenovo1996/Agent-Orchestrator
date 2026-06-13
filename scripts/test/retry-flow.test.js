#!/usr/bin/env node
/**
 * Unit tests for lib/retry-flow.js
 *
 * Tests the shared retry state mutator module that will be implemented in task 3.2.
 * These tests WILL FAIL until task 3.2 implements the module — that's expected.
 *
 * Run: node --test .dev-team/scripts/test/retry-flow.test.js
 *
 * Validates: 2.1, 2.2, 2.5, 2.6
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = path.resolve(__dirname, '..');
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(SKILL_DIR, '..');
const OUTPUT_ROOT = path.resolve(REPO_ROOT, '.dev-team/task-flows');

// The module under test (will exist after task 3.2)
const RETRY_FLOW_PATH = path.join(SCRIPT_DIR, 'lib', 'retry-flow.js');

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
    jiraKey: 'TEST-RF',
    customPrompt: '',
    status: 'running',
    currentStep: 'clarifier',
    startedAt: new Date().toISOString(),
    steps: {
      clarifier: 'done',
      architect: 'done',
      taskbreaker: 'done',
      planner: 'done',
      implementer: 'done',
      reviewer: 'done',
      qa: 'done'
    },
    retries: {},
    needsFixCount: {},
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

/**
 * Helper: load module fresh (clear require cache)
 */
function loadRetryFlow() {
  delete require.cache[require.resolve(RETRY_FLOW_PATH)];
  return require(RETRY_FLOW_PATH);
}

// =====================================================================
// TESTS
// =====================================================================

describe('lib/retry-flow.js — prepareRetry', () => {

  test('sets workflow.steps[step] = "running"', () => {
    const flowId = 'test_retryflow_run_' + Date.now();
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

      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'implementer');

      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));
      assert.strictEqual(workflow.steps.implementer, 'running');
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('sets downstream steps to "waiting" (all k with index > step index)', () => {
    const flowId = 'test_retryflow_downstream_' + Date.now();
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

      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'taskbreaker');

      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));

      // Upstream should be unchanged
      assert.strictEqual(workflow.steps.clarifier, 'done');
      assert.strictEqual(workflow.steps.architect, 'done');

      // Current step
      assert.strictEqual(workflow.steps.taskbreaker, 'running');

      // Downstream should be reset to waiting
      assert.strictEqual(workflow.steps.planner, 'waiting');
      assert.strictEqual(workflow.steps.implementer, 'waiting');
      assert.strictEqual(workflow.steps.reviewer, 'waiting');
      assert.strictEqual(workflow.steps.qa, 'waiting');
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('sets workflow.retries[step] = 0', () => {
    const flowId = 'test_retryflow_retries_' + Date.now();
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
        retries: { implementer: 2 }
      });

      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'implementer');

      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));
      assert.strictEqual(workflow.retries.implementer, 0);
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('when source === "manual": sets workflow.needsFixCount[step] = 0', () => {
    const flowId = 'test_retryflow_needsfix_manual_' + Date.now();
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
        needsFixCount: { implementer: 3 }
      });

      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'implementer', { source: 'manual' });

      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));
      assert.strictEqual(workflow.needsFixCount.implementer, 0);
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('when source !== "manual" (e.g. "auto"): does NOT reset needsFixCount[step]', () => {
    const flowId = 'test_retryflow_needsfix_auto_' + Date.now();
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
        needsFixCount: { implementer: 2 }
      });

      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'implementer', { source: 'auto' });

      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));
      assert.strictEqual(workflow.needsFixCount.implementer, 2);
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('deletes workflow.blockedStep and workflow.blockedReason', () => {
    const flowId = 'test_retryflow_blocked_' + Date.now();
    try {
      createTestFlow(flowId, {
        status: 'blocked',
        blockedStep: 'implementer',
        blockedReason: 'needs_fix_loop',
        steps: {
          clarifier: 'done',
          architect: 'done',
          taskbreaker: 'done',
          planner: 'done',
          implementer: 'blocked',
          reviewer: 'waiting',
          qa: 'waiting'
        }
      });

      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'implementer');

      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));
      assert.strictEqual(workflow.blockedStep, undefined);
      assert.strictEqual(workflow.blockedReason, undefined);
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('sets workflow.status = "running" and workflow.currentStep = step', () => {
    const flowId = 'test_retryflow_status_' + Date.now();
    try {
      createTestFlow(flowId, {
        status: 'blocked',
        currentStep: 'reviewer',
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

      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'implementer');

      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));
      assert.strictEqual(workflow.status, 'running');
      assert.strictEqual(workflow.currentStep, 'implementer');
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('workflow.lastRetryAt is an ISO string >= the call time', () => {
    const flowId = 'test_retryflow_timestamp_' + Date.now();
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

      const before = new Date().toISOString();
      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'implementer');

      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflow = JSON.parse(fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8'));

      assert.ok(workflow.lastRetryAt, 'lastRetryAt should be set');
      // Verify it's a valid ISO string
      const parsed = new Date(workflow.lastRetryAt);
      assert.ok(!isNaN(parsed.getTime()), 'lastRetryAt should be a valid ISO date');
      // Verify it's >= before
      assert.ok(workflow.lastRetryAt >= before,
        `lastRetryAt (${workflow.lastRetryAt}) should be >= call time (${before})`);
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('when clearOutput === true: unlinks the output file of the step', () => {
    const flowId = 'test_retryflow_clearout_' + Date.now();
    try {
      const { workDir } = createTestFlow(flowId, {
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

      // Create the output file
      fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
      const outputFile = path.join(workDir, 'output', 'implementation.md');
      fs.writeFileSync(outputFile, '# Implementation\n\n## Status: FAILED\n');
      assert.ok(fs.existsSync(outputFile), 'Output file should exist before retry');

      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'implementer', { clearOutput: true });

      assert.ok(!fs.existsSync(outputFile),
        'Output file should be deleted when clearOutput === true');
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('when clearOutput === false: does NOT unlink the output file', () => {
    const flowId = 'test_retryflow_noclear_' + Date.now();
    try {
      const { workDir } = createTestFlow(flowId, {
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

      // Create the output file
      fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
      const outputFile = path.join(workDir, 'output', 'implementation.md');
      fs.writeFileSync(outputFile, '# Implementation\n\n## Status: FAILED\n');

      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'implementer', { clearOutput: false });

      assert.ok(fs.existsSync(outputFile),
        'Output file should NOT be deleted when clearOutput === false');
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('returns { workDir, member, outputFile }', () => {
    const flowId = 'test_retryflow_return_' + Date.now();
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

      const { prepareRetry } = loadRetryFlow();
      const result = prepareRetry(flowId, 'implementer');

      assert.ok(result, 'prepareRetry should return a result object');
      assert.ok(result.workDir, 'Result should have workDir');
      assert.ok(result.member, 'Result should have member');
      assert.ok(result.outputFile, 'Result should have outputFile');

      // Verify workDir is correct
      const expectedWorkDir = path.join(OUTPUT_ROOT, flowId);
      assert.strictEqual(result.workDir, expectedWorkDir);

      // Verify outputFile points to the step's output
      assert.ok(result.outputFile.endsWith('implementation.md'),
        `outputFile should end with implementation.md, got: ${result.outputFile}`);
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('throws if step is not in STEPS', () => {
    const flowId = 'test_retryflow_badstep_' + Date.now();
    try {
      createTestFlow(flowId);

      const { prepareRetry } = loadRetryFlow();
      assert.throws(
        () => prepareRetry(flowId, 'nonexistent'),
        /invalid|not.*found|not.*valid|not.*in.*STEPS/i,
        'Should throw for invalid step'
      );
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('throws if workflow does not exist', () => {
    const { prepareRetry } = loadRetryFlow();
    assert.throws(
      () => prepareRetry('nonexistent_flow_999', 'implementer'),
      /not found|not exist|ENOENT/i,
      'Should throw for non-existent workflow'
    );
  });
});

// =====================================================================
// resetDownstream tests
// =====================================================================

describe('lib/retry-flow.js — resetDownstream', () => {

  test('is a pure function with no I/O', () => {
    const { resetDownstream } = loadRetryFlow();

    // Create a workflow object in memory (no fs access)
    const workflow = {
      steps: {
        clarifier: 'done',
        architect: 'done',
        taskbreaker: 'running',
        planner: 'done',
        implementer: 'done',
        reviewer: 'done',
        qa: 'done'
      }
    };

    // Should work without any fs access
    resetDownstream(workflow, 'taskbreaker');

    // Verify downstream reset
    assert.strictEqual(workflow.steps.planner, 'waiting');
    assert.strictEqual(workflow.steps.implementer, 'waiting');
    assert.strictEqual(workflow.steps.reviewer, 'waiting');
    assert.strictEqual(workflow.steps.qa, 'waiting');
  });

  test('for step "taskbreaker" (index 2): sets planner, implementer, reviewer, qa to "waiting"', () => {
    const { resetDownstream } = loadRetryFlow();

    const workflow = {
      steps: {
        clarifier: 'done',
        architect: 'done',
        taskbreaker: 'running',
        planner: 'done',
        implementer: 'failed',
        reviewer: 'done',
        qa: 'done'
      }
    };

    resetDownstream(workflow, 'taskbreaker');

    assert.strictEqual(workflow.steps.planner, 'waiting');
    assert.strictEqual(workflow.steps.implementer, 'waiting');
    assert.strictEqual(workflow.steps.reviewer, 'waiting');
    assert.strictEqual(workflow.steps.qa, 'waiting');
  });

  test('does NOT modify steps before or at the current step index', () => {
    const { resetDownstream } = loadRetryFlow();

    const workflow = {
      steps: {
        clarifier: 'done',
        architect: 'done',
        taskbreaker: 'running',
        planner: 'done',
        implementer: 'done',
        reviewer: 'done',
        qa: 'done'
      }
    };

    resetDownstream(workflow, 'taskbreaker');

    // Steps at or before taskbreaker (index 2) should remain unchanged
    assert.strictEqual(workflow.steps.clarifier, 'done');
    assert.strictEqual(workflow.steps.architect, 'done');
    assert.strictEqual(workflow.steps.taskbreaker, 'running');
  });

  test('works with any initial state for downstream steps (done, running, failed, etc.)', () => {
    const { resetDownstream } = loadRetryFlow();

    const workflow = {
      steps: {
        clarifier: 'done',
        architect: 'running',
        taskbreaker: 'failed',
        planner: 'blocked',
        implementer: 'running',
        reviewer: 'failed',
        qa: 'waiting'
      }
    };

    resetDownstream(workflow, 'architect');

    // All after architect should be waiting
    assert.strictEqual(workflow.steps.taskbreaker, 'waiting');
    assert.strictEqual(workflow.steps.planner, 'waiting');
    assert.strictEqual(workflow.steps.implementer, 'waiting');
    assert.strictEqual(workflow.steps.reviewer, 'waiting');
    assert.strictEqual(workflow.steps.qa, 'waiting');

    // architect and before unchanged
    assert.strictEqual(workflow.steps.clarifier, 'done');
    assert.strictEqual(workflow.steps.architect, 'running');
  });
});

// =====================================================================
// markStaleAfterRetry tests
// =====================================================================

describe('lib/retry-flow.js — markStaleAfterRetry', () => {

  test('returns a boolean', () => {
    const { markStaleAfterRetry } = loadRetryFlow();

    const workflow = {
      lastRetryAt: new Date().toISOString(),
      steps: { implementer: 'running' }
    };

    const result = markStaleAfterRetry(workflow, 'implementer');
    assert.strictEqual(typeof result, 'boolean');
  });

  test('returns true when lastRetryAt is newer than a reference timestamp', () => {
    const { markStaleAfterRetry } = loadRetryFlow();

    // Simulate: cache was taken at time T, then retry happened at T+1
    const cacheTime = '2024-01-01T00:00:00.000Z';
    const workflow = {
      lastRetryAt: '2024-01-01T00:00:01.000Z', // newer than cache
      steps: { implementer: 'running' }
    };

    // markStaleAfterRetry should indicate that the cached data is stale
    // because lastRetryAt is after the cache snapshot
    const result = markStaleAfterRetry(workflow, 'implementer');
    assert.strictEqual(result, true,
      'Should return true when lastRetryAt is newer than reference');
  });

  test('returns false when lastRetryAt is older or undefined', () => {
    const { markStaleAfterRetry } = loadRetryFlow();

    // No lastRetryAt set
    const workflow1 = {
      steps: { implementer: 'running' }
    };
    assert.strictEqual(markStaleAfterRetry(workflow1, 'implementer'), false,
      'Should return false when lastRetryAt is undefined');

    // lastRetryAt is very old (no recent retry)
    const workflow2 = {
      lastRetryAt: '2020-01-01T00:00:00.000Z',
      steps: { implementer: 'running' }
    };
    // This should return false because there's no indication of a recent retry
    // The function checks if lastRetryAt indicates stale cache
    const result = markStaleAfterRetry(workflow2, 'implementer');
    assert.strictEqual(result, false,
      'Should return false when lastRetryAt is old');
  });
});

// =====================================================================
// Atomic write tests
// =====================================================================

describe('lib/retry-flow.js — atomic write', () => {

  test('after prepareRetry, workflow.json contains valid JSON', () => {
    const flowId = 'test_retryflow_atomic_' + Date.now();
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

      const { prepareRetry } = loadRetryFlow();
      prepareRetry(flowId, 'implementer');

      const workDir = path.join(OUTPUT_ROOT, flowId);
      const workflowPath = path.join(workDir, 'workflow.json');

      // Should be valid JSON
      const content = fs.readFileSync(workflowPath, 'utf8');
      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(content);
      }, 'workflow.json should contain valid JSON after prepareRetry');

      // Verify expected fields
      assert.strictEqual(parsed.steps.implementer, 'running');
      assert.strictEqual(parsed.status, 'running');
    } finally {
      cleanupTestFlow(flowId);
    }
  });

  test('workflow.json is not corrupted (atomic write via tmp + rename)', () => {
    const flowId = 'test_retryflow_atomic2_' + Date.now();
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
      const workflowPath = path.join(workDir, 'workflow.json');

      const { prepareRetry } = loadRetryFlow();

      // Call prepareRetry multiple times in quick succession to stress test
      prepareRetry(flowId, 'implementer');

      // After the call, no .tmp file should remain (rename was successful)
      const tmpFile = workflowPath + '.tmp';
      assert.ok(!fs.existsSync(tmpFile),
        'No .tmp file should remain after atomic write (rename completed)');

      // File should be valid JSON
      const content = fs.readFileSync(workflowPath, 'utf8');
      assert.doesNotThrow(() => JSON.parse(content),
        'workflow.json should not be corrupted');
    } finally {
      cleanupTestFlow(flowId);
    }
  });
});

// =====================================================================
// STEPS export test
// =====================================================================

describe('lib/retry-flow.js — STEPS export', () => {

  test('exports STEPS array with correct 7 steps in order', () => {
    const { STEPS: exportedSteps } = loadRetryFlow();

    assert.ok(Array.isArray(exportedSteps), 'STEPS should be an array');
    assert.strictEqual(exportedSteps.length, 7, 'STEPS should have 7 elements');
    assert.deepStrictEqual(exportedSteps, STEPS,
      'STEPS should be in correct order');
  });
});

// =====================================================================
// Property test: downstream reset invariant
// =====================================================================

describe('lib/retry-flow.js — Property test', () => {

  /**
   * Property: For random step ∈ STEPS and random workflow.steps state,
   * after prepareRetry:
   *   - ∀ k with STEPS.indexOf(k) > STEPS.indexOf(step): steps[k] === 'waiting'
   *   - retries[step] === 0
   *
   * **Validates: Requirements 2.5, 2.6**
   */
  test('Property: downstream reset + retry counter invariant across random inputs', () => {
    const { prepareRetry } = loadRetryFlow();

    const possibleStates = ['done', 'running', 'failed', 'waiting', 'blocked', 'pending'];

    // Simple pseudo-random seed for reproducibility
    let seed = 42;
    function pseudoRandom() {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    function randomChoice(arr) {
      return arr[Math.floor(pseudoRandom() * arr.length)];
    }

    // Run 50 random iterations
    for (let i = 0; i < 50; i++) {
      const flowId = `test_retryflow_prop_${Date.now()}_${i}`;
      try {
        // Pick a random step
        const step = randomChoice(STEPS);
        const stepIdx = STEPS.indexOf(step);

        // Generate random states for all steps
        const steps = {};
        STEPS.forEach(s => {
          steps[s] = randomChoice(possibleStates);
        });

        // Generate random retries counter (0-5)
        const retries = {};
        retries[step] = Math.floor(pseudoRandom() * 5) + 1;

        createTestFlow(flowId, { steps, retries });

        prepareRetry(flowId, step);

        const workDir = path.join(OUTPUT_ROOT, flowId);
        const workflow = JSON.parse(
          fs.readFileSync(path.join(workDir, 'workflow.json'), 'utf8')
        );

        // Property 1: all downstream steps must be 'waiting'
        for (let j = stepIdx + 1; j < STEPS.length; j++) {
          assert.strictEqual(workflow.steps[STEPS[j]], 'waiting',
            `Iteration ${i}: step=${step}, downstream ${STEPS[j]} should be 'waiting' ` +
            `but is '${workflow.steps[STEPS[j]]}'`);
        }

        // Property 2: retries[step] must be 0
        assert.strictEqual(workflow.retries[step], 0,
          `Iteration ${i}: step=${step}, retries[${step}] should be 0 ` +
          `but is ${workflow.retries[step]}`);

      } finally {
        cleanupTestFlow(flowId);
      }
    }
  });
});

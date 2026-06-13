#!/usr/bin/env node
/**
 * Property-Based Tests and Unit Tests for WorktreeManager merge functionality
 *
 * Feature: parallel-worktree-tasks
 * - Property 15: Dry-run merge is side-effect-free
 * - Property 16: Merge updates flow status
 * - Property 17: Merge precondition enforcement
 * - Unit tests for merge edge cases
 *
 * Run: node --test .dev-team/scripts/test/merge.test.js
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const { WorktreeManager } = require('../../worktree/worktree-manager');
const { GitMock } = require('../helpers/git-mock');

// ============================================================================
// Property 15: Dry-run merge is side-effect-free
// ============================================================================

describe('Feature: parallel-worktree-tasks, Property 15: Dry-run merge is side-effect-free', () => {
  let mock;
  let originalExistsSync;
  let originalMkdirSync;

  beforeEach(() => {
    mock = new GitMock();
    originalExistsSync = fs.existsSync;
    originalMkdirSync = fs.mkdirSync;
    fs.existsSync = () => true;
    fs.mkdirSync = () => undefined;
  });

  afterEach(() => {
    mock.restore();
    fs.existsSync = originalExistsSync;
    fs.mkdirSync = originalMkdirSync;
  });

  /**
   * **Validates: Requirements 8.3**
   *
   * For any flowId with status 'done', calling merge(flowId, target, true)
   * should NOT call `git checkout` or `git merge`, and status should remain 'done'.
   * Only `git log {target}..{branch} --oneline` is allowed during dry-run.
   */
  test('dry-run does not call git checkout or git merge, and status remains done', () => {
    const flowIdArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/);
    const stepArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,9}$/);
    const targetBranchArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_/-]{0,15}$/);

    fc.assert(
      fc.property(flowIdArb, stepArb, targetBranchArb, (flowId, step, targetBranch) => {
        // Reset mock for each iteration
        mock.restore();
        mock = new GitMock();
        mock
          .register('git status --porcelain', () => '')
          .register('git worktree add', () => '')
          .register('git log', () => 'abc1234 commit 1\ndef5678 commit 2')
          .install();

        const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

        // Create a worktree and set status to 'done'
        const result = manager.create(flowId, step, '/repo', 'main');
        if (!result || !result.path) return true; // skip if creation failed

        manager._registry.get(flowId).status = 'done';

        // Reset call tracking before merge
        mock.resetCalls();

        // Perform dry-run merge
        const mergeResult = manager.merge(flowId, targetBranch, true);

        // Verify: no git checkout or git merge was called
        const checkoutCalls = mock.getCallsMatching('git checkout');
        const mergeCalls = mock.getCallsMatching('git merge');

        assert.strictEqual(
          checkoutCalls.length,
          0,
          'git checkout should NOT be called during dry-run'
        );
        assert.strictEqual(
          mergeCalls.length,
          0,
          'git merge should NOT be called during dry-run'
        );

        // Verify: status remains 'done'
        const entry = manager._registry.get(flowId);
        assert.strictEqual(
          entry.status,
          'done',
          `Status should remain 'done' after dry-run, got '${entry.status}'`
        );

        // Verify: result indicates dry-run
        assert.strictEqual(mergeResult.dryRun, true);

        return true;
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// Property 16: Merge updates flow status
// ============================================================================

describe('Feature: parallel-worktree-tasks, Property 16: Merge updates flow status', () => {
  let mock;
  let originalExistsSync;
  let originalMkdirSync;

  beforeEach(() => {
    mock = new GitMock();
    originalExistsSync = fs.existsSync;
    originalMkdirSync = fs.mkdirSync;
    fs.existsSync = () => true;
    fs.mkdirSync = () => undefined;
  });

  afterEach(() => {
    mock.restore();
    fs.existsSync = originalExistsSync;
    fs.mkdirSync = originalMkdirSync;
  });

  /**
   * **Validates: Requirements 8.4**
   *
   * For any flowId with status 'done', after a successful non-dry-run merge(),
   * the registry status should be updated to 'merged'.
   */
  test('successful non-dry-run merge updates status to merged', () => {
    const flowIdArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/);
    const stepArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,9}$/);
    const targetBranchArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_/-]{0,15}$/);

    fc.assert(
      fc.property(flowIdArb, stepArb, targetBranchArb, (flowId, step, targetBranch) => {
        // Reset mock for each iteration
        mock.restore();
        mock = new GitMock();
        mock
          .register('git status --porcelain', () => '')
          .register('git worktree add', () => '')
          .register('git checkout', () => '')
          .register('git merge', () => '')
          .register('git log', () => '')
          .install();

        const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

        // Create a worktree and set status to 'done'
        const result = manager.create(flowId, step, '/repo', 'main');
        if (!result || !result.path) return true; // skip if creation failed

        manager._registry.get(flowId).status = 'done';

        // Perform actual merge (non-dry-run)
        const mergeResult = manager.merge(flowId, targetBranch, false);

        // Verify: merge succeeded
        assert.strictEqual(
          mergeResult.success,
          true,
          `Merge should succeed, got: ${JSON.stringify(mergeResult)}`
        );

        // Verify: status updated to 'merged'
        const entry = manager._registry.get(flowId);
        assert.strictEqual(
          entry.status,
          'merged',
          `Status should be 'merged' after successful merge, got '${entry.status}'`
        );

        // Verify: result indicates non-dry-run
        assert.strictEqual(mergeResult.dryRun, false);

        return true;
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// Property 17: Merge precondition enforcement
// ============================================================================

describe('Feature: parallel-worktree-tasks, Property 17: Merge precondition enforcement', () => {
  let mock;
  let originalExistsSync;
  let originalMkdirSync;

  beforeEach(() => {
    mock = new GitMock();
    originalExistsSync = fs.existsSync;
    originalMkdirSync = fs.mkdirSync;
    fs.existsSync = () => true;
    fs.mkdirSync = () => undefined;
  });

  afterEach(() => {
    mock.restore();
    fs.existsSync = originalExistsSync;
    fs.mkdirSync = originalMkdirSync;
  });

  /**
   * **Validates: Requirements 8.5**
   *
   * For any flowId with status other than 'done' (active, failed, merged),
   * merge() returns { success: false } without executing any git commands.
   */
  test('merge is refused for any flow whose status is not done', () => {
    const flowIdArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/);
    const stepArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,9}$/);
    const targetBranchArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_/-]{0,15}$/);
    const nonDoneStatusArb = fc.constantFrom('active', 'failed', 'merged');

    fc.assert(
      fc.property(flowIdArb, stepArb, targetBranchArb, nonDoneStatusArb, (flowId, step, targetBranch, status) => {
        // Reset mock for each iteration
        mock.restore();
        mock = new GitMock();
        mock
          .register('git status --porcelain', () => '')
          .register('git worktree add', () => '')
          .install();

        const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

        // Create a worktree and set status to non-done value
        const result = manager.create(flowId, step, '/repo', 'main');
        if (!result || !result.path) return true; // skip if creation failed

        manager._registry.get(flowId).status = status;

        // Reset call tracking before merge attempt
        mock.resetCalls();

        // Attempt merge
        const mergeResult = manager.merge(flowId, targetBranch, false);

        // Verify: merge refused
        assert.strictEqual(
          mergeResult.success,
          false,
          `Merge should be refused for status '${status}', got success=true`
        );

        // Verify: no git checkout or git merge was called
        const checkoutCalls = mock.getCallsMatching('git checkout');
        const mergeCalls = mock.getCallsMatching('git merge');

        assert.strictEqual(
          checkoutCalls.length,
          0,
          `git checkout should NOT be called for status '${status}'`
        );
        assert.strictEqual(
          mergeCalls.length,
          0,
          `git merge should NOT be called for status '${status}'`
        );

        // Verify: status unchanged
        const entry = manager._registry.get(flowId);
        assert.strictEqual(
          entry.status,
          status,
          `Status should remain '${status}' after refused merge`
        );

        return true;
      }),
      { numRuns: 100 }
    );
  });

  test('merge is refused for non-existent flowId', () => {
    mock
      .register('git status --porcelain', () => '')
      .install();

    const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

    const mergeResult = manager.merge('non-existent-flow', 'main', false);

    assert.strictEqual(mergeResult.success, false);
    assert.strictEqual(mergeResult.flowId, 'non-existent-flow');
  });
});

// ============================================================================
// Unit tests for merge edge cases (Task 7.5)
// ============================================================================

describe('Feature: parallel-worktree-tasks, Unit tests: merge edge cases', () => {
  let mock;
  let originalExistsSync;
  let originalMkdirSync;

  beforeEach(() => {
    mock = new GitMock();
    originalExistsSync = fs.existsSync;
    originalMkdirSync = fs.mkdirSync;
    fs.existsSync = () => true;
    fs.mkdirSync = () => undefined;
  });

  afterEach(() => {
    mock.restore();
    fs.existsSync = originalExistsSync;
    fs.mkdirSync = originalMkdirSync;
  });

  /**
   * Requirements 8.2: merge conflict abort and report files
   */
  test('merge conflict: aborts merge and reports conflicting files', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git checkout', () => '')
      .registerError('git merge', {
        message: 'Automatic merge failed; fix conflicts and then commit',
        stderr: 'CONFLICT (content): Merge conflict in src/file1.js',
        exitCode: 1
      })
      .register('git merge --abort', () => '')
      .register('git diff --name-only --diff-filter=U', () => 'src/file1.js\nsrc/file2.js\n')
      .install();

    const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

    // Create a worktree and set status to done
    const createResult = manager.create('conflict-flow', 'implementer', '/repo', 'main');
    assert.ok(createResult.path, 'Worktree should be created');
    manager._registry.get('conflict-flow').status = 'done';

    // Attempt merge that will conflict
    const mergeResult = manager.merge('conflict-flow', 'main', false);

    // Verify: merge failed
    assert.strictEqual(mergeResult.success, false);
    assert.strictEqual(mergeResult.flowId, 'conflict-flow');
    assert.strictEqual(mergeResult.dryRun, false);

    // Verify: conflicting files reported
    assert.deepStrictEqual(mergeResult.conflictFiles, ['src/file1.js', 'src/file2.js']);

    // Verify: git merge --abort was called
    const abortCalls = mock.getCallsMatching('git merge --abort');
    assert.ok(abortCalls.length > 0, 'git merge --abort should have been called');

    // Verify: status did NOT change to merged (still done)
    assert.strictEqual(manager._registry.get('conflict-flow').status, 'done');
  });

  /**
   * Requirements 8.2: branch not found error
   */
  test('merge fails when git checkout target branch fails (branch not found)', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .registerError('git checkout', {
        message: "error: pathspec 'nonexistent-branch' did not match any file(s) known to git",
        stderr: "error: pathspec 'nonexistent-branch' did not match any file(s) known to git",
        exitCode: 1
      })
      .register('git merge --abort', () => '')
      .register('git diff --name-only --diff-filter=U', () => '')
      .install();

    const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

    // Create a worktree and set status to done
    const createResult = manager.create('branch-flow', 'implementer', '/repo', 'develop');
    assert.ok(createResult.path, 'Worktree should be created');
    manager._registry.get('branch-flow').status = 'done';

    // Attempt merge to non-existent target branch
    const mergeResult = manager.merge('branch-flow', 'nonexistent-branch', false);

    // Verify: merge failed
    assert.strictEqual(mergeResult.success, false);
    assert.strictEqual(mergeResult.flowId, 'branch-flow');
    assert.strictEqual(mergeResult.targetBranch, 'nonexistent-branch');
    assert.strictEqual(mergeResult.dryRun, false);
  });

  /**
   * Requirements 8.2: target branch diverged reporting
   */
  test('dry-run shows commits that would be merged (diverged branch reporting)', () => {
    const commitLog = [
      'a1b2c3d Fix authentication bug',
      'e4f5g6h Add new API endpoint',
      'i7j8k9l Update database schema'
    ].join('\n');

    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git log', () => commitLog)
      .install();

    const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

    // Create a worktree and set status to done
    const createResult = manager.create('diverged-flow', 'implementer', '/repo', 'main');
    assert.ok(createResult.path, 'Worktree should be created');
    manager._registry.get('diverged-flow').status = 'done';

    // Perform dry-run merge
    const mergeResult = manager.merge('diverged-flow', 'main', true);

    // Verify: dry-run succeeded
    assert.strictEqual(mergeResult.success, true);
    assert.strictEqual(mergeResult.dryRun, true);

    // Verify: commit count matches the diverged commits
    assert.strictEqual(mergeResult.commits, 3);
    assert.strictEqual(mergeResult.flowId, 'diverged-flow');
    assert.strictEqual(mergeResult.targetBranch, 'main');
  });

  /**
   * Additional edge case: dry-run with no diverged commits
   */
  test('dry-run reports 0 commits when branches are in sync', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git log', () => '')
      .install();

    const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

    // Create a worktree and set status to done
    const createResult = manager.create('synced-flow', 'implementer', '/repo', 'main');
    assert.ok(createResult.path, 'Worktree should be created');
    manager._registry.get('synced-flow').status = 'done';

    // Perform dry-run merge
    const mergeResult = manager.merge('synced-flow', 'main', true);

    // Verify: dry-run succeeded with 0 commits
    assert.strictEqual(mergeResult.success, true);
    assert.strictEqual(mergeResult.dryRun, true);
    assert.strictEqual(mergeResult.commits, 0);
  });

  /**
   * Edge case: merge conflict where git merge --abort also fails gracefully
   */
  test('merge handles git merge --abort failure gracefully', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git checkout', () => '')
      .registerError(/^git merge(?! --abort)/, {
        message: 'Merge conflict',
        stderr: 'CONFLICT',
        exitCode: 1
      })
      .registerError('git merge --abort', {
        message: 'Not in a merge state',
        stderr: 'fatal: There is no merge to abort',
        exitCode: 128
      })
      .register('git diff --name-only --diff-filter=U', () => 'conflicted.js\n')
      .install();

    const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

    // Create a worktree and set status to done
    const createResult = manager.create('abort-fail-flow', 'implementer', '/repo', 'main');
    assert.ok(createResult.path, 'Worktree should be created');
    manager._registry.get('abort-fail-flow').status = 'done';

    // Attempt merge - should handle abort failure gracefully
    const mergeResult = manager.merge('abort-fail-flow', 'main', false);

    // Verify: merge failed but did not throw
    assert.strictEqual(mergeResult.success, false);
    assert.strictEqual(mergeResult.flowId, 'abort-fail-flow');
    assert.deepStrictEqual(mergeResult.conflictFiles, ['conflicted.js']);
  });
});

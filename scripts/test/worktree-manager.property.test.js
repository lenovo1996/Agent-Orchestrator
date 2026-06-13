#!/usr/bin/env node
/**
 * Property-Based Tests for WorktreeManager
 *
 * Feature: parallel-worktree-tasks, Property 3: Worktree path uniqueness
 *
 * Run: node --test .dev-team/scripts/test/worktree-manager.property.test.js
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { WorktreeManager } = require('../lib/worktree-manager');
const { GitMock } = require('./helpers/git-mock');

describe('Feature: parallel-worktree-tasks, Property 3: Worktree path uniqueness', () => {
  let mock;

  beforeEach(() => {
    mock = new GitMock();
    // Mock git commands so create() succeeds
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();
  });

  afterEach(() => {
    mock.restore();
  });

  /**
   * **Validates: Requirements 2.2, 3.1, 3.4**
   *
   * For any set of unique (flowId, step) pairs, all resulting worktree paths
   * must be distinct. This ensures isolation between concurrently scheduled tasks,
   * even when tasks target the same repository.
   */
  test('all worktree paths are unique for any set of unique (flowId, step) pairs', () => {
    // Generator for a non-empty set of unique (flowId, step) pairs
    const uniquePairsArb = fc
      .uniqueArray(
        fc.tuple(
          fc.stringMatching(/^[a-zA-Z0-9_-]{1,30}$/),
          fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/)
        ),
        {
          minLength: 1,
          maxLength: 20,
          comparator: (a, b) => a[0] === b[0] && a[1] === b[1]
        }
      );

    fc.assert(
      fc.property(uniquePairsArb, (pairs) => {
        const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

        const paths = [];
        for (const [flowId, step] of pairs) {
          const result = manager.create(flowId, step, '/repo', 'main');
          // Only consider successful creations
          if (result && result.path) {
            paths.push(result.path);
          }
        }

        // All paths must be unique
        const uniquePaths = new Set(paths);
        return uniquePaths.size === paths.length;
      }),
      { numRuns: 100 }
    );
  });

  test('worktree paths are unique even when tasks target the same repository', () => {
    // Multiple tasks on the same repo must still get distinct paths
    const pairsWithReposArb = fc
      .uniqueArray(
        fc.tuple(
          fc.stringMatching(/^flow_[a-zA-Z0-9]{1,15}$/),
          fc.stringMatching(/^[a-zA-Z0-9_]{1,10}$/)
        ),
        {
          minLength: 2,
          maxLength: 10,
          comparator: (a, b) => a[0] === b[0] && a[1] === b[1]
        }
      );

    fc.assert(
      fc.property(pairsWithReposArb, (pairs) => {
        const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

        const paths = [];
        for (const [flowId, step] of pairs) {
          // All targeting same repo (Req 3.4)
          const result = manager.create(flowId, step, '/same/repo', 'main');
          if (result && result.path) {
            paths.push(result.path);
          }
        }

        const uniquePaths = new Set(paths);
        return uniquePaths.size === paths.length;
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: parallel-worktree-tasks, Property 6: Active worktree protection', () => {
  let mock;

  beforeEach(() => {
    mock = new GitMock();
    // Mock git commands so create() succeeds
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();
  });

  afterEach(() => {
    mock.restore();
  });

  /**
   * **Validates: Requirements 3.5**
   *
   * For any active worktree (status === 'active' after create()),
   * calling remove() shall be rejected with { success: false, error: 'Cannot remove active worktree' }.
   * The worktree shall remain in the registry unchanged.
   */
  test('remove() is rejected for any active worktree', () => {
    // Generator for valid flowId and step strings
    const flowIdArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,30}$/);
    const stepArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/);

    fc.assert(
      fc.property(flowIdArb, stepArb, (flowId, step) => {
        const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

        // Create a worktree — status will be 'active'
        const created = manager.create(flowId, step, '/repo', 'main');

        // Only proceed if creation was successful
        if (!created || !created.path) {
          return true; // skip if creation failed (e.g. invalid chars)
        }

        // Verify the worktree is active
        assert.strictEqual(created.status, 'active');
        assert.strictEqual(manager.isActive(flowId), true);

        // Attempt to remove the active worktree
        const removeResult = manager.remove(flowId);

        // Must be rejected
        assert.strictEqual(removeResult.success, false);
        assert.strictEqual(removeResult.error, 'Cannot remove active worktree');

        // Worktree must still exist in the registry
        assert.strictEqual(manager.getPath(flowId), created.path);
        assert.strictEqual(manager.isActive(flowId), true);

        return true;
      }),
      { numRuns: 100 }
    );
  });
});


describe('Feature: parallel-worktree-tasks, Property 7: Configuration determines worktree location', () => {
  let mock;
  let originalExistsSync;
  let originalMkdirSync;
  const fs = require('fs');

  beforeEach(() => {
    mock = new GitMock();
    // Mock git commands so create() succeeds
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    // Mock fs methods to avoid real filesystem access
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
   * **Validates: Requirements 4.2, 4.5**
   *
   * For any configured base directory (absolute path) and any flowId/step combination,
   * the created worktree path must be a child of path.resolve(baseDir).
   * This ensures configuration determines worktree location regardless of
   * custom or default baseDir values.
   */
  test('all created worktrees have paths that are children of configured baseDir', () => {
    const path = require('path');

    // Generator for absolute paths (simulating various baseDir configurations)
    const baseDirArb = fc.oneof(
      fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/).map(s => `/tmp/${s}`),
      fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/).map(s => `/home/user/${s}`),
      fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/).map(s => `/var/worktrees/${s}`),
      fc.constant('../.dev-team-worktrees'),
      fc.stringMatching(/^[a-zA-Z0-9_-]{1,6}$/).map(s => `/opt/${s}/trees`)
    );

    // Generator for flowId and step
    const flowIdArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,30}$/);
    const stepArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/);

    fc.assert(
      fc.property(baseDirArb, flowIdArb, stepArb, (baseDir, flowId, step) => {
        const manager = new WorktreeManager({ baseDir });

        const result = manager.create(flowId, step, '/repo', 'main');

        // Only check successful creations
        if (!result || !result.path) {
          return true; // skip errors
        }

        // The worktree path must start with the resolved baseDir
        const resolvedBase = path.resolve(baseDir);
        const resolvedWorktree = path.resolve(result.path);

        // Worktree path must be a child of baseDir (starts with baseDir + separator)
        return resolvedWorktree.startsWith(resolvedBase + path.sep);
      }),
      { numRuns: 100 }
    );
  });
});


describe('Feature: parallel-worktree-tasks, Property 8: Cleanup selects correct worktrees', () => {
  let mock;
  let originalExistsSync;
  let originalMkdirSync;
  const fs = require('fs');

  beforeEach(() => {
    mock = new GitMock();
    // Mock git commands so create() and cleanup() succeed
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git worktree remove', () => '')
      .register('git branch --merged', (cmd) => {
        // Return the branch name so it appears merged
        // We extract branch from remove calls context; return a generic list
        return '  main\n  worktree/flow/step\n';
      })
      .register('git branch -d', () => '')
      .install();

    // Mock fs methods to avoid filesystem issues
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
   * **Validates: Requirements 5.1**
   *
   * For any set of worktrees with mixed statuses (active, done, failed, merged),
   * cleanup() shall remove exactly those with status "done" or "failed",
   * and shall not remove worktrees with any other status.
   */
  test('cleanup removes exactly done/failed worktrees and preserves active/merged ones', () => {
    // Generator for a list of worktrees with assigned statuses
    const statusArb = fc.constantFrom('active', 'done', 'failed', 'merged');

    // Generate a non-empty array of unique flowIds with assigned statuses
    const worktreeSetArb = fc.uniqueArray(
      fc.tuple(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/),
        statusArb
      ),
      {
        minLength: 1,
        maxLength: 15,
        comparator: (a, b) => a[0] === b[0]
      }
    );

    fc.assert(
      fc.property(worktreeSetArb, (worktreeSpecs) => {
        const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

        // Create all worktrees and set their statuses
        const created = [];
        for (const [flowId, targetStatus] of worktreeSpecs) {
          const result = manager.create(flowId, 'step', '/repo', 'main');
          if (!result || !result.path) {
            continue; // skip failed creations
          }
          // Set the desired status directly via internal registry
          manager._registry.get(flowId).status = targetStatus;
          created.push({ flowId, status: targetStatus });
        }

        // Skip if no worktrees were successfully created
        if (created.length === 0) return true;

        // Determine expected outcomes
        const shouldBeRemoved = new Set(
          created.filter(w => w.status === 'done' || w.status === 'failed').map(w => w.flowId)
        );
        const shouldRemain = new Set(
          created.filter(w => w.status !== 'done' && w.status !== 'failed').map(w => w.flowId)
        );

        // Run cleanup
        const cleanupResult = manager.cleanup();

        // Verify: all done/failed worktrees were removed from registry
        for (const flowId of shouldBeRemoved) {
          assert.strictEqual(
            manager._registry.has(flowId),
            false,
            `Worktree ${flowId} (done/failed) should have been removed from registry`
          );
        }

        // Verify: all active/merged worktrees remain in registry
        for (const flowId of shouldRemain) {
          assert.strictEqual(
            manager._registry.has(flowId),
            true,
            `Worktree ${flowId} (active/merged) should still be in registry`
          );
        }

        // Verify: cleanup result reports correct removed set
        const removedSet = new Set(cleanupResult.removed);
        for (const flowId of shouldBeRemoved) {
          assert.strictEqual(
            removedSet.has(flowId),
            true,
            `Worktree ${flowId} should be in cleanup removed list`
          );
        }

        // Verify: no active/merged worktree appears in removed list
        for (const flowId of shouldRemain) {
          assert.strictEqual(
            removedSet.has(flowId),
            false,
            `Worktree ${flowId} (active/merged) should NOT be in cleanup removed list`
          );
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });
});


describe('Feature: parallel-worktree-tasks, Property 9: Cleanup preserves unmerged branches', () => {
  let mock;
  let originalExistsSync;
  let originalMkdirSync;
  const fs = require('fs');

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
   * **Validates: Requirements 5.2**
   *
   * For any worktree being removed during cleanup, branch deletion shall only
   * occur if the branch has been merged into the target. When `git branch --merged HEAD`
   * does NOT include the worktree's branch name, `git branch -d` must never be called
   * for that branch and the flow must appear in skippedUnmerged.
   */
  test('git branch -d is never called for branches not in git branch --merged output', () => {
    // Generator for valid flowIds
    const flowIdArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/);
    const stepArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,9}$/);

    fc.assert(
      fc.property(flowIdArb, stepArb, (flowId, step) => {
        // Reset mock for each iteration
        mock.restore();
        mock = new GitMock();

        // The branch that will be created for this worktree
        const expectedBranch = `worktree/${flowId}/${step}`;

        // Mock git commands:
        // - status: clean repo
        // - worktree add: success
        // - worktree remove: success
        // - branch --merged: return output that does NOT include the worktree branch
        // - branch -d: should NEVER be called for this branch
        mock
          .register('git status --porcelain', () => '')
          .register('git worktree add', () => '')
          .register('git worktree remove', () => '')
          .register('git branch --merged', () => '  main\n  develop\n  feature/other\n')
          .register('git branch -d', () => '')
          .install();

        const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

        // Create a worktree
        const result = manager.create(flowId, step, '/repo', 'main');
        if (!result || !result.path) {
          return true; // skip if creation failed
        }

        // Set status to 'done' so cleanup will process it
        manager._registry.get(flowId).status = 'done';

        // Reset call tracking before cleanup
        mock.resetCalls();

        // Run cleanup
        const cleanupResult = manager.cleanup();

        // Verify: no `git branch -d` call was made for the unmerged branch
        const branchDeleteCalls = mock.getCallsMatching('git branch -d');
        const deletedOurBranch = branchDeleteCalls.some(
          call => call.cmd.includes(expectedBranch)
        );

        assert.strictEqual(
          deletedOurBranch,
          false,
          `git branch -d should NOT have been called for unmerged branch "${expectedBranch}"`
        );

        // Verify: the flow appears in skippedUnmerged
        assert.ok(
          cleanupResult.skippedUnmerged.includes(flowId),
          `Flow "${flowId}" should be in skippedUnmerged since branch was not merged`
        );

        // Verify: worktree was still removed (only branch deletion is skipped)
        assert.ok(
          cleanupResult.removed.includes(flowId),
          `Flow "${flowId}" should still be in removed list (worktree removed, only branch preserved)`
        );

        return true;
      }),
      { numRuns: 100 }
    );
  });
});


describe('Feature: parallel-worktree-tasks, Property 10: List output completeness', () => {
  let mock;
  let originalExistsSync;
  let originalMkdirSync;
  const fs = require('fs');

  beforeEach(() => {
    mock = new GitMock();
    // Mock git commands so create() succeeds
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    // Mock fs methods to avoid real filesystem access
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
   * **Validates: Requirements 5.4**
   *
   * For any set of created worktrees, the list() output shall contain
   * all required fields (flowId, branch, repo, status) for each entry.
   * This ensures the list command provides complete information for
   * every tracked worktree.
   */
  test('list() output contains flowId, branch, repo, status for every worktree', () => {
    // Generator for unique flowId/step pairs representing created worktrees
    const worktreeInputArb = fc.uniqueArray(
      fc.record({
        flowId: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/),
        step: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,9}$/),
        repo: fc.constantFrom('/repo/core', '/repo/auth', '/repo/jinji')
      }),
      {
        minLength: 1,
        maxLength: 15,
        comparator: (a, b) => a.flowId === b.flowId
      }
    );

    fc.assert(
      fc.property(worktreeInputArb, (inputs) => {
        const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

        // Create worktrees
        const successfulFlowIds = [];
        for (const { flowId, step, repo } of inputs) {
          const result = manager.create(flowId, step, repo, 'main');
          if (result && result.path) {
            successfulFlowIds.push(flowId);
          }
        }

        // Skip if no worktrees were successfully created
        if (successfulFlowIds.length === 0) return true;

        // Get list output
        const listed = manager.list();

        // Verify: list has the same count as successful creations
        assert.strictEqual(
          listed.length,
          successfulFlowIds.length,
          `list() should return ${successfulFlowIds.length} entries, got ${listed.length}`
        );

        // Verify: each entry has all required fields
        for (const entry of listed) {
          // flowId must be present and non-empty
          assert.ok(
            entry.flowId !== undefined && entry.flowId !== null && entry.flowId !== '',
            `Entry must have a non-empty flowId, got: ${JSON.stringify(entry.flowId)}`
          );

          // branch must be present and non-empty
          assert.ok(
            entry.branch !== undefined && entry.branch !== null && entry.branch !== '',
            `Entry for flow "${entry.flowId}" must have a non-empty branch, got: ${JSON.stringify(entry.branch)}`
          );

          // repo must be present and non-empty
          assert.ok(
            entry.repo !== undefined && entry.repo !== null && entry.repo !== '',
            `Entry for flow "${entry.flowId}" must have a non-empty repo, got: ${JSON.stringify(entry.repo)}`
          );

          // status must be present and a valid value
          assert.ok(
            ['active', 'done', 'failed', 'merged'].includes(entry.status),
            `Entry for flow "${entry.flowId}" must have a valid status, got: ${JSON.stringify(entry.status)}`
          );
        }

        // Verify: all successful flowIds appear in the list output
        const listedFlowIds = new Set(listed.map(e => e.flowId));
        for (const flowId of successfulFlowIds) {
          assert.ok(
            listedFlowIds.has(flowId),
            `Flow "${flowId}" was created successfully but is missing from list() output`
          );
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });
});


describe('Feature: parallel-worktree-tasks, Property 18: Worktree retention until cleanup', () => {
  let mock;
  let originalExistsSync;
  let originalMkdirSync;
  const fs = require('fs');

  beforeEach(() => {
    mock = new GitMock();
    // Mock git commands for create and cleanup
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git worktree remove', () => '')
      .register('git branch --merged', (cmd) => {
        // Return a list that includes worktree branches so cleanup can delete them
        return '  main\n  worktree/flow/step\n';
      })
      .register('git branch -d', () => '')
      .install();

    // Mock fs methods to avoid real filesystem access
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
   * **Validates: Requirements 1.5**
   *
   * For any completed task (status "done"), the worktree path shall remain
   * valid and accessible (via getPath and list) until the user explicitly
   * runs cleanup(). After cleanup(), those worktrees are removed from the registry.
   */
  test('completed worktrees remain accessible via getPath/list until explicit cleanup', () => {
    // Generator for a non-empty set of unique flowIds with mixed statuses
    const statusArb = fc.constantFrom('active', 'done', 'failed', 'merged');
    const worktreeSetArb = fc.uniqueArray(
      fc.tuple(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/),
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,9}$/),
        statusArb
      ),
      {
        minLength: 1,
        maxLength: 15,
        comparator: (a, b) => a[0] === b[0]
      }
    );

    fc.assert(
      fc.property(worktreeSetArb, (worktreeSpecs) => {
        const manager = new WorktreeManager({ baseDir: '/tmp/worktrees' });

        // Create all worktrees and set their statuses
        const created = [];
        for (const [flowId, step, targetStatus] of worktreeSpecs) {
          const result = manager.create(flowId, step, '/repo', 'main');
          if (!result || !result.path) {
            continue; // skip failed creations
          }
          // Set the desired status directly via internal registry
          manager._registry.get(flowId).status = targetStatus;
          created.push({ flowId, status: targetStatus, path: result.path });
        }

        // Skip if no worktrees were successfully created
        if (created.length === 0) return true;

        // Identify "done" worktrees
        const doneWorktrees = created.filter(w => w.status === 'done');

        // ========== BEFORE CLEANUP ==========
        // Verify: all done worktrees are still accessible via getPath()
        for (const { flowId, path: expectedPath } of doneWorktrees) {
          const retrievedPath = manager.getPath(flowId);
          assert.strictEqual(
            retrievedPath,
            expectedPath,
            `Before cleanup: getPath("${flowId}") should return the worktree path`
          );
        }

        // Verify: all done worktrees appear in list()
        const listBeforeCleanup = manager.list();
        const listedFlowIdsBefore = new Set(listBeforeCleanup.map(e => e.flowId));
        for (const { flowId } of doneWorktrees) {
          assert.ok(
            listedFlowIdsBefore.has(flowId),
            `Before cleanup: list() should include done worktree "${flowId}"`
          );
        }

        // ========== AFTER CLEANUP ==========
        manager.cleanup();

        // Verify: done worktrees are now removed from registry (getPath returns null)
        for (const { flowId } of doneWorktrees) {
          const pathAfter = manager.getPath(flowId);
          assert.strictEqual(
            pathAfter,
            null,
            `After cleanup: getPath("${flowId}") should return null for cleaned-up done worktree`
          );
        }

        // Verify: done worktrees no longer appear in list()
        const listAfterCleanup = manager.list();
        const listedFlowIdsAfter = new Set(listAfterCleanup.map(e => e.flowId));
        for (const { flowId } of doneWorktrees) {
          assert.ok(
            !listedFlowIdsAfter.has(flowId),
            `After cleanup: list() should NOT include cleaned-up done worktree "${flowId}"`
          );
        }

        // Verify: active and merged worktrees are still accessible
        const preservedWorktrees = created.filter(
          w => w.status === 'active' || w.status === 'merged'
        );
        for (const { flowId, path: expectedPath } of preservedWorktrees) {
          const retrievedPath = manager.getPath(flowId);
          assert.strictEqual(
            retrievedPath,
            expectedPath,
            `After cleanup: getPath("${flowId}") should still return path for ${manager._registry.get(flowId) ? manager._registry.get(flowId).status : 'unknown'} worktree`
          );
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });
});

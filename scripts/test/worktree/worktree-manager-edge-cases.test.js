#!/usr/bin/env node
/**
 * Unit Tests for WorktreeManager edge cases
 *
 * Tests:
 * - Dirty repo detection → DIRTY_REPO error (Req 1.3, 1.4)
 * - Git error → structured error with stderr + exit code (Req 1.6)
 * - Non-existent baseDir auto-creation (Req 4.3)
 * - Removal failure resilience in cleanup (Req 5.3)
 *
 * Run: node --test .dev-team/scripts/test/worktree-manager-edge-cases.test.js
 */

'use strict';

const { test, describe, beforeEach, afterEach, mock: testMock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { WorktreeManager } = require('../../worktree/worktree-manager');
const { GitMock } = require('../helpers/git-mock');

describe('WorktreeManager edge cases: Dirty repo detection (Req 1.3, 1.4)', () => {
  let mock;
  let manager;

  beforeEach(() => {
    mock = new GitMock();
    manager = new WorktreeManager({ baseDir: '/tmp/test-worktrees' });
  });

  afterEach(() => {
    mock.restore();
  });

  test('returns DIRTY_REPO error when git status shows modified files', () => {
    mock
      .register('git status --porcelain', () => ' M src/app.js')
      .install();

    const result = manager.create('flow_dirty1', 'implementer', '/repo', 'main');

    assert.strictEqual(result.code, 'DIRTY_REPO');
    assert.ok(result.message);
    assert.ok(result.message.includes('uncommitted changes'));
  });

  test('returns DIRTY_REPO error when repo has untracked files', () => {
    mock
      .register('git status --porcelain', () => '?? untracked.txt')
      .install();

    const result = manager.create('flow_dirty2', 'implementer', '/repo', 'main');

    assert.strictEqual(result.code, 'DIRTY_REPO');
  });

  test('returns DIRTY_REPO error when repo has staged and unstaged changes', () => {
    mock
      .register('git status --porcelain', () => 'M  staged.js\n M unstaged.js\n?? new.txt')
      .install();

    const result = manager.create('flow_dirty3', 'implementer', '/repo', 'main');

    assert.strictEqual(result.code, 'DIRTY_REPO');
    assert.ok(result.message.includes('uncommitted changes'));
  });

  test('DIRTY_REPO error includes repository path in message', () => {
    mock
      .register('git status --porcelain', () => 'M file.js')
      .install();

    const result = manager.create('flow_dirty4', 'implementer', '/my/repo/path', 'main');

    assert.strictEqual(result.code, 'DIRTY_REPO');
    assert.ok(result.message.includes('/my/repo/path'));
  });

  test('does not create worktree when repo is dirty', () => {
    mock
      .register('git status --porcelain', () => 'M dirty.txt')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_dirty5', 'implementer', '/repo', 'main');

    const addCalls = mock.getCallsMatching('git worktree add');
    assert.strictEqual(addCalls.length, 0);
  });

  test('does not register worktree in internal state when dirty', () => {
    mock
      .register('git status --porcelain', () => 'M dirty.txt')
      .install();

    manager.create('flow_dirty6', 'implementer', '/repo', 'main');

    assert.strictEqual(manager._registry.has('flow_dirty6'), false);
  });
});

describe('WorktreeManager edge cases: Git error structured response (Req 1.6)', () => {
  let mock;
  let manager;

  beforeEach(() => {
    mock = new GitMock();
    manager = new WorktreeManager({ baseDir: '/tmp/test-worktrees' });
  });

  afterEach(() => {
    mock.restore();
  });

  test('returns GIT_ERROR with stderr when git status fails', () => {
    mock
      .registerError('git status --porcelain', {
        stderr: 'fatal: not a git repository (or any parent up to mount point /)',
        exitCode: 128,
        message: 'Command failed'
      })
      .install();

    const result = manager.create('flow_giterr1', 'implementer', '/not-a-repo', 'main');

    assert.strictEqual(result.code, 'GIT_ERROR');
    assert.ok(result.stderr.includes('not a git repository'));
    assert.strictEqual(result.exitCode, 128);
    assert.ok(result.message);
  });

  test('returns GIT_ERROR with stderr when git worktree add fails', () => {
    mock
      .register('git status --porcelain', () => '')
      .registerError('git worktree add', {
        stderr: "fatal: 'worktree/flow_giterr2/implementer' is already checked out",
        exitCode: 128,
        message: 'Command failed'
      })
      .install();

    const result = manager.create('flow_giterr2', 'implementer', '/repo', 'main');

    assert.strictEqual(result.code, 'GIT_ERROR');
    assert.ok(result.stderr.includes('already checked out'));
    assert.strictEqual(result.exitCode, 128);
  });

  test('GIT_ERROR preserves non-standard exit codes', () => {
    mock
      .registerError('git status --porcelain', {
        stderr: 'error: permission denied',
        exitCode: 3,
        message: 'Command failed'
      })
      .install();

    const result = manager.create('flow_giterr3', 'implementer', '/repo', 'main');

    assert.strictEqual(result.code, 'GIT_ERROR');
    assert.strictEqual(result.exitCode, 3);
    assert.ok(result.stderr.includes('permission denied'));
  });

  test('GIT_ERROR does not register worktree on failure', () => {
    mock
      .register('git status --porcelain', () => '')
      .registerError('git worktree add', {
        stderr: 'fatal: branch already exists',
        exitCode: 128,
        message: 'Command failed'
      })
      .install();

    manager.create('flow_giterr4', 'implementer', '/repo', 'main');

    assert.strictEqual(manager._registry.has('flow_giterr4'), false);
  });

  test('GIT_ERROR message is descriptive', () => {
    mock
      .registerError('git status --porcelain', {
        stderr: 'fatal: bad config',
        exitCode: 1,
        message: 'Command failed'
      })
      .install();

    const result = manager.create('flow_giterr5', 'implementer', '/repo', 'main');

    assert.strictEqual(result.code, 'GIT_ERROR');
    assert.ok(result.message.length > 0);
  });
});

describe('WorktreeManager edge cases: Non-existent baseDir auto-creation (Req 4.3)', () => {
  let mock;
  let manager;
  let existsSyncOrig;
  let mkdirSyncOrig;
  let mkdirSyncCalls;

  beforeEach(() => {
    mock = new GitMock();
    existsSyncOrig = fs.existsSync;
    mkdirSyncOrig = fs.mkdirSync;
    mkdirSyncCalls = [];
  });

  afterEach(() => {
    mock.restore();
    fs.existsSync = existsSyncOrig;
    fs.mkdirSync = mkdirSyncOrig;
  });

  test('calls fs.mkdirSync with { recursive: true } when baseDir does not exist', () => {
    const customBase = '/tmp/non-existent-worktree-base';
    manager = new WorktreeManager({ baseDir: customBase });

    // Patch fs to simulate non-existent directory
    fs.existsSync = (p) => {
      // The worktree-manager checks path.dirname(worktreePath)
      // worktreePath = path.resolve(baseDir, flowId, step)
      // dirname of that = path.resolve(baseDir, flowId)
      if (p.startsWith(customBase)) {
        return false; // directory does not exist
      }
      return existsSyncOrig(p);
    };

    fs.mkdirSync = (p, opts) => {
      mkdirSyncCalls.push({ path: p, opts });
      // Don't actually create - just record
    };

    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_mkdir1', 'implementer', '/repo', 'main');

    assert.ok(mkdirSyncCalls.length > 0, 'mkdirSync should have been called');
    const call = mkdirSyncCalls[0];
    assert.ok(call.opts && call.opts.recursive === true, 'mkdirSync should be called with { recursive: true }');
  });

  test('mkdirSync is called with the parent directory of worktree path', () => {
    const customBase = '/tmp/new-base-dir';
    manager = new WorktreeManager({ baseDir: customBase });

    fs.existsSync = (p) => {
      if (p.startsWith(customBase)) {
        return false;
      }
      return existsSyncOrig(p);
    };

    fs.mkdirSync = (p, opts) => {
      mkdirSyncCalls.push({ path: p, opts });
    };

    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_mkdir2', 'implementer', '/repo', 'main');

    // The expected parent dir is path.resolve(customBase, 'flow_mkdir2')
    // because worktreePath = path.resolve(customBase, 'flow_mkdir2', 'implementer')
    // and dirname(worktreePath) = path.resolve(customBase, 'flow_mkdir2')
    const expectedDir = path.resolve(customBase, 'flow_mkdir2');
    assert.ok(mkdirSyncCalls.length > 0);
    assert.strictEqual(mkdirSyncCalls[0].path, expectedDir);
  });

  test('does not call mkdirSync when directory already exists', () => {
    const customBase = '/tmp/existing-base';
    manager = new WorktreeManager({ baseDir: customBase });

    fs.existsSync = (p) => {
      if (p.startsWith(customBase)) {
        return true; // directory already exists
      }
      return existsSyncOrig(p);
    };

    fs.mkdirSync = (p, opts) => {
      mkdirSyncCalls.push({ path: p, opts });
    };

    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_mkdir3', 'implementer', '/repo', 'main');

    assert.strictEqual(mkdirSyncCalls.length, 0, 'mkdirSync should not be called when dir exists');
  });
});

describe('WorktreeManager edge cases: Removal failure resilience in cleanup (Req 5.3)', () => {
  let mock;
  let manager;

  beforeEach(() => {
    mock = new GitMock();
    manager = new WorktreeManager({ baseDir: '/tmp/test-worktrees' });
  });

  afterEach(() => {
    mock.restore();
  });

  test('cleanup continues with remaining worktrees after one removal fails', () => {
    // Register git commands - status and add for creation
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    // Create three worktrees
    manager.create('flow_a', 'implementer', '/repo', 'main');
    manager.create('flow_b', 'implementer', '/repo', 'main');
    manager.create('flow_c', 'implementer', '/repo', 'main');

    // Mark all as 'done' so they're eligible for cleanup
    manager._registry.get('flow_a').status = 'done';
    manager._registry.get('flow_b').status = 'done';
    manager._registry.get('flow_c').status = 'done';

    // Restore mock and set up new one where flow_b removal fails
    mock.restore();
    const mock2 = new GitMock();

    const pathB = manager._registry.get('flow_b').path;

    mock2
      .register('git worktree remove', (cmd) => {
        if (cmd.includes(pathB)) {
          const err = new Error('Command failed');
          err.status = 1;
          err.stderr = Buffer.from('error: worktree is locked');
          err.stdout = Buffer.from('');
          throw err;
        }
        return '';
      })
      .register('git branch --merged', () => '')
      .register('git branch -d', () => '')
      .install();

    // Suppress console.error output during test
    const origConsoleError = console.error;
    console.error = () => {};

    const result = manager.cleanup();

    console.error = origConsoleError;
    mock2.restore();

    // flow_b should be in failed list
    assert.ok(result.failed.some(f => f.flowId === 'flow_b'), 'flow_b should be in failed list');
    assert.ok(result.failed.find(f => f.flowId === 'flow_b').error.length > 0);

    // flow_a and flow_c should be in removed list (cleanup continued past the failure)
    assert.ok(result.removed.includes('flow_a'), 'flow_a should have been removed');
    assert.ok(result.removed.includes('flow_c'), 'flow_c should have been removed');
  });

  test('cleanup logs error but does not throw when removal fails', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_fail_only', 'implementer', '/repo', 'main');
    manager._registry.get('flow_fail_only').status = 'done';

    mock.restore();
    const mock2 = new GitMock();
    mock2
      .registerError('git worktree remove', {
        stderr: 'error: cannot remove',
        exitCode: 1,
        message: 'Command failed'
      })
      .install();

    // Suppress console.error
    const origConsoleError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));

    // Should NOT throw
    let result;
    assert.doesNotThrow(() => {
      result = manager.cleanup();
    });

    console.error = origConsoleError;
    mock2.restore();

    // Should log something about the failure
    assert.ok(logged.length > 0, 'Should have logged the error');
    assert.ok(logged[0].includes('flow_fail_only'));

    // Failure recorded in result
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].flowId, 'flow_fail_only');
  });

  test('cleanup result contains correct failed entries with error messages', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_err_detail', 'implementer', '/repo', 'main');
    manager._registry.get('flow_err_detail').status = 'failed';

    mock.restore();
    const mock2 = new GitMock();
    mock2
      .registerError('git worktree remove', {
        stderr: 'fatal: specific error message here',
        exitCode: 128,
        message: 'Command failed'
      })
      .install();

    const origConsoleError = console.error;
    console.error = () => {};

    const result = manager.cleanup();

    console.error = origConsoleError;
    mock2.restore();

    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].flowId, 'flow_err_detail');
    assert.ok(result.failed[0].error.length > 0);
  });

  test('worktree remains in registry when removal fails during cleanup', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_persist', 'implementer', '/repo', 'main');
    manager._registry.get('flow_persist').status = 'done';

    mock.restore();
    const mock2 = new GitMock();
    mock2
      .registerError('git worktree remove', {
        stderr: 'error: removal blocked',
        exitCode: 1,
        message: 'Command failed'
      })
      .install();

    const origConsoleError = console.error;
    console.error = () => {};

    manager.cleanup();

    console.error = origConsoleError;
    mock2.restore();

    // The entry should remain in registry since cleanup uses 'continue'
    // and the registry.delete is only called after successful removal
    assert.ok(manager._registry.has('flow_persist'), 'Registry entry should persist after failed removal');
  });
});

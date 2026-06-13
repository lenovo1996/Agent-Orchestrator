#!/usr/bin/env node
/**
 * Unit Tests for WorktreeManager.create() method
 *
 * Tests: Requirements 1.1, 1.2, 1.3, 1.4, 1.6
 *
 * Run: node --test .dev-team/scripts/test/worktree-manager-create.test.js
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { WorktreeManager } = require('../../worktree/worktree-manager');
const { GitMock } = require('../helpers/git-mock');

describe('WorktreeManager.create()', () => {
  let mock;
  let manager;

  beforeEach(() => {
    mock = new GitMock();
    manager = new WorktreeManager({ baseDir: '/tmp/test-worktrees' });
  });

  afterEach(() => {
    mock.restore();
  });

  describe('Success cases', () => {
    test('creates worktree and returns WorktreeInfo on clean repo', () => {
      mock
        .register('git status --porcelain', () => '')
        .register('git worktree add', () => '')
        .install();

      const result = manager.create('flow_123', 'implementer', '/repo/path', 'main');

      assert.strictEqual(result.flowId, 'flow_123');
      assert.strictEqual(result.branch, 'worktree/flow_123/implementer');
      assert.strictEqual(result.repo, '/repo/path');
      assert.strictEqual(result.status, 'active');
      assert.ok(result.path.includes('flow_123'));
      assert.ok(result.path.includes('implementer'));
      assert.ok(result.createdAt);
    });

    test('worktree path is built from baseDir/flowId/step', () => {
      mock
        .register('git status --porcelain', () => '')
        .register('git worktree add', () => '')
        .install();

      const result = manager.create('flow_abc', 'reviewer', '/repo', 'develop');

      const expected = path.resolve('/tmp/test-worktrees', 'flow_abc', 'reviewer');
      assert.strictEqual(result.path, expected);
    });

    test('stores worktree info in internal registry', () => {
      mock
        .register('git status --porcelain', () => '')
        .register('git worktree add', () => '')
        .install();

      manager.create('flow_xyz', 'implementer', '/repo', 'main');

      assert.ok(manager._registry.has('flow_xyz'));
      assert.strictEqual(manager._registry.get('flow_xyz').status, 'active');
    });

    test('calls git worktree add with correct arguments', () => {
      mock
        .register('git status --porcelain', () => '')
        .register('git worktree add', () => '')
        .install();

      manager.create('flow_1', 'implementer', '/repo', 'main');

      const addCalls = mock.getCallsMatching('git worktree add');
      assert.strictEqual(addCalls.length, 1);
      assert.ok(addCalls[0].cmd.includes('-b worktree/flow_1/implementer'));
      assert.ok(addCalls[0].cmd.includes('main'));
    });

    test('passes repoPath as cwd to git commands', () => {
      mock
        .register('git status --porcelain', () => '')
        .register('git worktree add', () => '')
        .install();

      manager.create('flow_1', 'implementer', '/my/repo', 'main');

      const calls = mock.getCalls();
      for (const call of calls) {
        assert.strictEqual(call.options.cwd, '/my/repo');
      }
    });
  });

  describe('Dirty repo detection (Req 1.3, 1.4)', () => {
    test('returns DIRTY_REPO error when repo has uncommitted changes', () => {
      mock
        .register('git status --porcelain', () => ' M src/file.js\n?? new-file.txt')
        .install();

      const result = manager.create('flow_dirty', 'implementer', '/repo', 'main');

      assert.strictEqual(result.code, 'DIRTY_REPO');
      assert.ok(result.message.includes('uncommitted changes'));
    });

    test('does not call git worktree add when repo is dirty', () => {
      mock
        .register('git status --porcelain', () => 'M file.txt')
        .register('git worktree add', () => '')
        .install();

      manager.create('flow_dirty', 'implementer', '/repo', 'main');

      const addCalls = mock.getCallsMatching('git worktree add');
      assert.strictEqual(addCalls.length, 0);
    });

    test('does not register worktree when repo is dirty', () => {
      mock
        .register('git status --porcelain', () => 'M file.txt')
        .install();

      manager.create('flow_dirty', 'implementer', '/repo', 'main');

      assert.ok(!manager._registry.has('flow_dirty'));
    });
  });

  describe('Git error handling (Req 1.6)', () => {
    test('returns GIT_ERROR when git status fails', () => {
      mock
        .registerError('git status --porcelain', {
          stderr: 'fatal: not a git repository',
          exitCode: 128,
          message: 'Command failed'
        })
        .install();

      const result = manager.create('flow_err', 'implementer', '/not-a-repo', 'main');

      assert.strictEqual(result.code, 'GIT_ERROR');
      assert.ok(result.stderr.includes('not a git repository'));
      assert.strictEqual(result.exitCode, 128);
    });

    test('returns GIT_ERROR when git worktree add fails', () => {
      mock
        .register('git status --porcelain', () => '')
        .registerError('git worktree add', {
          stderr: 'fatal: branch already exists',
          exitCode: 128,
          message: 'Command failed'
        })
        .install();

      const result = manager.create('flow_err2', 'implementer', '/repo', 'main');

      assert.strictEqual(result.code, 'GIT_ERROR');
      assert.ok(result.stderr.includes('branch already exists'));
      assert.strictEqual(result.exitCode, 128);
    });

    test('does not register worktree when git worktree add fails', () => {
      mock
        .register('git status --porcelain', () => '')
        .registerError('git worktree add', {
          stderr: 'error',
          exitCode: 1
        })
        .install();

      manager.create('flow_err3', 'implementer', '/repo', 'main');

      assert.ok(!manager._registry.has('flow_err3'));
    });
  });

  describe('Branch resolution (Req 1.2)', () => {
    test('uses BranchResolver to determine branch name', () => {
      mock
        .register('git status --porcelain', () => '')
        .register('git worktree add', () => '')
        .install();

      const result = manager.create('flow_test', 'qa', '/repo', 'develop');

      assert.strictEqual(result.branch, 'worktree/flow_test/qa');
    });
  });

  describe('Configuration (Req 4.2, 4.5)', () => {
    test('uses configured baseDir for worktree path', () => {
      const customManager = new WorktreeManager({ baseDir: '/tmp/custom-worktrees' });
      mock
        .register('git status --porcelain', () => '')
        .register('git worktree add', () => '')
        .install();

      const result = customManager.create('flow_cfg', 'implementer', '/repo', 'main');

      assert.ok(result.path.startsWith('/tmp/custom-worktrees'));
    });

    test('uses default baseDir when not configured', () => {
      const defaultManager = new WorktreeManager();
      mock
        .register('git status --porcelain', () => '')
        .register('git worktree add', () => '')
        .install();

      const result = defaultManager.create('flow_def', 'implementer', '/repo', 'main');

      assert.ok(result.path.includes('.dev-team-worktrees'));
    });
  });
});

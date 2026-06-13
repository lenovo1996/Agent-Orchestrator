#!/usr/bin/env node
/**
 * Unit Tests for WorktreeManager remove(), list(), getPath(), isActive() methods
 *
 * Tests: Requirements 3.5, 5.4
 *
 * Run: node --test .dev-team/scripts/test/worktree-manager-methods.test.js
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { WorktreeManager } = require('../lib/worktree-manager');
const { GitMock } = require('./helpers/git-mock');

describe('WorktreeManager.remove()', () => {
  let mock;
  let manager;

  beforeEach(() => {
    mock = new GitMock();
    manager = new WorktreeManager({ baseDir: '/tmp/test-worktrees' });
  });

  afterEach(() => {
    mock.restore();
  });

  test('rejects removal of active worktree (Req 3.5)', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_active', 'implementer', '/repo', 'main');

    const result = manager.remove('flow_active');

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'Cannot remove active worktree');
  });

  test('successfully removes worktree with non-active status', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git worktree remove', () => '')
      .install();

    manager.create('flow_done', 'implementer', '/repo', 'main');
    // Simulate task completion by changing status
    manager._registry.get('flow_done').status = 'done';

    const result = manager.remove('flow_done');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.error, undefined);
  });

  test('removes entry from registry after successful removal', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git worktree remove', () => '')
      .install();

    manager.create('flow_rem', 'implementer', '/repo', 'main');
    manager._registry.get('flow_rem').status = 'failed';

    manager.remove('flow_rem');

    assert.ok(!manager._registry.has('flow_rem'));
  });

  test('returns error when flowId not found', () => {
    mock.install();

    const result = manager.remove('nonexistent');

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('not found'));
  });

  test('calls git worktree remove with correct path and cwd', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git worktree remove', () => '')
      .install();

    manager.create('flow_path', 'implementer', '/my/repo', 'main');
    const entry = manager._registry.get('flow_path');
    entry.status = 'done';

    manager.remove('flow_path');

    const removeCalls = mock.getCallsMatching('git worktree remove');
    assert.strictEqual(removeCalls.length, 1);
    assert.ok(removeCalls[0].cmd.includes(entry.path));
    assert.strictEqual(removeCalls[0].options.cwd, '/my/repo');
  });

  test('returns error when git worktree remove fails', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .registerError('git worktree remove', {
        stderr: 'fatal: worktree is dirty',
        exitCode: 1,
        message: 'Command failed'
      })
      .install();

    manager.create('flow_fail', 'implementer', '/repo', 'main');
    manager._registry.get('flow_fail').status = 'done';

    const result = manager.remove('flow_fail');

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Failed to remove worktree'));
  });

  test('does not remove registry entry when git command fails', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .registerError('git worktree remove', {
        stderr: 'error',
        exitCode: 1,
        message: 'Command failed'
      })
      .install();

    manager.create('flow_keep', 'implementer', '/repo', 'main');
    manager._registry.get('flow_keep').status = 'failed';

    manager.remove('flow_keep');

    assert.ok(manager._registry.has('flow_keep'));
  });

  test('allows removal of worktree with status "failed"', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git worktree remove', () => '')
      .install();

    manager.create('flow_f', 'implementer', '/repo', 'main');
    manager._registry.get('flow_f').status = 'failed';

    const result = manager.remove('flow_f');
    assert.strictEqual(result.success, true);
  });

  test('allows removal of worktree with status "merged"', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git worktree remove', () => '')
      .install();

    manager.create('flow_m', 'implementer', '/repo', 'main');
    manager._registry.get('flow_m').status = 'merged';

    const result = manager.remove('flow_m');
    assert.strictEqual(result.success, true);
  });
});

describe('WorktreeManager.list()', () => {
  let mock;
  let manager;

  beforeEach(() => {
    mock = new GitMock();
    manager = new WorktreeManager({ baseDir: '/tmp/test-worktrees' });
  });

  afterEach(() => {
    mock.restore();
  });

  test('returns empty array when no worktrees registered', () => {
    const result = manager.list();
    assert.deepStrictEqual(result, []);
  });

  test('returns all registered worktrees (Req 5.4)', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_1', 'implementer', '/repo1', 'main');
    manager.create('flow_2', 'reviewer', '/repo2', 'develop');

    const result = manager.list();

    assert.strictEqual(result.length, 2);
    assert.ok(result.some(r => r.flowId === 'flow_1'));
    assert.ok(result.some(r => r.flowId === 'flow_2'));
  });

  test('each entry contains flowId, branch, repo, status (Req 5.4)', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_info', 'implementer', '/repo', 'main');

    const result = manager.list();

    assert.strictEqual(result.length, 1);
    const entry = result[0];
    assert.strictEqual(entry.flowId, 'flow_info');
    assert.strictEqual(entry.branch, 'worktree/flow_info/implementer');
    assert.strictEqual(entry.repo, '/repo');
    assert.strictEqual(entry.status, 'active');
    assert.ok(entry.path);
    assert.ok(entry.createdAt);
  });

  test('reflects status changes in registry', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_s', 'implementer', '/repo', 'main');
    manager._registry.get('flow_s').status = 'done';

    const result = manager.list();
    assert.strictEqual(result[0].status, 'done');
  });
});

describe('WorktreeManager.getPath()', () => {
  let mock;
  let manager;

  beforeEach(() => {
    mock = new GitMock();
    manager = new WorktreeManager({ baseDir: '/tmp/test-worktrees' });
  });

  afterEach(() => {
    mock.restore();
  });

  test('returns path for registered worktree', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_gp', 'implementer', '/repo', 'main');

    const result = manager.getPath('flow_gp');
    assert.ok(result);
    assert.ok(result.includes('flow_gp'));
    assert.ok(result.includes('implementer'));
  });

  test('returns null for unknown flowId', () => {
    const result = manager.getPath('nonexistent');
    assert.strictEqual(result, null);
  });

  test('returns null after worktree is removed', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .register('git worktree remove', () => '')
      .install();

    manager.create('flow_del', 'implementer', '/repo', 'main');
    manager._registry.get('flow_del').status = 'done';
    manager.remove('flow_del');

    const result = manager.getPath('flow_del');
    assert.strictEqual(result, null);
  });
});

describe('WorktreeManager.isActive()', () => {
  let mock;
  let manager;

  beforeEach(() => {
    mock = new GitMock();
    manager = new WorktreeManager({ baseDir: '/tmp/test-worktrees' });
  });

  afterEach(() => {
    mock.restore();
  });

  test('returns true for active worktree', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_act', 'implementer', '/repo', 'main');

    assert.strictEqual(manager.isActive('flow_act'), true);
  });

  test('returns false for done worktree', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_done', 'implementer', '/repo', 'main');
    manager._registry.get('flow_done').status = 'done';

    assert.strictEqual(manager.isActive('flow_done'), false);
  });

  test('returns false for failed worktree', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_fail', 'implementer', '/repo', 'main');
    manager._registry.get('flow_fail').status = 'failed';

    assert.strictEqual(manager.isActive('flow_fail'), false);
  });

  test('returns false for merged worktree', () => {
    mock
      .register('git status --porcelain', () => '')
      .register('git worktree add', () => '')
      .install();

    manager.create('flow_mrg', 'implementer', '/repo', 'main');
    manager._registry.get('flow_mrg').status = 'merged';

    assert.strictEqual(manager.isActive('flow_mrg'), false);
  });

  test('returns false for unknown flowId', () => {
    assert.strictEqual(manager.isActive('unknown'), false);
  });
});

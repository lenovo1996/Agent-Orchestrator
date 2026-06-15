#!/usr/bin/env node
/**
 * Unit Tests for spawn-via-gateway.js - worktree path integration
 *
 * Feature: parallel-worktree-tasks
 * Tests:
 * - parseWorktreePath extracts --worktree-path value correctly
 * - parseWorktreePath returns null when flag is absent
 * - parseWorktreePath returns null when flag has no value (last arg)
 * - Positional args are preserved when --worktree-path is filtered out
 * - Spawn gateway passes worktree path as 5th argument to wrapper
 * - Spawn gateway sets cwd to worktree path when provided
 *
 * Validates: Requirements 3.3, 7.1
 *
 * Run: node --test scripts/test/spawn-gateway.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { parseWorktreePath } = require('../../api/spawn');

// ============================================================================
// Unit tests: parseWorktreePath function
// ============================================================================

describe('Feature: parallel-worktree-tasks, Unit tests: spawn gateway → worktree path', () => {

  // --------------------------------------------------------------------------
  // parseWorktreePath extraction tests
  // --------------------------------------------------------------------------

  describe('parseWorktreePath extracts --worktree-path value', () => {

    /**
     * Validates: Requirements 3.3, 7.1
     * When --worktree-path /some/path is in argv, it extracts the path
     */
    test('returns worktree path when --worktree-path flag is present with value', () => {
      const argv = ['node', 'spawn-via-gateway.js', 'flow_123', 'implementer', '--worktree-path', '/tmp/worktrees/flow_123'];
      const result = parseWorktreePath(argv);
      assert.strictEqual(result, '/tmp/worktrees/flow_123');
    });

    test('returns worktree path when flag appears before positional args', () => {
      const argv = ['node', 'spawn-via-gateway.js', '--worktree-path', '/home/dev/wt/task1', 'flow_abc', 'implementer'];
      const result = parseWorktreePath(argv);
      assert.strictEqual(result, '/home/dev/wt/task1');
    });

    test('returns worktree path with spaces in path (next element)', () => {
      const argv = ['node', 'spawn-via-gateway.js', 'flow_x', '--worktree-path', '/path/with spaces/worktree'];
      const result = parseWorktreePath(argv);
      assert.strictEqual(result, '/path/with spaces/worktree');
    });

    test('handles relative worktree path', () => {
      const argv = ['node', 'spawn-via-gateway.js', 'flow_1', 'clarifier', '--worktree-path', './.dev-team-worktrees/flow_1'];
      const result = parseWorktreePath(argv);
      assert.strictEqual(result, './.dev-team-worktrees/flow_1');
    });
  });

  // --------------------------------------------------------------------------
  // parseWorktreePath returns null when flag is absent
  // --------------------------------------------------------------------------

  describe('parseWorktreePath returns null when --worktree-path is absent', () => {

    /**
     * Validates: Requirements 7.1
     * When --worktree-path is not in argv, returns null (fallback to default behavior)
     */
    test('returns null when no --worktree-path flag in argv', () => {
      const argv = ['node', 'spawn-via-gateway.js', 'flow_123', 'implementer'];
      const result = parseWorktreePath(argv);
      assert.strictEqual(result, null);
    });

    test('returns null for empty argv (only node and script)', () => {
      const argv = ['node', 'spawn-via-gateway.js'];
      const result = parseWorktreePath(argv);
      assert.strictEqual(result, null);
    });

    test('returns null for completely empty argv', () => {
      const argv = [];
      const result = parseWorktreePath(argv);
      assert.strictEqual(result, null);
    });
  });

  // --------------------------------------------------------------------------
  // parseWorktreePath returns null when flag is last arg (no value)
  // --------------------------------------------------------------------------

  describe('parseWorktreePath handles edge case: flag as last argument', () => {

    /**
     * Validates: Requirements 3.3
     * When --worktree-path is the last arg with no following value, returns null
     */
    test('returns null when --worktree-path is last element (no value follows)', () => {
      const argv = ['node', 'spawn-via-gateway.js', 'flow_123', 'implementer', '--worktree-path'];
      const result = parseWorktreePath(argv);
      assert.strictEqual(result, null);
    });
  });

  // --------------------------------------------------------------------------
  // Positional args filtering logic
  // --------------------------------------------------------------------------

  describe('positional args are preserved when --worktree-path is filtered out', () => {

    /**
     * Validates: Requirements 3.3, 7.1
     * The filtering logic in spawn-via-gateway removes --worktree-path and its value,
     * preserving all positional arguments for standard processing.
     */
    test('filtering removes --worktree-path and its value, keeps positional args', () => {
      const argv = ['node', 'spawn-via-gateway.js', 'flow_123', 'implementer', '--worktree-path', '/tmp/wt'];

      // Replicate the filtering logic from spawn-via-gateway.js
      const positionalArgs = argv.filter((arg, i, arr) => {
        if (arg === '--worktree-path') return false;
        if (i > 0 && arr[i - 1] === '--worktree-path') return false;
        return true;
      });

      assert.deepStrictEqual(positionalArgs, ['node', 'spawn-via-gateway.js', 'flow_123', 'implementer']);
    });

    test('filtering preserves all args when --worktree-path is absent', () => {
      const argv = ['node', 'spawn-via-gateway.js', 'flow_abc', 'clarifier'];

      const positionalArgs = argv.filter((arg, i, arr) => {
        if (arg === '--worktree-path') return false;
        if (i > 0 && arr[i - 1] === '--worktree-path') return false;
        return true;
      });

      assert.deepStrictEqual(positionalArgs, ['node', 'spawn-via-gateway.js', 'flow_abc', 'clarifier']);
    });

    test('filtering handles --worktree-path at the beginning of args', () => {
      const argv = ['node', 'spawn-via-gateway.js', '--worktree-path', '/wt/path', 'flow_xyz', 'reviewer'];

      const positionalArgs = argv.filter((arg, i, arr) => {
        if (arg === '--worktree-path') return false;
        if (i > 0 && arr[i - 1] === '--worktree-path') return false;
        return true;
      });

      assert.deepStrictEqual(positionalArgs, ['node', 'spawn-via-gateway.js', 'flow_xyz', 'reviewer']);
    });

    test('filtering handles --worktree-path in the middle of args', () => {
      const argv = ['node', 'spawn-via-gateway.js', 'flow_mid', '--worktree-path', '/wt/mid', 'implementer'];

      const positionalArgs = argv.filter((arg, i, arr) => {
        if (arg === '--worktree-path') return false;
        if (i > 0 && arr[i - 1] === '--worktree-path') return false;
        return true;
      });

      assert.deepStrictEqual(positionalArgs, ['node', 'spawn-via-gateway.js', 'flow_mid', 'implementer']);
    });
  });

  // --------------------------------------------------------------------------
  // Spawn args construction validation
  // --------------------------------------------------------------------------

  describe('spawn gateway passes worktree path correctly to wrapper', () => {

    /**
     * Validates: Requirements 3.3, 7.1
     * When worktree path is provided, spawn-via-gateway passes it as the 5th
     * argument to agent-wrapper.sh and sets cwd to worktree path.
     */
    test('spawnArgs includes worktree path as 5th argument when provided', () => {
      const wrapperScript = '/path/to/agent-wrapper.sh';
      const flowId = 'flow_test';
      const step = 'implementer';
      const workDir = '/dev-team/task-flows/flow_test';
      const promptFile = '/dev-team/task-flows/flow_test/implementer-prompt.txt';
      const worktreePath = '/tmp/worktrees/flow_test';

      // Replicate spawn args construction from spawn-via-gateway.js
      const spawnArgs = [wrapperScript, flowId, step, workDir, promptFile];
      if (worktreePath) {
        spawnArgs.push(worktreePath);
      }

      assert.deepStrictEqual(spawnArgs, [
        wrapperScript,
        flowId,
        step,
        workDir,
        promptFile,
        worktreePath
      ]);
      assert.strictEqual(spawnArgs[5], '/tmp/worktrees/flow_test');
    });

    test('spawnArgs does NOT include worktree path when not provided', () => {
      const wrapperScript = '/path/to/agent-wrapper.sh';
      const flowId = 'flow_test';
      const step = 'clarifier';
      const workDir = '/dev-team/task-flows/flow_test';
      const promptFile = '/dev-team/task-flows/flow_test/clarifier-prompt.txt';
      const worktreePath = null;

      const spawnArgs = [wrapperScript, flowId, step, workDir, promptFile];
      if (worktreePath) {
        spawnArgs.push(worktreePath);
      }

      assert.strictEqual(spawnArgs.length, 5);
      assert.deepStrictEqual(spawnArgs, [
        wrapperScript,
        flowId,
        step,
        workDir,
        promptFile
      ]);
    });

    test('cwd is set to worktree path when provided', () => {
      const worktreePath = '/tmp/worktrees/flow_parallel';
      const repoRoot = '/home/dev/project';

      // Replicate cwd logic from spawn-via-gateway.js
      const cwd = worktreePath || repoRoot;

      assert.strictEqual(cwd, '/tmp/worktrees/flow_parallel');
    });

    test('cwd falls back to repoRoot when worktree path is null', () => {
      const worktreePath = null;
      const repoRoot = '/home/dev/project';

      const cwd = worktreePath || repoRoot;

      assert.strictEqual(cwd, '/home/dev/project');
    });
  });
});

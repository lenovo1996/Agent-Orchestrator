#!/usr/bin/env node
/**
 * Property-Based Tests for agent-wrapper.sh logic
 *
 * Feature: parallel-worktree-tasks
 * - Property 13: Wrapper working directory selection
 * - Property 14: Wrapper log traceability
 *
 * Since the wrapper is a bash script, we simulate its parameter expansion logic
 * in JavaScript and verify the properties hold for arbitrary inputs using fast-check.
 *
 * Run: node --test .dev-team/scripts/test/wrapper.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

// ============================================================================
// Simulated wrapper logic (mirrors bash parameter expansion)
// ============================================================================

/**
 * Simulates: cd "${WORKTREE_PATH:-$REPO_ROOT}"
 *
 * In bash, ${VAR:-default} returns VAR if set and non-empty, else default.
 * This function replicates that behavior for the working directory selection.
 *
 * @param {string|null|undefined} worktreePath - WORKTREE_PATH env/arg (may be empty/null)
 * @param {string} repoRoot - REPO_ROOT fallback
 * @returns {string} effective working directory
 */
function resolveWorkingDirectory(worktreePath, repoRoot) {
  return worktreePath || repoRoot;
}

/**
 * Simulates: echo "Worktree: ${WORKTREE_PATH:-none}"
 *
 * Produces the log header line for the worktree field.
 *
 * @param {string|null|undefined} worktreePath - WORKTREE_PATH env/arg (may be empty/null)
 * @returns {string} log header line
 */
function formatWorktreeLogHeader(worktreePath) {
  return `Worktree: ${worktreePath || 'none'}`;
}

// ============================================================================
// Generators
// ============================================================================

/**
 * Generates non-empty absolute-style path strings that look like real paths.
 * These simulate valid WORKTREE_PATH values that the wrapper would receive.
 */
const nonEmptyPathArb = fc
  .tuple(
    fc.constantFrom('/tmp', '/home/dev', '/var/worktrees', '/opt/git', '..'),
    fc.stringMatching(/^[a-zA-Z0-9_.-]{1,30}$/),
    fc.stringMatching(/^[a-zA-Z0-9_.-]{1,20}$/)
  )
  .map(([base, mid, leaf]) => `${base}/${mid}/${leaf}`);

/**
 * Generates REPO_ROOT-style path strings (always non-empty absolute paths).
 */
const repoRootArb = fc
  .tuple(
    fc.constantFrom('/home/user/project', '/opt/repos/main', '/var/src/repo'),
    fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/)
  )
  .map(([base, name]) => `${base}/${name}`);

// ============================================================================
// Property 13: Wrapper working directory selection
// ============================================================================

describe('Feature: parallel-worktree-tasks, Property 13: Wrapper working directory selection', () => {

  /**
   * **Validates: Requirements 7.2**
   *
   * For any invocation of codex-agent-wrapper with a non-empty worktree path argument,
   * the Codex CLI process shall use that worktree path as its working directory
   * instead of REPO_ROOT.
   *
   * This mirrors: cd "${WORKTREE_PATH:-$REPO_ROOT}"
   * When WORKTREE_PATH is set and non-empty, the effective cwd must equal WORKTREE_PATH.
   */
  test('with worktree path arg, Codex CLI uses that path as cwd', () => {
    fc.assert(
      fc.property(
        nonEmptyPathArb,
        repoRootArb,
        (worktreePath, repoRoot) => {
          const effectiveCwd = resolveWorkingDirectory(worktreePath, repoRoot);

          // The effective cwd MUST be the worktree path, NOT repo root
          assert.strictEqual(effectiveCwd, worktreePath);
          assert.notStrictEqual(effectiveCwd, repoRoot);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * When no worktree path is provided (null/undefined/empty string),
   * the effective cwd falls back to REPO_ROOT.
   */
  test('without worktree path, falls back to REPO_ROOT', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined, ''),
        repoRootArb,
        (worktreePath, repoRoot) => {
          const effectiveCwd = resolveWorkingDirectory(worktreePath, repoRoot);
          assert.strictEqual(effectiveCwd, repoRoot);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.2**
   *
   * The resolved cwd is always one of: worktreePath (if non-empty) or repoRoot.
   * It never produces an unexpected third value.
   */
  test('resolved cwd is always either worktreePath or repoRoot', () => {
    fc.assert(
      fc.property(
        fc.oneof(nonEmptyPathArb, fc.constantFrom(null, undefined, '')),
        repoRootArb,
        (worktreePath, repoRoot) => {
          const effectiveCwd = resolveWorkingDirectory(worktreePath, repoRoot);
          const isWorktree = effectiveCwd === worktreePath;
          const isRepoRoot = effectiveCwd === repoRoot;
          assert.ok(isWorktree || isRepoRoot,
            `cwd "${effectiveCwd}" is neither worktreePath "${worktreePath}" nor repoRoot "${repoRoot}"`);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// Property 14: Wrapper log traceability
// ============================================================================

describe('Feature: parallel-worktree-tasks, Property 14: Wrapper log traceability', () => {

  /**
   * **Validates: Requirements 7.4**
   *
   * For any invocation of codex-agent-wrapper with a non-empty worktree path,
   * the log header output shall contain that worktree path.
   *
   * This mirrors: echo "Worktree: ${WORKTREE_PATH:-none}"
   * When WORKTREE_PATH is provided, the log line must contain the exact path.
   */
  test('log header contains worktree path when provided', () => {
    fc.assert(
      fc.property(
        nonEmptyPathArb,
        (worktreePath) => {
          const logLine = formatWorktreeLogHeader(worktreePath);

          // Log line must contain the exact worktree path
          assert.ok(logLine.includes(worktreePath),
            `Log line "${logLine}" does not contain worktree path "${worktreePath}"`);

          // Log line must start with expected prefix
          assert.ok(logLine.startsWith('Worktree: '),
            `Log line "${logLine}" does not start with "Worktree: " prefix`);

          // Log line must NOT contain "none" when path is provided
          assert.ok(!logLine.includes('none'),
            `Log line "${logLine}" should not contain "none" when worktree path is provided`);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.4**
   *
   * When no worktree path is provided, the log header shows "none" as a
   * placeholder, enabling traceability that no worktree was active.
   */
  test('log header shows "none" when worktree path is not provided', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined, ''),
        (worktreePath) => {
          const logLine = formatWorktreeLogHeader(worktreePath);

          assert.strictEqual(logLine, 'Worktree: none');
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.4**
   *
   * The log header format is always "Worktree: {path}" or "Worktree: none",
   * making it parseable by log aggregation tools.
   */
  test('log header always matches expected format pattern', () => {
    fc.assert(
      fc.property(
        fc.oneof(nonEmptyPathArb, fc.constantFrom(null, undefined, '')),
        (worktreePath) => {
          const logLine = formatWorktreeLogHeader(worktreePath);

          // Must always match: "Worktree: " followed by path or "none"
          assert.ok(logLine.startsWith('Worktree: '),
            `Log line "${logLine}" does not start with expected prefix`);

          const value = logLine.slice('Worktree: '.length);
          if (worktreePath) {
            assert.strictEqual(value, worktreePath);
          } else {
            assert.strictEqual(value, 'none');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

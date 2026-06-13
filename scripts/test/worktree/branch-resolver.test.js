#!/usr/bin/env node
/**
 * Property-Based Tests for BranchResolver
 *
 * Feature: parallel-worktree-tasks, Property 1: Branch naming convention
 *
 * Run: node --test .dev-team/scripts/test/branch-resolver.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { resolve } = require('../../worktree/branch-resolver');

describe('BranchResolver', () => {
  describe('Feature: parallel-worktree-tasks, Property 1: Branch naming convention', () => {
    /**
     * Property 1: Branch naming convention
     *
     * For any flow ID and step name, branch must match pattern `worktree/{flowId}/{step}`
     *
     * **Validates: Requirements 1.2**
     */
    test('For any flowId and step, resolve() returns worktree/{flowId}/{step}', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          (flowId, step, baseBranch) => {
            const result = resolve(flowId, step, baseBranch);
            const expected = `worktree/${flowId}/${step}`;
            assert.strictEqual(result, expected);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('Branch always starts with worktree/ prefix', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          (flowId, step, baseBranch) => {
            const result = resolve(flowId, step, baseBranch);
            assert.ok(
              result.startsWith('worktree/'),
              `Expected branch to start with "worktree/", got "${result}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    test('Branch contains exactly the flowId and step in correct positions', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          (flowId, step, baseBranch) => {
            const result = resolve(flowId, step, baseBranch);
            // Parse the result to extract components
            const withoutPrefix = result.slice('worktree/'.length);
            const expectedSuffix = `${flowId}/${step}`;
            assert.strictEqual(
              withoutPrefix, expectedSuffix,
              `After "worktree/" prefix, expected "${expectedSuffix}", got "${withoutPrefix}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    test('baseBranch parameter does not affect the output branch name', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          (flowId, step, baseBranch1, baseBranch2) => {
            const result1 = resolve(flowId, step, baseBranch1);
            const result2 = resolve(flowId, step, baseBranch2);
            assert.strictEqual(
              result1, result2,
              `Branch should not depend on baseBranch. Got "${result1}" vs "${result2}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

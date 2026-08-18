#!/usr/bin/env node
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { parseArgs } = require('../../worktree/cli');

describe('worktree CLI argument parsing', () => {
  test('parses retained list and cleanup commands', () => {
    assert.deepStrictEqual(parseArgs(['list']), { command: 'list', args: [], options: {} });
    assert.deepStrictEqual(parseArgs(['cleanup']), { command: 'cleanup', args: [], options: {} });
  });

  test('parses merge options', () => {
    assert.deepStrictEqual(
      parseArgs(['merge', 'flow_1', '--target', 'develop', '--dry-run']),
      { command: 'merge', args: ['flow_1'], options: { target: 'develop', 'dry-run': true } },
    );
  });

  test('defaults to help', () => {
    assert.deepStrictEqual(parseArgs([]), { command: 'help', args: [], options: {} });
  });
});

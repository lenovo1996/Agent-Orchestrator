/**
 * Unit tests for ParallelScheduler edge cases (Task 5.6)
 *
 * Tests:
 * - Dequeue timing (synchronous dequeue after onTaskComplete/onTaskFailed)
 * - Queue at max capacity (100 tasks at maxConcurrency=1)
 * - Corrupt status file recovery
 * - Task spawn failure handling (onTaskComplete/onTaskFailed for non-existent flowId)
 *
 * Requirements: 2.4
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ParallelScheduler } = require('../lib/parallel-scheduler');

describe('ParallelScheduler - Edge Cases', () => {
  describe('Dequeue timing (Requirement 2.4)', () => {
    it('dequeues next task synchronously after onTaskComplete', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 1,
        statusFile: '/dev/null',
      });

      scheduler.schedule('flow-1', 'implementer', 'repo-a');
      scheduler.schedule('flow-2', 'implementer', 'repo-b');

      // flow-2 should be queued
      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getQueue().length, 1);

      // After completing flow-1, flow-2 should be immediately in running
      scheduler.onTaskComplete('flow-1');

      const running = scheduler.getRunning();
      assert.equal(running.length, 1);
      assert.equal(running[0].flowId, 'flow-2');
      assert.equal(running[0].status, 'running');
      assert.ok(running[0].startedAt, 'startedAt should be set immediately');
      assert.equal(scheduler.getQueue().length, 0);
    });

    it('dequeues next task synchronously after onTaskFailed', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 1,
        statusFile: '/dev/null',
      });

      scheduler.schedule('flow-1', 'implementer', 'repo-a');
      scheduler.schedule('flow-2', 'implementer', 'repo-b');

      scheduler.onTaskFailed('flow-1');

      const running = scheduler.getRunning();
      assert.equal(running.length, 1);
      assert.equal(running[0].flowId, 'flow-2');
      assert.equal(running[0].status, 'running');
      assert.ok(running[0].startedAt, 'startedAt should be set immediately');
      assert.equal(scheduler.getQueue().length, 0);
    });

    it('dequeued task has startedAt timestamp set', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 1,
        statusFile: '/dev/null',
      });

      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');

      const beforeComplete = new Date().toISOString();
      scheduler.onTaskComplete('flow-1');

      const running = scheduler.getRunning();
      assert.equal(running[0].flowId, 'flow-2');
      // startedAt should be a valid ISO timestamp
      const startedAt = new Date(running[0].startedAt);
      assert.ok(!isNaN(startedAt.getTime()), 'startedAt should be a valid date');
    });

    it('multiple dequeues happen synchronously in sequence', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 2,
        statusFile: '/dev/null',
      });

      // Fill slots and queue more
      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');
      scheduler.schedule('flow-3', 'step', 'repo');
      scheduler.schedule('flow-4', 'step', 'repo');

      assert.equal(scheduler.getRunning().length, 2);
      assert.equal(scheduler.getQueue().length, 2);

      // Complete flow-1: flow-3 dequeued immediately
      scheduler.onTaskComplete('flow-1');
      assert.equal(scheduler.getRunning().length, 2);
      const runningIds = scheduler.getRunning().map(t => t.flowId);
      assert.ok(runningIds.includes('flow-2'));
      assert.ok(runningIds.includes('flow-3'));
      assert.equal(scheduler.getQueue().length, 1);
    });
  });

  describe('Queue at max capacity (Requirement 2.4)', () => {
    it('handles 100 queued tasks at maxConcurrency=1', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 1,
        statusFile: '/dev/null',
      });

      // Schedule 100 tasks
      for (let i = 1; i <= 100; i++) {
        scheduler.schedule(`flow-${i}`, 'implementer', 'repo');
      }

      // Only first task should be running
      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getRunning()[0].flowId, 'flow-1');
      assert.equal(scheduler.getQueue().length, 99);
    });

    it('preserves FIFO order when draining 100 queued tasks', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 1,
        statusFile: '/dev/null',
      });

      for (let i = 1; i <= 100; i++) {
        scheduler.schedule(`flow-${i}`, 'implementer', 'repo');
      }

      // Drain all tasks in order
      for (let i = 1; i <= 100; i++) {
        assert.equal(scheduler.getRunning()[0].flowId, `flow-${i}`);
        scheduler.onTaskComplete(`flow-${i}`);
      }

      // All tasks should be completed
      assert.equal(scheduler.getRunning().length, 0);
      assert.equal(scheduler.getQueue().length, 0);
      assert.equal(scheduler.getStatus().completed.length, 100);
    });

    it('all queued tasks maintain correct status', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 1,
        statusFile: '/dev/null',
      });

      for (let i = 1; i <= 50; i++) {
        scheduler.schedule(`flow-${i}`, 'implementer', 'repo');
      }

      const queue = scheduler.getQueue();
      for (const task of queue) {
        assert.equal(task.status, 'queued');
        assert.ok(task.queuedAt);
        assert.equal(task.startedAt, undefined);
      }
    });
  });

  describe('Corrupt status file recovery (Requirement 2.6)', () => {
    let tmpFile;

    beforeEach(() => {
      tmpFile = path.join(os.tmpdir(), `parallel-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    });

    afterEach(() => {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {
        // Ignore if already cleaned up
      }
    });

    it('recovers with empty state when status file contains garbage text', () => {
      fs.writeFileSync(tmpFile, 'this is not json at all!!!', 'utf8');

      const scheduler = new ParallelScheduler({
        maxConcurrency: 2,
        statusFile: tmpFile,
      });
      scheduler.recover();

      assert.deepEqual(scheduler.getRunning(), []);
      assert.deepEqual(scheduler.getQueue(), []);
      assert.deepEqual(scheduler.getStatus().completed, []);
    });

    it('recovers with empty state when status file contains partial JSON', () => {
      fs.writeFileSync(tmpFile, '{"running": [{"flowId": "x"', 'utf8');

      const scheduler = new ParallelScheduler({
        maxConcurrency: 2,
        statusFile: tmpFile,
      });
      scheduler.recover();

      assert.deepEqual(scheduler.getRunning(), []);
      assert.deepEqual(scheduler.getQueue(), []);
    });

    it('recovers with empty state when status file contains binary data', () => {
      fs.writeFileSync(tmpFile, Buffer.from([0x00, 0xFF, 0xFE, 0x89, 0x50, 0x4E, 0x47]));

      const scheduler = new ParallelScheduler({
        maxConcurrency: 2,
        statusFile: tmpFile,
      });
      scheduler.recover();

      assert.deepEqual(scheduler.getRunning(), []);
      assert.deepEqual(scheduler.getQueue(), []);
    });

    it('recovers with empty state when status file does not exist', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 2,
        statusFile: '/tmp/non-existent-file-xyz-abc-123.json',
      });
      scheduler.recover();

      assert.deepEqual(scheduler.getRunning(), []);
      assert.deepEqual(scheduler.getQueue(), []);
    });

    it('scheduler is fully functional after recovering from corrupt file', () => {
      fs.writeFileSync(tmpFile, '!@#$%^&*()', 'utf8');

      const scheduler = new ParallelScheduler({
        maxConcurrency: 2,
        statusFile: tmpFile,
      });
      scheduler.recover();

      // Scheduler should work normally after recovery
      const task = scheduler.schedule('flow-new', 'implementer', 'repo');
      assert.equal(task.status, 'running');
      assert.equal(scheduler.getRunning().length, 1);
    });
  });

  describe('Task spawn failure handling (Requirement 2.4)', () => {
    it('onTaskComplete is a no-op for non-existent flowId', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 2,
        statusFile: '/dev/null',
      });

      scheduler.schedule('flow-1', 'step', 'repo');

      // Calling onTaskComplete with a flowId that doesn't exist in running
      scheduler.onTaskComplete('non-existent-flow');

      // State should be unchanged
      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getRunning()[0].flowId, 'flow-1');
      assert.equal(scheduler.getStatus().completed.length, 0);
    });

    it('onTaskFailed is a no-op for non-existent flowId', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 2,
        statusFile: '/dev/null',
      });

      scheduler.schedule('flow-1', 'step', 'repo');

      // Calling onTaskFailed with a flowId that doesn't exist in running
      scheduler.onTaskFailed('non-existent-flow');

      // State should be unchanged
      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getRunning()[0].flowId, 'flow-1');
      assert.equal(scheduler.getStatus().completed.length, 0);
    });

    it('onTaskComplete for queued flowId does not affect state', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 1,
        statusFile: '/dev/null',
      });

      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo'); // queued

      // Try to complete a queued task (not in running)
      scheduler.onTaskComplete('flow-2');

      // State should be unchanged
      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getRunning()[0].flowId, 'flow-1');
      assert.equal(scheduler.getQueue().length, 1);
      assert.equal(scheduler.getQueue()[0].flowId, 'flow-2');
      assert.equal(scheduler.getStatus().completed.length, 0);
    });

    it('onTaskFailed for queued flowId does not affect state', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 1,
        statusFile: '/dev/null',
      });

      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo'); // queued

      // Try to fail a queued task (not in running)
      scheduler.onTaskFailed('flow-2');

      // State should be unchanged
      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getQueue().length, 1);
      assert.equal(scheduler.getStatus().completed.length, 0);
    });

    it('onTaskComplete does not dequeue when called with non-existent flowId', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 1,
        statusFile: '/dev/null',
      });

      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');

      // Non-existent flow should not trigger dequeue
      scheduler.onTaskComplete('ghost-flow');

      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getRunning()[0].flowId, 'flow-1');
      assert.equal(scheduler.getQueue().length, 1);
    });

    it('repeated onTaskComplete calls for same flowId are no-ops after first', () => {
      const scheduler = new ParallelScheduler({
        maxConcurrency: 2,
        statusFile: '/dev/null',
      });

      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');

      scheduler.onTaskComplete('flow-1');
      assert.equal(scheduler.getStatus().completed.length, 1);

      // Second call should be no-op (flow-1 is no longer in running)
      scheduler.onTaskComplete('flow-1');
      assert.equal(scheduler.getStatus().completed.length, 1);
      assert.equal(scheduler.getRunning().length, 1);
    });
  });
});

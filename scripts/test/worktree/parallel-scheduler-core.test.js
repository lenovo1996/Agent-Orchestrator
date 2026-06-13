/**
 * Unit tests for ParallelScheduler core scheduling logic (Task 5.1)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ParallelScheduler } = require('../../worktree/parallel-scheduler');

describe('ParallelScheduler - Core Scheduling', () => {
  describe('constructor', () => {
    it('uses default maxConcurrency of 3', () => {
      const scheduler = new ParallelScheduler();
      assert.equal(scheduler.maxConcurrency, 3);
    });

    it('accepts custom maxConcurrency', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 5 });
      assert.equal(scheduler.maxConcurrency, 5);
    });

    it('starts with empty running, queue, and completed', () => {
      const scheduler = new ParallelScheduler();
      assert.deepEqual(scheduler.getRunning(), []);
      assert.deepEqual(scheduler.getQueue(), []);
      assert.deepEqual(scheduler.getStatus().completed, []);
    });
  });

  describe('schedule()', () => {
    it('adds to running when slots available', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 2 });
      const task = scheduler.schedule('flow-1', 'implementer', 'repo-a');

      assert.equal(task.status, 'running');
      assert.equal(task.flowId, 'flow-1');
      assert.equal(task.step, 'implementer');
      assert.equal(task.repo, 'repo-a');
      assert.ok(task.startedAt);
      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getQueue().length, 0);
    });

    it('queues task when all slots are full', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 1 });
      scheduler.schedule('flow-1', 'implementer', 'repo-a');
      const task = scheduler.schedule('flow-2', 'implementer', 'repo-b');

      assert.equal(task.status, 'queued');
      assert.equal(task.flowId, 'flow-2');
      assert.ok(task.queuedAt);
      assert.equal(task.startedAt, undefined);
      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getQueue().length, 1);
    });

    it('fills all concurrency slots before queuing', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 3 });
      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');
      scheduler.schedule('flow-3', 'step', 'repo');
      scheduler.schedule('flow-4', 'step', 'repo');

      assert.equal(scheduler.getRunning().length, 3);
      assert.equal(scheduler.getQueue().length, 1);
    });
  });

  describe('onTaskComplete()', () => {
    it('moves task from running to completed with status done', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 2 });
      scheduler.schedule('flow-1', 'implementer', 'repo-a');

      scheduler.onTaskComplete('flow-1');

      assert.equal(scheduler.getRunning().length, 0);
      const status = scheduler.getStatus();
      assert.equal(status.completed.length, 1);
      assert.equal(status.completed[0].status, 'done');
      assert.equal(status.completed[0].flowId, 'flow-1');
      assert.ok(status.completed[0].completedAt);
    });

    it('dequeues next task after completion', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 1 });
      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');

      assert.equal(scheduler.getQueue().length, 1);
      scheduler.onTaskComplete('flow-1');

      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getRunning()[0].flowId, 'flow-2');
      assert.equal(scheduler.getRunning()[0].status, 'running');
      assert.ok(scheduler.getRunning()[0].startedAt);
      assert.equal(scheduler.getQueue().length, 0);
    });

    it('does nothing if flowId not found in running', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 2 });
      scheduler.schedule('flow-1', 'step', 'repo');

      scheduler.onTaskComplete('non-existent');

      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getStatus().completed.length, 0);
    });
  });

  describe('onTaskFailed()', () => {
    it('moves task from running to completed with status failed', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 2 });
      scheduler.schedule('flow-1', 'implementer', 'repo-a');

      scheduler.onTaskFailed('flow-1');

      assert.equal(scheduler.getRunning().length, 0);
      const status = scheduler.getStatus();
      assert.equal(status.completed.length, 1);
      assert.equal(status.completed[0].status, 'failed');
      assert.equal(status.completed[0].flowId, 'flow-1');
      assert.ok(status.completed[0].completedAt);
    });

    it('dequeues next task after failure', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 1 });
      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');

      scheduler.onTaskFailed('flow-1');

      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getRunning()[0].flowId, 'flow-2');
      assert.equal(scheduler.getQueue().length, 0);
    });

    it('does nothing if flowId not found in running', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 2 });
      scheduler.schedule('flow-1', 'step', 'repo');

      scheduler.onTaskFailed('non-existent');

      assert.equal(scheduler.getRunning().length, 1);
      assert.equal(scheduler.getStatus().completed.length, 0);
    });
  });

  describe('getQueue()', () => {
    it('returns a copy (not a reference) of the queue', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 1 });
      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');

      const queue = scheduler.getQueue();
      queue.push({ flowId: 'fake' });

      assert.equal(scheduler.getQueue().length, 1);
    });

    it('maintains FIFO order', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 1 });
      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');
      scheduler.schedule('flow-3', 'step', 'repo');
      scheduler.schedule('flow-4', 'step', 'repo');

      const queue = scheduler.getQueue();
      assert.equal(queue[0].flowId, 'flow-2');
      assert.equal(queue[1].flowId, 'flow-3');
      assert.equal(queue[2].flowId, 'flow-4');
    });
  });

  describe('getRunning()', () => {
    it('returns a copy (not a reference) of running', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 3 });
      scheduler.schedule('flow-1', 'step', 'repo');

      const running = scheduler.getRunning();
      running.push({ flowId: 'fake' });

      assert.equal(scheduler.getRunning().length, 1);
    });
  });

  describe('getStatus()', () => {
    it('returns full status object with all fields', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 2 });
      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');
      scheduler.schedule('flow-3', 'step', 'repo');
      scheduler.onTaskComplete('flow-1');

      const status = scheduler.getStatus();
      assert.equal(status.maxConcurrency, 2);
      assert.equal(status.running.length, 2);
      assert.equal(status.queue.length, 0);
      assert.equal(status.completed.length, 1);
      assert.ok(status.lastUpdated);
    });
  });

  describe('FIFO dequeue ordering', () => {
    it('dequeues in exact enqueue order', () => {
      const scheduler = new ParallelScheduler({ maxConcurrency: 1 });
      scheduler.schedule('flow-1', 'step', 'repo');
      scheduler.schedule('flow-2', 'step', 'repo');
      scheduler.schedule('flow-3', 'step', 'repo');
      scheduler.schedule('flow-4', 'step', 'repo');

      // Complete flow-1: flow-2 should be dequeued
      scheduler.onTaskComplete('flow-1');
      assert.equal(scheduler.getRunning()[0].flowId, 'flow-2');

      // Complete flow-2: flow-3 should be dequeued
      scheduler.onTaskComplete('flow-2');
      assert.equal(scheduler.getRunning()[0].flowId, 'flow-3');

      // Complete flow-3: flow-4 should be dequeued
      scheduler.onTaskComplete('flow-3');
      assert.equal(scheduler.getRunning()[0].flowId, 'flow-4');
    });
  });
});

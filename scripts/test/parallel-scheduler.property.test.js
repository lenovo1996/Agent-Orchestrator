#!/usr/bin/env node
/**
 * Property-Based Tests for ParallelScheduler
 *
 * Feature: parallel-worktree-tasks, Property 2: Concurrency invariant
 *
 * Run: node --test .dev-team/scripts/test/parallel-scheduler.property.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { ParallelScheduler } = require('../lib/parallel-scheduler');

describe('Feature: parallel-worktree-tasks, Property 2: Concurrency invariant', () => {
  /**
   * **Validates: Requirements 2.1**
   *
   * For any sequence of schedule and complete/fail events, the number of tasks
   * in "running" state shall never exceed the configured maxConcurrency value.
   * This is checked after every single event in the sequence.
   */
  test('number of running tasks never exceeds maxConcurrency for any event sequence', () => {
    // Generator for maxConcurrency values to test
    const maxConcurrencyArb = fc.constantFrom(1, 2, 3, 5);

    // Generator for a sequence of schedule/complete/fail events
    const eventArb = fc.oneof(
      fc.record({
        type: fc.constant('schedule'),
        flowId: fc.stringMatching(/^flow_[a-z0-9]{1,8}$/),
        step: fc.constantFrom('implementer', 'reviewer', 'qa'),
        repo: fc.constantFrom('repo-a', 'repo-b', 'repo-c')
      }),
      fc.record({
        type: fc.constant('complete'),
        flowId: fc.stringMatching(/^flow_[a-z0-9]{1,8}$/)
      }),
      fc.record({
        type: fc.constant('fail'),
        flowId: fc.stringMatching(/^flow_[a-z0-9]{1,8}$/)
      })
    );

    const eventsArb = fc.array(eventArb, { minLength: 1, maxLength: 50 });

    fc.assert(
      fc.property(maxConcurrencyArb, eventsArb, (maxConcurrency, events) => {
        const scheduler = new ParallelScheduler({
          maxConcurrency,
          statusFile: '/dev/null'
        });

        for (const event of events) {
          switch (event.type) {
            case 'schedule':
              scheduler.schedule(event.flowId, event.step, event.repo);
              break;
            case 'complete':
              scheduler.onTaskComplete(event.flowId);
              break;
            case 'fail':
              scheduler.onTaskFailed(event.flowId);
              break;
          }

          // After every event, the invariant must hold
          const runningCount = scheduler.getRunning().length;
          assert.ok(
            runningCount <= maxConcurrency,
            `Running count (${runningCount}) exceeded maxConcurrency (${maxConcurrency}) after event: ${JSON.stringify(event)}`
          );
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });

  test('concurrency invariant holds when all events target distinct flowIds', () => {
    // This variant ensures unique flowIds for schedule events so that
    // complete/fail always targets real running tasks
    const maxConcurrencyArb = fc.constantFrom(1, 2, 3, 5);

    fc.assert(
      fc.property(
        maxConcurrencyArb,
        fc.integer({ min: 5, max: 30 }),
        (maxConcurrency, numTasks) => {
          const scheduler = new ParallelScheduler({
            maxConcurrency,
            statusFile: '/dev/null'
          });

          const scheduledFlowIds = [];

          // Schedule numTasks tasks with unique flowIds
          for (let i = 0; i < numTasks; i++) {
            const flowId = `flow_${i}`;
            scheduler.schedule(flowId, 'implementer', 'repo');
            scheduledFlowIds.push(flowId);

            // Invariant check after each schedule
            const runningCount = scheduler.getRunning().length;
            assert.ok(
              runningCount <= maxConcurrency,
              `After scheduling ${i + 1} tasks: running (${runningCount}) > maxConcurrency (${maxConcurrency})`
            );
          }

          // Now complete tasks one by one in order and verify invariant
          for (const flowId of scheduledFlowIds) {
            scheduler.onTaskComplete(flowId);

            const runningCount = scheduler.getRunning().length;
            assert.ok(
              runningCount <= maxConcurrency,
              `After completing ${flowId}: running (${runningCount}) > maxConcurrency (${maxConcurrency})`
            );
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  test('concurrency invariant holds with interleaved schedule and fail events', () => {
    const maxConcurrencyArb = fc.constantFrom(1, 2, 3, 5);

    // Generate a sequence where we schedule several tasks, then randomly
    // fail some running tasks, then schedule more
    const roundArb = fc.record({
      scheduleCount: fc.integer({ min: 1, max: 10 }),
      failCount: fc.integer({ min: 0, max: 5 })
    });
    const roundsArb = fc.array(roundArb, { minLength: 1, maxLength: 10 });

    fc.assert(
      fc.property(maxConcurrencyArb, roundsArb, (maxConcurrency, rounds) => {
        const scheduler = new ParallelScheduler({
          maxConcurrency,
          statusFile: '/dev/null'
        });

        let taskCounter = 0;

        for (const round of rounds) {
          // Schedule tasks
          for (let i = 0; i < round.scheduleCount; i++) {
            scheduler.schedule(`flow_${taskCounter++}`, 'step', 'repo');

            const runningCount = scheduler.getRunning().length;
            assert.ok(
              runningCount <= maxConcurrency,
              `After schedule: running (${runningCount}) > maxConcurrency (${maxConcurrency})`
            );
          }

          // Fail some running tasks
          const running = scheduler.getRunning();
          const toFail = Math.min(round.failCount, running.length);
          for (let i = 0; i < toFail; i++) {
            scheduler.onTaskFailed(running[i].flowId);

            const runningCount = scheduler.getRunning().length;
            assert.ok(
              runningCount <= maxConcurrency,
              `After fail: running (${runningCount}) > maxConcurrency (${maxConcurrency})`
            );
          }
        }

        return true;
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: parallel-worktree-tasks, Property 4: FIFO queue ordering', () => {
  /**
   * **Validates: Requirements 2.3**
   *
   * For any sequence of tasks enqueued when the scheduler is at capacity,
   * dequeue order shall match enqueue order exactly (first-in, first-out).
   *
   * Strategy: set maxConcurrency=1 to force queueing, schedule N tasks with
   * unique flowIds, then complete them one by one. The order in which tasks
   * appear in running state must match the original schedule order.
   */
  test('dequeue order matches enqueue order exactly (maxConcurrency=1)', () => {
    // Generate arrays of unique flow IDs (between 2 and 30 tasks)
    const flowIdsArb = fc.array(
      fc.stringMatching(/^flow_[a-z0-9]{1,8}$/),
      { minLength: 2, maxLength: 30 }
    ).map(ids => [...new Set(ids)]).filter(ids => ids.length >= 2);

    fc.assert(
      fc.property(flowIdsArb, (flowIds) => {
        const scheduler = new ParallelScheduler({
          maxConcurrency: 1,
          statusFile: '/dev/null'
        });

        // Schedule all tasks — the first one runs immediately, rest get queued
        for (const flowId of flowIds) {
          scheduler.schedule(flowId, 'implementer', 'repo');
        }

        // The first task should be running
        const running = scheduler.getRunning();
        assert.strictEqual(running.length, 1);
        assert.strictEqual(running[0].flowId, flowIds[0]);

        // The queue should contain remaining tasks in FIFO order
        const queue = scheduler.getQueue();
        assert.strictEqual(queue.length, flowIds.length - 1);
        for (let i = 0; i < queue.length; i++) {
          assert.strictEqual(
            queue[i].flowId,
            flowIds[i + 1],
            `Queue position ${i}: expected ${flowIds[i + 1]} but got ${queue[i].flowId}`
          );
        }

        // Complete tasks one by one and verify dequeue order
        const startupOrder = [flowIds[0]];
        for (let i = 0; i < flowIds.length - 1; i++) {
          const currentRunning = scheduler.getRunning();
          assert.strictEqual(currentRunning.length, 1);

          // Complete the current running task
          scheduler.onTaskComplete(currentRunning[0].flowId);

          // Next task should now be running (if any remain)
          const nextRunning = scheduler.getRunning();
          if (i < flowIds.length - 2) {
            assert.strictEqual(nextRunning.length, 1);
            startupOrder.push(nextRunning[0].flowId);
          }
        }

        // Verify the full startup order matches the original schedule order
        assert.deepStrictEqual(
          startupOrder,
          flowIds.slice(0, startupOrder.length),
          'Startup order must match schedule order (FIFO)'
        );
      }),
      { numRuns: 100 }
    );
  });

  test('FIFO ordering preserved when tasks are completed or failed interchangeably', () => {
    // Generate unique flow IDs and a sequence of complete/fail decisions
    const flowIdsArb = fc.array(
      fc.stringMatching(/^flow_[a-z0-9]{1,8}$/),
      { minLength: 3, maxLength: 20 }
    ).map(ids => [...new Set(ids)]).filter(ids => ids.length >= 3);

    const completionTypeArb = fc.array(
      fc.constantFrom('complete', 'fail'),
      { minLength: 20, maxLength: 20 }
    );

    fc.assert(
      fc.property(flowIdsArb, completionTypeArb, (flowIds, completionTypes) => {
        const scheduler = new ParallelScheduler({
          maxConcurrency: 1,
          statusFile: '/dev/null'
        });

        // Schedule all tasks
        for (const flowId of flowIds) {
          scheduler.schedule(flowId, 'step', 'repo');
        }

        // Process tasks one by one, using complete or fail randomly
        const startupOrder = [];
        const initialRunning = scheduler.getRunning();
        if (initialRunning.length > 0) {
          startupOrder.push(initialRunning[0].flowId);
        }

        for (let i = 0; i < flowIds.length - 1; i++) {
          const currentRunning = scheduler.getRunning();
          if (currentRunning.length === 0) break;

          const action = completionTypes[i % completionTypes.length];
          if (action === 'complete') {
            scheduler.onTaskComplete(currentRunning[0].flowId);
          } else {
            scheduler.onTaskFailed(currentRunning[0].flowId);
          }

          // Record next dequeued task
          const nextRunning = scheduler.getRunning();
          if (nextRunning.length > 0) {
            startupOrder.push(nextRunning[0].flowId);
          }
        }

        // The startup order must exactly match the original schedule order
        assert.deepStrictEqual(
          startupOrder,
          flowIds.slice(0, startupOrder.length),
          'FIFO ordering must be preserved regardless of complete/fail'
        );
      }),
      { numRuns: 100 }
    );
  });
});


describe('Feature: parallel-worktree-tasks, Property 5: Scheduler state round-trip', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  let tempFiles = [];

  function createTempStatusFile() {
    const tmpFile = path.join(
      os.tmpdir(),
      `parallel-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    tempFiles.push(tmpFile);
    return tmpFile;
  }

  // Clean up temp files after each test
  const { afterEach } = require('node:test');
  afterEach(() => {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    tempFiles = [];
  });

  /**
   * **Validates: Requirements 2.5, 2.6**
   *
   * For any valid scheduler state (running tasks + queue + completed),
   * writing it to a file via _save() and then recovering from that file
   * via recover() on a new instance shall produce an equivalent state.
   *
   * Strategy: generate random maxConcurrency and a sequence of schedule/complete/fail
   * actions to build up realistic state, then create a new scheduler instance pointing
   * to the same statusFile and call recover(). Compare running, queue, and completed
   * lists between the two instances.
   */
  test('write to file then recover produces equivalent state', () => {
    const maxConcurrencyArb = fc.integer({ min: 1, max: 5 });

    // Generate a sequence of actions to build realistic scheduler state
    const actionArb = fc.oneof(
      fc.record({
        type: fc.constant('schedule'),
        flowId: fc.stringMatching(/^flow_[a-z0-9]{1,6}$/),
        step: fc.constantFrom('implementer', 'reviewer', 'qa', 'planner'),
        repo: fc.constantFrom('repo-a', 'repo-b', 'repo-c')
      }),
      fc.record({
        type: fc.constant('complete'),
      }),
      fc.record({
        type: fc.constant('fail'),
      })
    );

    // Ensure at least one schedule action exists so _save() is called at least once
    const firstScheduleArb = fc.record({
      type: fc.constant('schedule'),
      flowId: fc.stringMatching(/^flow_[a-z0-9]{1,6}$/),
      step: fc.constantFrom('implementer', 'reviewer', 'qa', 'planner'),
      repo: fc.constantFrom('repo-a', 'repo-b', 'repo-c')
    });

    const actionsArb = fc.array(actionArb, { minLength: 0, maxLength: 29 });

    fc.assert(
      fc.property(maxConcurrencyArb, firstScheduleArb, actionsArb, (maxConcurrency, firstAction, remainingActions) => {
        const actions = [firstAction, ...remainingActions];
        const statusFile = createTempStatusFile();

        // Create first scheduler and build up state
        const scheduler1 = new ParallelScheduler({
          maxConcurrency,
          statusFile
        });

        // Apply actions to build realistic state
        const scheduledFlowIds = [];
        for (const action of actions) {
          switch (action.type) {
            case 'schedule':
              scheduler1.schedule(action.flowId, action.step, action.repo);
              scheduledFlowIds.push(action.flowId);
              break;
            case 'complete': {
              const running = scheduler1.getRunning();
              if (running.length > 0) {
                scheduler1.onTaskComplete(running[0].flowId);
              }
              break;
            }
            case 'fail': {
              const running = scheduler1.getRunning();
              if (running.length > 0) {
                scheduler1.onTaskFailed(running[0].flowId);
              }
              break;
            }
          }
        }

        // Get state from scheduler1 after all actions
        const running1 = scheduler1.getRunning();
        const queue1 = scheduler1.getQueue();
        const status1 = scheduler1.getStatus();

        // Create a NEW scheduler instance pointing to same statusFile
        const scheduler2 = new ParallelScheduler({
          maxConcurrency: 99, // Use different default to prove recover() restores it
          statusFile
        });

        // Recover state from the file
        scheduler2.recover();

        // Get state from scheduler2 after recovery
        const running2 = scheduler2.getRunning();
        const queue2 = scheduler2.getQueue();
        const status2 = scheduler2.getStatus();

        // Verify running tasks match
        assert.strictEqual(
          running2.length,
          running1.length,
          `Running count mismatch: original=${running1.length}, recovered=${running2.length}`
        );

        for (let i = 0; i < running1.length; i++) {
          assert.strictEqual(running2[i].flowId, running1[i].flowId,
            `Running task ${i} flowId mismatch`);
          assert.strictEqual(running2[i].step, running1[i].step,
            `Running task ${i} step mismatch`);
          assert.strictEqual(running2[i].repo, running1[i].repo,
            `Running task ${i} repo mismatch`);
          assert.strictEqual(running2[i].status, running1[i].status,
            `Running task ${i} status mismatch`);
        }

        // Verify queue matches
        assert.strictEqual(
          queue2.length,
          queue1.length,
          `Queue count mismatch: original=${queue1.length}, recovered=${queue2.length}`
        );

        for (let i = 0; i < queue1.length; i++) {
          assert.strictEqual(queue2[i].flowId, queue1[i].flowId,
            `Queue task ${i} flowId mismatch`);
          assert.strictEqual(queue2[i].step, queue1[i].step,
            `Queue task ${i} step mismatch`);
          assert.strictEqual(queue2[i].repo, queue1[i].repo,
            `Queue task ${i} repo mismatch`);
          assert.strictEqual(queue2[i].status, queue1[i].status,
            `Queue task ${i} status mismatch`);
        }

        // Verify completed tasks match
        assert.strictEqual(
          status2.completed.length,
          status1.completed.length,
          `Completed count mismatch: original=${status1.completed.length}, recovered=${status2.completed.length}`
        );

        for (let i = 0; i < status1.completed.length; i++) {
          assert.strictEqual(status2.completed[i].flowId, status1.completed[i].flowId,
            `Completed task ${i} flowId mismatch`);
          assert.strictEqual(status2.completed[i].status, status1.completed[i].status,
            `Completed task ${i} status mismatch`);
        }

        // Verify maxConcurrency is recovered
        assert.strictEqual(
          status2.maxConcurrency,
          maxConcurrency,
          `maxConcurrency mismatch: expected ${maxConcurrency}, got ${status2.maxConcurrency}`
        );

        return true;
      }),
      { numRuns: 100 }
    );
  });

  test('recover from non-existent file produces empty state', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (maxConcurrency) => {
          const statusFile = path.join(
            os.tmpdir(),
            `nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
          );

          const scheduler = new ParallelScheduler({
            maxConcurrency,
            statusFile
          });

          scheduler.recover();

          assert.strictEqual(scheduler.getRunning().length, 0,
            'Running should be empty after recovering from non-existent file');
          assert.strictEqual(scheduler.getQueue().length, 0,
            'Queue should be empty after recovering from non-existent file');
          assert.strictEqual(scheduler.getStatus().completed.length, 0,
            'Completed should be empty after recovering from non-existent file');

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

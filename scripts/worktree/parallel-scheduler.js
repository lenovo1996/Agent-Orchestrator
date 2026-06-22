/**
 * lib/parallel-scheduler.js — Parallel task scheduler
 *
 * Manages scheduling and distribution of parallel tasks with
 * configurable concurrency limits and FIFO queue ordering.
 *
 * Exports: ParallelScheduler
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @typedef {Object} ParallelTask
 * @property {string} flowId
 * @property {string} step
 * @property {string} repo
 * @property {'queued'|'running'|'done'|'failed'} status
 * @property {string[]} [dependsOn]
 * @property {string} [worktreePath]
 * @property {string} queuedAt
 * @property {string} [startedAt]
 * @property {string} [completedAt]
 */

/**
 * @typedef {Object} SchedulerConfig
 * @property {number} maxConcurrency - Maximum concurrent tasks (default: 3)
 */

/**
 * @typedef {Object} ParallelStatus
 * @property {number} maxConcurrency
 * @property {ParallelTask[]} running
 * @property {ParallelTask[]} queue
 * @property {ParallelTask[]} completed
 * @property {string} lastUpdated
 */

class ParallelScheduler {
  /**
   * @param {SchedulerConfig} config
   */
  constructor(config = {}) {
    this.maxConcurrency = config.maxConcurrency || 3;
    this.statusFile = config.statusFile || path.resolve(__dirname, '../../parallel-status.json');
    this._running = [];
    this._queue = [];
    this._completed = [];
  }

  /**
   * Schedule a task for execution.
   * If a concurrency slot is available and dependencies are met, the task is added to running immediately.
   * Otherwise it is enqueued.
   * @param {string} flowId
   * @param {string} step
   * @param {string} repo
   * @param {string[]} [dependsOn]
   * @returns {ParallelTask}
   */
  schedule(flowId, step, repo, dependsOn = []) {
    const now = new Date().toISOString();

    /** @type {ParallelTask} */
    const task = {
      flowId,
      step,
      repo,
      dependsOn: Array.isArray(dependsOn) ? [...dependsOn] : [],
      status: 'queued',
      queuedAt: now,
    };

    this._queue.push(task);
    this._dequeueNext();
    this._save();
    return task;
  }

  /**
   * Handle task completion.
   * Moves the task from running to completed with status 'done',
   * then dequeues the next waiting task if available.
   * @param {string} flowId
   */
  onTaskComplete(flowId) {
    const now = new Date().toISOString();
    const idx = this._running.findIndex(t => t.flowId === flowId);
    if (idx === -1) return;

    const task = this._running.splice(idx, 1)[0];
    task.status = 'done';
    task.completedAt = now;
    this._completed.push(task);

    this._dequeueNext();
    this._save();
  }

  /**
   * Check if a task's dependencies are fully met.
   * A dependency is met if it exists in _completed with status 'done'.
   * @param {ParallelTask} task
   * @returns {boolean}
   * @private
   */
  _canTaskRun(task) {
    if (!task.dependsOn || task.dependsOn.length === 0) return true;
    return task.dependsOn.every(depFlowId =>
      this._completed.some(c => c.flowId === depFlowId && c.status === 'done')
    );
  }

  /**
   * Handle task failure.
   * Moves the task from running to completed with status 'failed',
   * cascades the failure to any tasks in queue that depend on it,
   * then dequeues the next waiting task if available.
   * @param {string} flowId
   */
  onTaskFailed(flowId) {
    const now = new Date().toISOString();
    const idx = this._running.findIndex(t => t.flowId === flowId);
    if (idx === -1) return;

    const task = this._running.splice(idx, 1)[0];
    task.status = 'failed';
    task.completedAt = now;
    this._completed.push(task);

    this._cascadeFailure(flowId, now);

    this._dequeueNext();
    this._save();
  }

  /**
   * Recursively fails any queued tasks that depend on the failed flowId.
   * @param {string} failedFlowId
   * @param {string} timestamp
   * @private
   */
  _cascadeFailure(failedFlowId, timestamp) {
    let tasksToFail = [];

    // Find direct dependents in the queue
    for (let i = this._queue.length - 1; i >= 0; i--) {
      const qTask = this._queue[i];
      if (qTask.dependsOn && qTask.dependsOn.includes(failedFlowId)) {
        tasksToFail.push(this._queue.splice(i, 1)[0]);
      }
    }

    // Fail them and recurse for transitive dependents
    tasksToFail.forEach(t => {
      t.status = 'failed';
      t.completedAt = timestamp;
      this._completed.push(t);
      this._cascadeFailure(t.flowId, timestamp);
    });
  }

  /**
   * Dequeue the next task from the queue and start it.
   * Finds the first queued task whose dependencies are met.
   * @private
   */
  _dequeueNext() {
    while (this._queue.length > 0 && this._running.length < this.maxConcurrency) {
      // Find first task whose dependencies are met
      const nextIdx = this._queue.findIndex(t => this._canTaskRun(t));
      if (nextIdx === -1) {
        // No waiting tasks have their dependencies met yet
        break;
      }

      const next = this._queue.splice(nextIdx, 1)[0];
      next.status = 'running';
      next.startedAt = new Date().toISOString();
      this._running.push(next);
    }
  }

  /**
   * Get currently queued tasks.
   * @returns {ParallelTask[]}
   */
  getQueue() {
    return [...this._queue];
  }

  /**
   * Get currently running tasks.
   * @returns {ParallelTask[]}
   */
  getRunning() {
    return [...this._running];
  }

  /**
   * Get full scheduler status.
   * @returns {ParallelStatus}
   */
  getStatus() {
    return {
      maxConcurrency: this.maxConcurrency,
      running: [...this._running],
      queue: [...this._queue],
      completed: [...this._completed],
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Persist current scheduler state to the status file.
   * Wrapped in try/catch to avoid crashing if the directory doesn't exist
   * or the file cannot be written.
   * @private
   */
  _save() {
    try {
      const state = {
        maxConcurrency: this.maxConcurrency,
        running: this._running,
        queue: this._queue,
        completed: this._completed,
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(this.statusFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      // Silently ignore write errors (e.g., directory doesn't exist in tests)
    }
  }

  /**
   * Recover scheduler state from the persistence file.
   * If the file doesn't exist or is corrupt, initializes with empty state.
   */
  recover() {
    try {
      const raw = fs.readFileSync(this.statusFile, 'utf8');
      const state = JSON.parse(raw);

      if (typeof state.maxConcurrency === 'number') {
        this.maxConcurrency = state.maxConcurrency;
      }
      this._running = Array.isArray(state.running) ? state.running : [];
      this._queue = Array.isArray(state.queue) ? state.queue : [];
      this._completed = Array.isArray(state.completed) ? state.completed : [];
    } catch (err) {
      // File doesn't exist or is corrupt — initialize with empty state
      this._running = [];
      this._queue = [];
      this._completed = [];
    }
  }
}

module.exports = { ParallelScheduler };

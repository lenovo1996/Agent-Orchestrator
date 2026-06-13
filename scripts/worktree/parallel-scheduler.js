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
   * If a concurrency slot is available, the task is added to running immediately.
   * Otherwise it is enqueued in FIFO order.
   * @param {string} flowId
   * @param {string} step
   * @param {string} repo
   * @returns {ParallelTask}
   */
  schedule(flowId, step, repo) {
    const now = new Date().toISOString();

    if (this._running.length < this.maxConcurrency) {
      /** @type {ParallelTask} */
      const task = {
        flowId,
        step,
        repo,
        status: 'running',
        queuedAt: now,
        startedAt: now,
      };
      this._running.push(task);
      this._save();
      return task;
    }

    /** @type {ParallelTask} */
    const task = {
      flowId,
      step,
      repo,
      status: 'queued',
      queuedAt: now,
    };
    this._queue.push(task);
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
   * Handle task failure.
   * Moves the task from running to completed with status 'failed',
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

    this._dequeueNext();
    this._save();
  }

  /**
   * Dequeue the next task from the queue and start it.
   * @private
   */
  _dequeueNext() {
    if (this._queue.length === 0) return;
    if (this._running.length >= this.maxConcurrency) return;

    const next = this._queue.shift();
    next.status = 'running';
    next.startedAt = new Date().toISOString();
    this._running.push(next);
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

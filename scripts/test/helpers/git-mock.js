/**
 * Git command mocking utilities for property-based and unit tests.
 *
 * Provides a way to intercept and mock `child_process.execSync` calls
 * that invoke git commands, allowing tests to run without real git repos.
 *
 * Usage:
 *   const { GitMock } = require('./helpers/git-mock');
 *   const mock = new GitMock();
 *   mock.register('git worktree add', (cmd) => 'ok');
 *   mock.register('git status --porcelain', () => '');
 *   mock.install();  // patches child_process.execSync
 *   // ... run code under test ...
 *   mock.restore();  // restores original execSync
 */

const childProcess = require('child_process');

class GitMock {
  constructor() {
    this._handlers = [];
    this._calls = [];
    this._originalExecSync = null;
    this._installed = false;
  }

  /**
   * Register a handler for a git command pattern.
   * @param {string|RegExp} pattern - String prefix or RegExp to match against the command
   * @param {function} handler - Function receiving (cmd, options) that returns stdout string.
   *   If handler throws, it simulates a git command failure (non-zero exit).
   */
  register(pattern, handler) {
    this._handlers.push({ pattern, handler });
    return this;
  }

  /**
   * Register a handler that throws an error (simulates git command failure).
   * @param {string|RegExp} pattern - String prefix or RegExp to match
   * @param {object} errorOpts - { stderr, exitCode, message }
   */
  registerError(pattern, errorOpts = {}) {
    const { stderr = '', exitCode = 1, message = 'Command failed' } = errorOpts;
    this._handlers.push({
      pattern,
      handler: () => {
        const err = new Error(message);
        err.status = exitCode;
        err.stderr = Buffer.from(stderr);
        err.stdout = Buffer.from('');
        throw err;
      }
    });
    return this;
  }

  /**
   * Install the mock by patching child_process.execSync.
   * Only git commands are intercepted; non-git commands pass through to the original.
   */
  install() {
    if (this._installed) return this;
    this._originalExecSync = childProcess.execSync;
    this._calls = [];

    const self = this;
    childProcess.execSync = function mockedExecSync(cmd, options) {
      const cmdStr = String(cmd);

      // Only intercept git commands
      if (!cmdStr.trim().startsWith('git ')) {
        return self._originalExecSync.call(childProcess, cmd, options);
      }

      self._calls.push({ cmd: cmdStr, options });

      // Find matching handler
      for (const { pattern, handler } of self._handlers) {
        const matches = pattern instanceof RegExp
          ? pattern.test(cmdStr)
          : cmdStr.includes(pattern);

        if (matches) {
          const result = handler(cmdStr, options);
          // If encoding is specified (like 'utf8'), return string; otherwise Buffer
          if (options && options.encoding) {
            return String(result || '');
          }
          return Buffer.from(String(result || ''));
        }
      }

      // No handler matched — return empty by default (simulates success with no output)
      if (options && options.encoding) {
        return '';
      }
      return Buffer.from('');
    };

    this._installed = true;
    return this;
  }

  /**
   * Restore the original child_process.execSync.
   */
  restore() {
    if (this._installed && this._originalExecSync) {
      childProcess.execSync = this._originalExecSync;
      this._originalExecSync = null;
      this._installed = false;
    }
    return this;
  }

  /**
   * Get all intercepted git command calls.
   * @returns {Array<{cmd: string, options: object}>}
   */
  getCalls() {
    return this._calls.slice();
  }

  /**
   * Get calls matching a pattern.
   * @param {string|RegExp} pattern
   * @returns {Array<{cmd: string, options: object}>}
   */
  getCallsMatching(pattern) {
    return this._calls.filter(({ cmd }) => {
      return pattern instanceof RegExp ? pattern.test(cmd) : cmd.includes(pattern);
    });
  }

  /**
   * Reset recorded calls without uninstalling the mock.
   */
  resetCalls() {
    this._calls = [];
    return this;
  }

  /**
   * Clear all registered handlers.
   */
  clearHandlers() {
    this._handlers = [];
    return this;
  }

  /**
   * Reset everything (handlers + calls) without uninstalling.
   */
  reset() {
    this._handlers = [];
    this._calls = [];
    return this;
  }
}

module.exports = { GitMock };

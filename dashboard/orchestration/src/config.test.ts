import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrchestrationConfig, validateRuntimeFilesystem } from './config.js';

describe('orchestration config shared paths', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEVTEAM_WORKSPACE_ROOT;
    delete process.env.DEVTEAM_WORKTREES_DIR;
    delete process.env.DEVTEAM_HOST_UID;
    delete process.env.DEVTEAM_HOST_GID;
    delete process.env.HOST_UID;
    delete process.env.HOST_GID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults workspace and worktree paths relative to the dev-team root', () => {
    const repoRoot = path.join('/tmp', 'workspace', '.dev-team');
    const config = loadOrchestrationConfig({ repoRoot });

    expect(config.workspaceRoot).toBe(path.dirname(repoRoot));
    expect(config.worktreesDir).toBe(path.join(repoRoot, '.worktrees'));
  });

  it('uses absolute shared paths from the environment', () => {
    process.env.DEVTEAM_WORKSPACE_ROOT = '/shared/workspace';
    process.env.DEVTEAM_WORKTREES_DIR = '/shared/workspace/.dev-team/.worktrees';

    const config = loadOrchestrationConfig({ repoRoot: '/app' });

    expect(config.workspaceRoot).toBe('/shared/workspace');
    expect(config.worktreesDir).toBe('/shared/workspace/.dev-team/.worktrees');
  });

  it('loads the host UID and GID used by shared Docker mounts', () => {
    process.env.DEVTEAM_HOST_UID = '1001';
    process.env.DEVTEAM_HOST_GID = '1002';

    const config = loadOrchestrationConfig({ repoRoot: '/app' });

    expect(config.expectedUid).toBe(1001);
    expect(config.expectedGid).toBe(1002);
  });

  it('creates and validates shared writable directories for the runtime user', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-config-'));
    try {
      const config = loadOrchestrationConfig({
        repoRoot: root,
        workspaceRoot: root,
        taskFlowsDir: path.join(root, 'task-flows'),
        worktreesDir: path.join(root, '.worktrees'),
        expectedUid: process.getuid?.(),
        expectedGid: process.getgid?.(),
      });

      validateRuntimeFilesystem(config);

      expect(fs.statSync(config.taskFlowsDir).isDirectory()).toBe(true);
      expect(fs.statSync(config.worktreesDir).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a runtime user that does not match the configured host UID', () => {
    const config = loadOrchestrationConfig({
      repoRoot: '/tmp',
      workspaceRoot: '/tmp',
      taskFlowsDir: '/tmp',
      worktreesDir: '/tmp',
      expectedUid: (process.getuid?.() || 0) + 1,
    });

    expect(() => validateRuntimeFilesystem(config)).toThrow(/does not match process UID/);
  });
});

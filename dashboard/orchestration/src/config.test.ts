import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrchestrationConfig } from './config.js';

describe('orchestration config shared paths', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEVTEAM_WORKSPACE_ROOT;
    delete process.env.DEVTEAM_WORKTREES_DIR;
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
});

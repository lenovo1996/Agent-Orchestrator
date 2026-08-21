import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestService } from './test-helpers.js';
import { WorktreeManager } from './worktree.js';

describe('WorktreeManager shared path', () => {
  let context: ReturnType<typeof createTestService>;

  beforeEach(() => {
    context = createTestService(['implementer']);
    context.config.worktreesDir = path.join(context.root, 'shared-worktrees');
    const workspace = path.join(context.root, 'workspace');
    execFileSync('git', ['init', '-b', 'main'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'devteam@example.test'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'DevTeam Test'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'README.md'), 'test workspace\n');
    execFileSync('git', ['add', 'README.md'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: workspace });
  });

  afterEach(() => {
    context.close();
  });

  it('creates the flow worktree under the configured shared directory', async () => {
    const command = context.service.createFlow({
      workflowId: 'workflow-1',
      workspaceId: 'workspace-1',
      prompt: 'Implement using a shared worktree',
      useWorktree: true,
    });

    const result = await new WorktreeManager(context.service).prepare(command.flowId);
    const expectedPath = path.join(context.config.worktreesDir, command.flowId);
    const flow = context.service.getFlow(command.flowId);

    expect(result.ready).toBe(true);
    expect(flow.worktreePath).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: expectedPath, encoding: 'utf8' }).trim())
      .toBe(`devteam/${command.flowId}`);
  });
});

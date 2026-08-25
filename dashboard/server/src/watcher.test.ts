import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestOrchestration } from './test-helpers.js';
import { ArtifactWatcher } from './watcher.js';

describe('ArtifactWatcher realtime creation events', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('publishes initial output content and session metadata creation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-watcher-'));
    roots.push(root);
    const taskFlowsDir = path.join(root, 'task-flows');
    const orchestration = createTestOrchestration(root, taskFlowsDir, [
      { flowId: 'flow_001', workspaceId: 'workspace-1' },
    ]);
    const watcher = new ArtifactWatcher(orchestration.service);
    const outputCreated = vi.fn();
    const outputUpdated = vi.fn();
    const sessionChanged = vi.fn();
    watcher.on('output-created', outputCreated);
    watcher.on('output-updated', outputUpdated);
    watcher.on('session-attempt-changed', sessionChanged);

    const artifactRoot = orchestration.service.artifactDirectory('flow_001');
    const outputPath = path.join(artifactRoot, 'output', 'implementation.md');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, 'Realtime output\n');
    (watcher as unknown as { added(filePath: string): void }).added(outputPath);

    expect(outputCreated).toHaveBeenCalledWith(
      'flow_001', 'implementer', path.join('output', 'implementation.md'),
    );
    expect(outputUpdated).toHaveBeenCalledWith(
      'flow_001', 'implementer', 'Realtime output\n',
      expect.objectContaining({ size: 16 }),
    );

    const runId = 'aaaaaaaa-1111-4222-8333-444444444444';
    const sessionPath = path.join(artifactRoot, 'sessions', 'implementer', `${runId}.json`);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, '{}\n');
    (watcher as unknown as { added(filePath: string): void }).added(sessionPath);
    expect(sessionChanged).toHaveBeenCalledWith('flow_001', 'implementer', runId);

    await watcher.close();
    orchestration.database.close();
  });

  it('ignores queued artifact events after the flow has been deleted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-delete-race-'));
    roots.push(root);
    const taskFlowsDir = path.join(root, 'task-flows');
    const orchestration = createTestOrchestration(root, taskFlowsDir, [
      { flowId: 'flow_001', workspaceId: 'workspace-1' },
    ]);
    const watcher = new ArtifactWatcher(orchestration.service);
    const artifactRoot = orchestration.service.artifactDirectory('flow_001');
    const sessionPath = path.join(
      artifactRoot, 'sessions', 'implementer', 'aaaaaaaa-1111-4222-8333-444444444444.json',
    );
    const outputPath = path.join(artifactRoot, 'output', 'implementation.md');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(sessionPath, '{}\n');
    fs.writeFileSync(outputPath, 'output\n');

    orchestration.database.run("UPDATE flows SET status = 'stopped' WHERE id = 'flow_001'");
    orchestration.service.deleteFlow('flow_001');

    expect(() => (watcher as unknown as { changed(filePath: string): void }).changed(sessionPath)).not.toThrow();
    expect(() => (watcher as unknown as { added(filePath: string): void }).added(outputPath)).not.toThrow();

    await watcher.close();
    orchestration.database.close();
  });
});

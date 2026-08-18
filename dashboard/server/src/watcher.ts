import { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { AgentStep, FileMetadata } from '@devteam-dashboard/shared';
import type { OrchestrationService } from '@devteam-dashboard/orchestration';
import { readNewLogLines } from './log-tailer.js';
import { readOutputContent } from './flow-reader.js';

export class ArtifactWatcher extends EventEmitter {
  private readonly watcher: FSWatcher;
  private readonly logOffsets = new Map<string, number>();
  private readonly roots = new Map<string, string>();

  constructor(private readonly service: OrchestrationService) {
    super();
    this.watcher = chokidar.watch([], {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.watcher.on('change', (filePath) => this.changed(filePath));
    this.watcher.on('add', (filePath) => this.added(filePath));
    this.watcher.on('error', (error) => this.emit('error', error));
    for (const flow of service.listFlows()) this.addFlow(flow.flowId);
  }

  addFlow(flowId: string): void {
    try {
      const root = this.service.artifactDirectory(flowId);
      this.roots.set(flowId, root);
      this.watcher.add([path.join(root, 'logs'), path.join(root, 'output')]);
    } catch {
      // The flow can be deleted before the watcher observes its domain event.
    }
  }

  removeFlow(flowId: string): void {
    const root = this.roots.get(flowId);
    if (!root) return;
    this.roots.delete(flowId);
    this.watcher.unwatch([path.join(root, 'logs'), path.join(root, 'output')]);
    for (const key of this.logOffsets.keys()) {
      if (key.startsWith(`${root}${path.sep}`)) this.logOffsets.delete(key);
    }
  }

  private identity(filePath: string): { flowId: string; relative: string } | null {
    for (const [flowId, root] of this.roots) {
      const relative = path.relative(root, filePath);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return { flowId, relative };
    }
    return null;
  }

  private outputStep(flowId: string, relative: string): AgentStep | null {
    const normalized = relative.split(path.sep).join('/');
    return this.service.getFlow(flowId).stepDetails.find((step) => step.outputPath === normalized)?.step || null;
  }

  private changed(filePath: string): void {
    const identity = this.identity(filePath);
    if (!identity) return;
    const parts = identity.relative.split(path.sep);
    if (parts[0] === 'logs' && parts[1]?.endsWith('.log')) {
      const step = parts[1].slice(0, -4);
      const lines = readNewLogLines(filePath, this.logOffsets);
      if (lines.length) this.emit('log-appended', identity.flowId, step, lines);
      return;
    }
    if (parts[0] === 'output') {
      const step = this.outputStep(identity.flowId, identity.relative);
      const output = step ? readOutputContent(filePath) : null;
      if (step && output) this.emit('output-updated', identity.flowId, step, output.content, output.metadata);
    }
  }

  private added(filePath: string): void {
    const identity = this.identity(filePath);
    if (!identity || !identity.relative.startsWith(`output${path.sep}`)) return;
    const step = this.outputStep(identity.flowId, identity.relative);
    if (step) this.emit('output-created', identity.flowId, step, identity.relative);
  }

  close(): Promise<void> {
    return this.watcher.close();
  }
}

export interface ArtifactWatcherEvents {
  'log-appended': (flowId: string, step: AgentStep, lines: string[]) => void;
  'output-created': (flowId: string, step: AgentStep, relativePath: string) => void;
  'output-updated': (flowId: string, step: AgentStep, content: string, metadata: FileMetadata) => void;
}

export function createArtifactWatcher(service: OrchestrationService): ArtifactWatcher {
  return new ArtifactWatcher(service);
}

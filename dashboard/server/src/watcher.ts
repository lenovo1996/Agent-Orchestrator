import chokidar from 'chokidar';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { readWorkflowJson, readOutputContent } from './flow-reader.js';
import { readNewLogLines } from './log-tailer.js';
import type { WorkflowState, AgentStep, ParallelStatus, FileMetadata } from '@devteam-dashboard/shared';

export interface WatcherEvents {
  'workflow-changed': (flowId: string, workflow: WorkflowState) => void;
  'log-appended': (flowId: string, step: AgentStep, lines: string[]) => void;
  'output-created': (flowId: string, step: AgentStep, filePath: string) => void;
  'output-updated': (flowId: string, step: AgentStep, content: string, metadata: FileMetadata) => void;
  'parallel-updated': (status: ParallelStatus) => void;
}

/**
 * Map output filenames to AgentStep values.
 */
function mapOutputFileToStep(filename: string): AgentStep | null {
  const map: Record<string, AgentStep> = {
    'clarify.md': 'clarifier',
    'architecture.md': 'architect',
    'plan.md': 'planner',
    'implementation.md': 'implementer',
    'verification.md': 'verifier',
  };
  return map[filename] || null;
}

/**
 * Create a filesystem watcher that monitors the task-flows directory and
 * parallel-status.json for changes, emitting typed events.
 *
 * Events emitted:
 * - `workflow-changed` — when a flow's workflow.json is modified
 * - `log-appended` — when new lines are appended to a step log file
 * - `output-created` — when a new output .md file appears
 * - `output-updated` — when an existing output .md file is modified
 * - `parallel-updated` — when parallel-status.json changes
 */
export function createWatcher(taskFlowsDir: string, parallelStatusPath: string): EventEmitter {
  const emitter = new EventEmitter();
  const logOffsets = new Map<string, number>();

  const watcher = chokidar.watch([taskFlowsDir, parallelStatusPath], {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher.on('change', (filePath: string) => {
    // Handle parallel-status.json (may be outside taskFlowsDir)
    if (path.resolve(filePath) === path.resolve(parallelStatusPath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const status: ParallelStatus = JSON.parse(raw);
        emitter.emit('parallel-updated', status);
      } catch {
        // Invalid JSON or read error — skip emit, log warning
        console.warn('[watcher] Failed to parse parallel-status.json');
      }
      return;
    }

    const relative = path.relative(taskFlowsDir, filePath);
    const parts = relative.split(path.sep);
    if (parts.length < 2) return;

    const flowId = parts[0];

    // workflow.json changed
    if (parts[1] === 'workflow.json') {
      const workflow = readWorkflowJson(path.join(taskFlowsDir, flowId));
      if (workflow) {
        emitter.emit('workflow-changed', flowId, workflow);
      }
      return;
    }

    // logs/{step}.log changed
    if (parts[1] === 'logs' && parts[2]?.endsWith('.log')) {
      const step = parts[2].replace('.log', '') as AgentStep;
      const newLines = readNewLogLines(filePath, logOffsets);
      if (newLines.length > 0) {
        emitter.emit('log-appended', flowId, step, newLines);
      }
      return;
    }

    // output/{filename}.md changed
    if (parts[1] === 'output' && parts[2]?.endsWith('.md')) {
      const step = mapOutputFileToStep(parts[2]);
      if (step) {
        const result = readOutputContent(filePath);
        if (result) {
          emitter.emit('output-updated', flowId, step, result.content, result.metadata);
        }
      }
      return;
    }
  });

  watcher.on('add', (filePath: string) => {
    const relative = path.relative(taskFlowsDir, filePath);
    const parts = relative.split(path.sep);

    // New output file created
    if (parts.length >= 3 && parts[1] === 'output' && parts[2].endsWith('.md')) {
      const flowId = parts[0];
      const step = mapOutputFileToStep(parts[2]);
      if (step) {
        emitter.emit('output-created', flowId, step, filePath);
      }
    }
  });

  watcher.on('error', (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[watcher] Chokidar error:', message);
  });

  return emitter;
}

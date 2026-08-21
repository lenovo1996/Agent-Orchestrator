import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppServerClient, AppServerThreadTokenUsage } from './appserver-client.js';
import { AppServerSessionBridge } from './appserver-session-bridge.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('AppServerSessionBridge', () => {
  it('writes reasoning summaries and persists app-server token usage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appserver-bridge-'));
    roots.push(root);
    const client = new EventEmitter();
    const metadataPath = path.join(root, 'sessions', 'analyzer', 'aaaaaaaa-1111-4222-8333-444444444444.json');
    const logFile = path.join(root, 'logs', 'analyzer.log');
    const bridge = new AppServerSessionBridge(client as unknown as AppServerClient, {
      workDir: root,
      flowId: 'flow-1',
      step: 'analyzer',
      attemptId: 'attempt-1',
      inngestRunId: 'inngest-1',
      inngestAttempt: 0,
      sessionRunId: 'aaaaaaaa-1111-4222-8333-444444444444',
      logFile,
    });
    const usage: AppServerThreadTokenUsage = {
      last: {
        inputTokens: 20, cachedInputTokens: 5, outputTokens: 8,
        reasoningOutputTokens: 3, totalTokens: 28,
      },
      total: {
        inputTokens: 120, cachedInputTokens: 50, outputTokens: 40,
        reasoningOutputTokens: 17, totalTokens: 160,
      },
      modelContextWindow: 200_000,
    };

    bridge.start();
    client.emit('thread:started', 'thread-1');
    client.emit('turn:started', 'thread-1', 'turn-1');
    client.emit('reasoning:summaryDelta', 'thread-1', 'turn-1', 'reason-1', 0, 'Inspect ');
    client.emit('reasoning:summaryDelta', 'thread-1', 'turn-1', 'reason-1', 0, 'the flow');
    client.emit('tokenUsage:updated', 'thread-1', 'turn-1', usage);
    bridge.complete(0);

    await vi.waitFor(() => {
      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).toContain('thinking');
      expect(log).toContain('Inspect the flow');
    });
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8'))).toMatchObject({
      status: 'completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      usage: {
        inputTokens: 120,
        cachedInputTokens: 50,
        outputTokens: 40,
        reasoningOutputTokens: 17,
      },
    });
  });
});

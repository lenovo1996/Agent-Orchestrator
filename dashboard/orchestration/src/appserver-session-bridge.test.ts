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
    bridge.bindThread('thread-1');
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

  it('isolates interleaved app-server events by flow thread and turn', async () => {
    const client = new EventEmitter();
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appserver-bridge-flow-a-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appserver-bridge-flow-b-'));
    roots.push(firstRoot, secondRoot);

    const createBridge = (workDir: string, flowId: string, sessionRunId: string) => new AppServerSessionBridge(
      client as unknown as AppServerClient,
      {
        workDir,
        flowId,
        step: 'implementer',
        attemptId: `${flowId}-attempt`,
        inngestRunId: `${flowId}-inngest`,
        inngestAttempt: 0,
        sessionRunId,
        logFile: path.join(workDir, 'logs', 'implementer.log'),
      },
    );
    const first = createBridge(firstRoot, 'flow-workspace-a', 'aaaaaaaa-1111-4222-8333-444444444444');
    const second = createBridge(secondRoot, 'flow-workspace-b', 'bbbbbbbb-1111-4222-8333-444444444444');
    const firstUsage: AppServerThreadTokenUsage = {
      last: { inputTokens: 10, cachedInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12 },
      total: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
    };
    const secondUsage: AppServerThreadTokenUsage = {
      last: { inputTokens: 30, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 2, totalTokens: 34 },
      total: { inputTokens: 300, cachedInputTokens: 30, outputTokens: 40, reasoningOutputTokens: 15, totalTokens: 340 },
    };

    first.start();
    second.start();

    // Notifications may arrive while another bridge is still unbound. They
    // must never claim that bridge or mutate its metadata.
    client.emit('thread:started', 'thread-a');
    first.bindThread('thread-a');
    second.bindThread('thread-b');
    client.emit('turn:started', 'thread-a', 'turn-a');
    client.emit('turn:started', 'thread-b', 'turn-b');
    client.emit('thread:started', 'unrelated-thread');
    client.emit('turn:started', 'thread-a', 'unrelated-turn');
    client.emit('agentMessage:delta', 'thread-a', 'unrelated-turn', 'wrong-turn', 'delta from unrelated turn');
    client.emit('agentMessage:delta', 'thread-a', 'turn-a', 'message-a', 'delta only from A');
    client.emit('agentMessage:delta', 'thread-b', 'turn-b', 'message-b', 'delta only from B');
    client.emit('item:completed', 'thread-a', 'turn-a', { type: 'agentMessage', text: 'final only from A' });
    client.emit('item:completed', 'thread-b', 'turn-b', { type: 'agentMessage', text: 'final only from B' });
    client.emit('tokenUsage:updated', 'thread-a', 'turn-a', firstUsage);
    client.emit('tokenUsage:updated', 'thread-b', 'turn-b', secondUsage);
    client.emit('error', 'thread-b', 'failure only from B');

    first.complete(0);
    second.complete(0);

    const firstLogFile = path.join(firstRoot, 'logs', 'implementer.log');
    const secondLogFile = path.join(secondRoot, 'logs', 'implementer.log');
    await vi.waitFor(() => {
      expect(fs.readFileSync(firstLogFile, 'utf8')).toContain('final only from A');
      expect(fs.readFileSync(secondLogFile, 'utf8')).toContain('final only from B');
    });

    const firstLog = fs.readFileSync(firstLogFile, 'utf8');
    const secondLog = fs.readFileSync(secondLogFile, 'utf8');
    expect(firstLog).not.toContain('from B');
    expect(firstLog).not.toContain('unrelated');
    expect(secondLog).not.toContain('from A');
    expect(first.finalAgentMessage).toBe('final only from A');
    expect(second.finalAgentMessage).toBe('final only from B');

    const firstMetadata = JSON.parse(fs.readFileSync(path.join(
      firstRoot, 'sessions', 'implementer', 'aaaaaaaa-1111-4222-8333-444444444444.json',
    ), 'utf8'));
    const secondMetadata = JSON.parse(fs.readFileSync(path.join(
      secondRoot, 'sessions', 'implementer', 'bbbbbbbb-1111-4222-8333-444444444444.json',
    ), 'utf8'));
    expect(firstMetadata).toMatchObject({
      flowId: 'flow-workspace-a', threadId: 'thread-a', turnId: 'turn-a',
      usage: { inputTokens: 100, outputTokens: 20 }, errorSummary: null,
    });
    expect(secondMetadata).toMatchObject({
      flowId: 'flow-workspace-b', threadId: 'thread-b', turnId: 'turn-b',
      usage: { inputTokens: 300, outputTokens: 40 }, errorSummary: { message: 'failure only from B' },
    });
  });
});

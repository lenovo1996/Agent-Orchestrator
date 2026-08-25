import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { AppServerClient } from './appserver-client.js';

async function unusedLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a local test port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

describe('AppServerClient', () => {
  it('rejects a failed initial connection without throwing an unhandled error event', async () => {
    const port = await unusedLocalPort();
    const client = new AppServerClient({
      url: `ws://127.0.0.1:${port}`,
      reconnectMs: 60_000,
    });

    try {
      await expect(client.connect()).rejects.toThrow();
      expect(client.connected).toBe(false);
    } finally {
      client.close();
    }
  });

  it('sends scoped workspace access and publishes summary and token usage notifications', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const request = JSON.parse(raw.toString()) as {
          jsonrpc: '2.0'; id: number; method: string; params: Record<string, unknown>;
        };
        requests.push(request);
        const result = request.method === 'thread/start'
          ? {
            thread: { id: 'thread-1', sessionId: 'session-1', cwd: '/workspace' },
            model: 'gpt-5.6-sol',
          }
          : request.method === 'turn/start'
            ? { turn: { id: 'turn-1', status: 'inProgress' } }
            : {};
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      });
    });
    const client = new AppServerClient({
      url: `ws://127.0.0.1:${address.port}`,
      reconnectMs: 60_000,
      interruptTimeoutMs: 500,
    });
    const onSummary = vi.fn();
    const onUsage = vi.fn();
    client.on('reasoning:summaryDelta', onSummary);
    client.on('tokenUsage:updated', onUsage);

    try {
      await client.connect();
      const runtimeWorkspaceRoots = ['/workspace', '/devteam/task-flows/workspace-1/flow-1'];
      await client.createThread({
        cwd: '/workspace',
        runtimeWorkspaceRoots,
        model: 'gpt-5.6-sol',
        sandbox: 'workspace-write',
      });
      const sandboxPolicy = {
        type: 'workspaceWrite' as const,
        writableRoots: runtimeWorkspaceRoots,
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
      await client.startTurn('thread-1', 'Inspect the flow', {
        model: 'gpt-5.6-sol',
        cwd: '/workspace',
        runtimeWorkspaceRoots,
        sandboxPolicy,
        effort: 'high',
        summary: 'detailed',
      });
      expect(requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({
        cwd: '/workspace',
        runtimeWorkspaceRoots,
        sandbox: 'workspace-write',
      });
      expect(requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({
        threadId: 'thread-1',
        model: 'gpt-5.6-sol',
        cwd: '/workspace',
        runtimeWorkspaceRoots,
        sandboxPolicy,
        effort: 'high',
        summary: 'detailed',
      });

      const socket = [...server.clients][0];
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/reasoning/summaryTextDelta',
        params: {
          threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', summaryIndex: 0, delta: 'Checking',
        },
      }));
      const tokenUsage = {
        last: {
          inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 3, totalTokens: 15,
        },
        total: {
          inputTokens: 100, cachedInputTokens: 20, outputTokens: 50, reasoningOutputTokens: 30, totalTokens: 150,
        },
        modelContextWindow: 200_000,
      };
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage },
      }));

      await vi.waitFor(() => {
        expect(onSummary).toHaveBeenCalledWith('thread-1', 'turn-1', 'reason-1', 0, 'Checking');
        expect(onUsage).toHaveBeenCalledWith('thread-1', 'turn-1', tokenUsage);
      });

      let interruptAcknowledged = false;
      const interrupt = client.interruptTurn('thread-1', 'turn-1').then(() => {
        interruptAcknowledged = true;
      });
      await vi.waitFor(() => {
        expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
      });
      expect(interruptAcknowledged).toBe(false);
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
      }));
      await interrupt;
      expect(interruptAcknowledged).toBe(true);
    } finally {
      client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

import { EventEmitter } from 'node:events';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { AppServerClient } from '@devteam-dashboard/orchestration';
import { improvePromptRouter } from './improve-prompt.js';

async function post(app: express.Express, body: unknown) {
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/improve-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

class FakeAppServerClient extends EventEmitter {
  connected = true;
  createThread = vi.fn(async () => ({
    threadId: 'thread-improve',
    sessionId: 'session-improve',
    model: 'gpt-test',
    cwd: '/repo',
  }));
  startTurn = vi.fn(async () => {
    queueMicrotask(() => {
      this.emit('item:completed', 'thread-improve', 'turn-improve', {
        type: 'agentMessage',
        text: 'A clearer prompt',
      });
      this.emit('turn:completed', 'thread-improve', 'turn-improve', 'completed');
    });
    return { turnId: 'turn-improve', status: 'inProgress' };
  });
  unsubscribeThread = vi.fn(async () => 'unsubscribed' as const);
}

describe('improve prompt REST API', () => {
  it('runs prompt improvement in an ephemeral read-only app-server thread', async () => {
    const client = new FakeAppServerClient();
    const app = express();
    app.use(express.json());
    app.use('/api', improvePromptRouter(client as unknown as AppServerClient, '/repo'));

    const response = await post(app, { prompt: 'make login', model: 'gpt-test' });

    expect(response).toEqual({ status: 200, body: { improved: 'A clearer prompt' } });
    expect(client.createThread).toHaveBeenCalledWith({
      cwd: '/repo',
      model: 'gpt-test',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
    });
    expect(client.startTurn).toHaveBeenCalledWith(
      'thread-improve',
      expect.stringContaining('Improve this prompt:\n\nmake login'),
      {
        model: 'gpt-test',
        cwd: '/repo',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      },
    );
    expect(client.unsubscribeThread).toHaveBeenCalledWith('thread-improve');
  });

  it('returns 503 while app-server is disconnected', async () => {
    const client = new FakeAppServerClient();
    client.connected = false;
    const app = express();
    app.use(express.json());
    app.use('/api', improvePromptRouter(client as unknown as AppServerClient, '/repo'));

    await expect(post(app, { prompt: 'make login' })).resolves.toEqual({
      status: 503,
      body: { error: 'App-server not connected' },
    });
    expect(client.createThread).not.toHaveBeenCalled();
  });
});

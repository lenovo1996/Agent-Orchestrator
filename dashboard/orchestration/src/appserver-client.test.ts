import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
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
});

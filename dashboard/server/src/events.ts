import type { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Server, Socket } from 'socket.io';
import { listAllFlows } from './flow-reader.js';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  StateInitPayload,
} from '@devteam-dashboard/shared';

export interface EventsConfig {
  taskFlowsDir: string;
}

/**
 * Build the full state payload for state:init and state:resync.
 */
function buildStatePayload(config: EventsConfig, workspaceName?: string): StateInitPayload {
  const dir = workspaceName ? path.join(config.taskFlowsDir, workspaceName) : config.taskFlowsDir;
  const flows = listAllFlows(dir);
  return { flows };
}

/**
 * Setup Socket.IO event handlers for the dashboard server.
 *
 * Responsibilities:
 * - Send `state:init` with current state when a client connects
 * - Handle `state:resync` to send full state again on reconnect
 * - Handle `log:subscribe` / `log:unsubscribe` for targeted log streaming (room-based)
 * - Wire watcher events → Socket.IO broadcast
 */
export function setupSocketEvents(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  config: EventsConfig,
  watcher?: EventEmitter,
): void {
  // --- Connection handling ---
  io.on('connection', (socket: Socket<any, any>) => {
    // Send initial state to the newly connected client
    const payload = buildStatePayload(config);
    socket.emit('state:init', payload);

    // Track workspace per socket
    let currentWorkspaceName = '';

    socket.on('workspace:select', ({ workspaceName }: { workspaceName: string | null }) => {
       currentWorkspaceName = workspaceName || '';
       const payload = buildStatePayload(config, currentWorkspaceName);
       socket.emit('state:init', payload);
    });

    // Handle resync request (client reconnected and needs full state)
    socket.on('state:resync', () => {
      const resyncPayload = buildStatePayload(config, currentWorkspaceName);
      socket.emit('state:init', resyncPayload);
    });

    // Handle log subscription — join a room for targeted log streaming
    socket.on('log:subscribe', ({ flowId, step }: { flowId: string, step: string }) => {
      const room = `log:${flowId}:${step}`;
      socket.join(room);
    });

    // Handle log unsubscription — leave the room
    socket.on('log:unsubscribe', ({ flowId, step }: { flowId: string, step: string }) => {
      const room = `log:${flowId}:${step}`;
      socket.leave(room);
    });
  });

  // --- Wire watcher events → Socket.IO broadcast ---
  if (watcher) {
    watcher.on('workflow-changed', (flowId: string, workflow) => {
      io.emit('flow:updated', { flowId, workflow });
    });

    watcher.on('log-appended', (flowId: string, step, lines: string[]) => {
      // Broadcast to all clients subscribed to this specific log room
      const room = `log:${flowId}:${step}`;
      io.to(room).emit('log:append', { flowId, step, lines });
    });

    watcher.on('output-created', (flowId: string, step, filePath: string) => {
      io.emit('output:created', { flowId, step, filePath });
    });

    watcher.on('output-updated', (flowId: string, step, content: string, metadata) => {
      io.emit('output:updated', { flowId, step, content, metadata });
    });
  }
}

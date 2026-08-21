import fs from 'node:fs';
import path from 'node:path';
import type { Server, Socket } from 'socket.io';
import type { OrchestrationService } from '@devteam-dashboard/orchestration';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  StateInitPayload,
  SessionSubscription,
} from '@devteam-dashboard/shared';
import { SessionService } from './session/service.js';
import { JsonlTailer } from './session/tailer.js';
import type { ArtifactWatcher } from './watcher.js';

export function sessionRoom(subscription: SessionSubscription): string {
  return ['session', subscription.workspaceName || '', subscription.flowId, subscription.step, subscription.runId]
    .map(encodeURIComponent)
    .join(':');
}

/**
 * Build the full state payload for state:init and state:resync.
 */
function buildStatePayload(service: OrchestrationService, workspaceId?: string): StateInitPayload {
  return {
    flows: workspaceId ? service.listFlowStates(workspaceId) : {},
    cursor: service.latestDomainCursor(),
  };
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
  service: OrchestrationService,
  watcher?: ArtifactWatcher,
  sessionService?: SessionService,
): () => void {
  interface SessionTracker {
    subscription: SessionSubscription;
    subscribers: number;
    metadataWatcher: fs.FSWatcher | null;
    tailer: JsonlTailer | null;
    rolloutPath: string | null;
    itemSignatures: Map<string, string>;
    refreshing: boolean;
    refreshPending: boolean;
  }
  const trackers = new Map<string, SessionTracker>();

  const closeTracker = (room: string) => {
    const tracker = trackers.get(room);
    if (!tracker) return;
    tracker.metadataWatcher?.close();
    tracker.tailer?.close();
    trackers.delete(room);
  };

  const refreshItems = async (tracker: SessionTracker) => {
    if (!sessionService) return;
    if (tracker.refreshing) {
      tracker.refreshPending = true;
      return;
    }
    tracker.refreshing = true;
    try {
      if (tracker.rolloutPath) sessionService.invalidate(tracker.rolloutPath);
      const { flowId, step, runId, workspaceName } = tracker.subscription;
      const snapshot = await sessionService.snapshot(flowId, step, runId, workspaceName);
      if (!snapshot) return;
      const room = sessionRoom(tracker.subscription);
      for (const item of snapshot.items) {
        const signature = JSON.stringify(item);
        if (tracker.itemSignatures.get(item.id) === signature) continue;
        tracker.itemSignatures.set(item.id, signature);
        io.to(room).emit('session:item-upsert', { ...tracker.subscription, item });
      }
    } finally {
      tracker.refreshing = false;
      if (tracker.refreshPending) {
        tracker.refreshPending = false;
        void refreshItems(tracker);
      }
    }
  };

  const attachTailer = async (tracker: SessionTracker) => {
    if (!sessionService || tracker.tailer) return;
    const { flowId, step, runId, workspaceName } = tracker.subscription;
    const attempt = sessionService.getAttempt(flowId, step, runId, workspaceName);
    if (!attempt) return;
    const rollout = sessionService.resolve(attempt);
    if (!rollout || rollout.compressed) return;
    tracker.rolloutPath = rollout.path;
    const tailer = new JsonlTailer(rollout.path, {
      startAtEnd: true,
      allowedRoot: sessionService.rolloutRoot,
    });
    tailer.on('record', () => { void refreshItems(tracker); });
    tailer.on('reset', () => {
      tracker.itemSignatures.clear();
      void refreshItems(tracker);
    });
    tailer.on('diagnostic', (diagnostic) => {
      console.warn('[session] Ignoring malformed rollout line', diagnostic);
    });
    tailer.on('error', (error) => console.warn('[session] Tailer error:', (error as Error).message));
    tracker.tailer = tailer;
    tailer.start();
    const snapshot = await sessionService.snapshot(flowId, step, runId, workspaceName);
    for (const item of snapshot?.items || []) tracker.itemSignatures.set(item.id, JSON.stringify(item));
  };

  const ensureTracker = async (subscription: SessionSubscription): Promise<SessionTracker | null> => {
    if (!sessionService) return null;
    const room = sessionRoom(subscription);
    const existing = trackers.get(room);
    if (existing) {
      existing.subscribers += 1;
      return existing;
    }
    const attempt = sessionService.getAttempt(
      subscription.flowId, subscription.step, subscription.runId, subscription.workspaceName,
    );
    if (!attempt) return null;
    const tracker: SessionTracker = {
      subscription,
      subscribers: 1,
      metadataWatcher: null,
      tailer: null,
      rolloutPath: null,
      itemSignatures: new Map(),
      refreshing: false,
      refreshPending: false,
    };
    trackers.set(room, tracker);
    const attemptPath = sessionService.attemptPath(
      subscription.flowId, subscription.step, subscription.runId, subscription.workspaceName,
    );
    tracker.metadataWatcher = fs.watch(path.dirname(attemptPath), (_event, filename) => {
      if (filename && filename.toString() !== path.basename(attemptPath)) return;
      const updated = sessionService.getAttempt(
        subscription.flowId, subscription.step, subscription.runId, subscription.workspaceName,
      );
      if (!updated) return;
      io.to(room).emit('session:attempt-updated', {
        workspaceName: subscription.workspaceName,
        flowId: subscription.flowId,
        step: subscription.step,
        attempt: updated,
      });
      void attachTailer(tracker);
    });
    await attachTailer(tracker);
    return tracker;
  };
  // --- Connection handling ---
  io.on('connection', (socket: Socket<any, any>) => {
    // Send initial state to the newly connected client
    const payload = buildStatePayload(service);
    socket.emit('state:init', payload);

    // Track workspace per socket
    let currentWorkspaceId = '';
    const socketSessions = new Map<string, SessionSubscription>();

    socket.on('workspace:select', ({ workspaceId }: { workspaceId: string | null }) => {
       if (currentWorkspaceId) socket.leave(`workspace:${currentWorkspaceId}`);
       currentWorkspaceId = workspaceId || '';
       if (currentWorkspaceId) socket.join(`workspace:${currentWorkspaceId}`);
       const payload = buildStatePayload(service, currentWorkspaceId);
       socket.emit('state:init', payload);
    });

    // Handle resync request (client reconnected and needs full state)
    socket.on('state:resync', () => {
      const resyncPayload = buildStatePayload(service, currentWorkspaceId);
      socket.emit('state:init', resyncPayload);
    });

    // Handle log subscription — join a room for targeted log streaming
    socket.on('log:subscribe', ({ flowId, step }: { flowId: string, step: string }) => {
      try {
        if (!currentWorkspaceId || service.getFlow(flowId).workspaceId !== currentWorkspaceId) return;
      } catch { return; }
      const room = `log:${flowId}:${step}`;
      socket.join(room);
    });

    // Handle log unsubscription — leave the room
    socket.on('log:unsubscribe', ({ flowId, step }: { flowId: string, step: string }) => {
      const room = `log:${flowId}:${step}`;
      socket.leave(room);
    });

    socket.on('session:subscribe', (subscription: SessionSubscription) => {
      try {
        if (!currentWorkspaceId || service.getFlow(subscription.flowId).workspaceId !== currentWorkspaceId) return;
      } catch { return; }
      const normalized = { ...subscription, workspaceName: subscription.workspaceName || null };
      const room = sessionRoom(normalized);
      if (socketSessions.has(room)) return;
      socketSessions.set(room, normalized);
      void ensureTracker(normalized).then((tracker) => {
        if (!tracker) {
          socketSessions.delete(room);
          return;
        }
        if (!socketSessions.has(room)) {
          if (trackers.get(room) === tracker && --tracker.subscribers <= 0) closeTracker(room);
          return;
        }
        socket.join(room);
      }).catch((error) => {
        socketSessions.delete(room);
        closeTracker(room);
        console.warn('[session] Failed to subscribe:', (error as Error).message);
      });
    });

    socket.on('session:unsubscribe', (subscription: SessionSubscription) => {
      const normalized = { ...subscription, workspaceName: subscription.workspaceName || null };
      const room = sessionRoom(normalized);
      if (!socketSessions.delete(room)) return;
      socket.leave(room);
      const tracker = trackers.get(room);
      if (tracker && --tracker.subscribers <= 0) closeTracker(room);
    });

    socket.on('disconnect', () => {
      for (const [room] of socketSessions) {
        const tracker = trackers.get(room);
        if (tracker && --tracker.subscribers <= 0) closeTracker(room);
      }
      socketSessions.clear();
    });
  });

  // Artifact changes remain local Socket.IO events. Flow state comes only from SQLite domain events.
  if (watcher) {
    watcher.on('log-appended', (flowId: string, step, lines: string[]) => {
      const room = `log:${flowId}:${step}`;
      io.to(room).emit('log:append', { flowId, step, lines });
    });

    watcher.on('output-created', (flowId: string, step, filePath: string) => {
      try {
        io.to(`workspace:${service.getFlow(flowId).workspaceId}`).emit('output:created', { flowId, step, filePath });
      } catch { /* flow was deleted */ }
    });

    watcher.on('output-updated', (flowId: string, step, content: string, metadata) => {
      try {
        io.to(`workspace:${service.getFlow(flowId).workspaceId}`).emit('output:updated', { flowId, step, content, metadata });
      } catch { /* flow was deleted */ }
    });

    watcher.on('session-attempt-changed', (flowId: string, step, runId: string) => {
      if (!sessionService) return;
      try {
        const flow = service.getFlow(flowId);
        const attempt = sessionService.getAttempt(flowId, step, runId, flow.workspaceName);
        if (!attempt) return;
        io.to(`workspace:${flow.workspaceId}`).emit('session:attempt-updated', {
          workspaceName: flow.workspaceName,
          flowId,
          step,
          attempt,
        });
      } catch { /* flow or attempt was deleted */ }
    });
  }

  let cursor = service.latestDomainCursor();
  let polling = false;
  const domainPoller = setInterval(() => {
    if (polling) return;
    polling = true;
    try {
      const events = service.domainEventsAfter(cursor);
      for (const event of events) {
        cursor = Math.max(cursor, event.sequence);
        if (!event.flowId || !event.workspaceId) continue;
        const room = `workspace:${event.workspaceId}`;
        if (event.eventType === 'flow.deleted') {
          watcher?.removeFlow(event.flowId);
          io.to(room).emit('state:init', buildStatePayload(service, event.workspaceId));
          continue;
        }
        try {
          const flow = service.getFlow(event.flowId);
          const { workspacePath: _workspacePath, worktreePath: _worktreePath, ...workflow } = flow;
          watcher?.addFlow(event.flowId);
          io.to(room).emit('flow:updated', { sequence: event.sequence, flowId: event.flowId, workflow });
          if (sessionService) {
            for (const step of flow.stepOrder) {
              const attempt = sessionService.list(event.flowId, step, flow.workspaceName).at(-1);
              if (!attempt) continue;
              io.to(room).emit('session:attempt-updated', {
                workspaceName: flow.workspaceName,
                flowId: event.flowId,
                step,
                attempt,
              });
            }
          }
        } catch { /* deleted between event read and projection */ }
      }
    } finally {
      polling = false;
    }
  }, 250);
  domainPoller.unref();
  return () => {
    clearInterval(domainPoller);
    for (const room of [...trackers.keys()]) closeTracker(room);
  };
}

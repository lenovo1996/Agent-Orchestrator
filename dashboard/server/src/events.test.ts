import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupSocketEvents } from './events.js';
import { createTestOrchestration } from './test-helpers.js';

function waitFor(assertion: () => void, timeout = 2_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        assertion();
        resolve();
      } catch (error) {
        if (Date.now() - start >= timeout) reject(error);
        else setTimeout(check, 10);
      }
    };
    check();
  });
}

describe('SQLite domain event realtime projection', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('resyncs a workspace snapshot and broadcasts monotonic updates to its room', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-events-'));
    roots.push(root);
    const orchestration = createTestOrchestration(root, path.join(root, 'task-flows'), []);
    orchestration.database.run(
      'INSERT INTO workspaces(id, name, path) VALUES (?, ?, ?)',
      'workspace-1', 'Workspace 1', path.join(root, 'workspace-1'),
    );

    const handlers: Record<string, (...args: any[]) => void> = {};
    const socket = {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => { handlers[event] = handler; }),
      join: vi.fn(),
      leave: vi.fn(),
    };
    const roomEvents: Array<{ room: string; event: string; payload: any }> = [];
    let connect: ((socket: any) => void) | undefined;
    const io = {
      on: vi.fn((_event: string, handler: (socket: any) => void) => { connect = handler; }),
      to: vi.fn((room: string) => ({
        emit: (event: string, payload: any) => roomEvents.push({ room, event, payload }),
      })),
    };
    const closeEvents = setupSocketEvents(io as any, orchestration.service);
    connect!(socket);
    expect(socket.emit).toHaveBeenCalledWith('state:init', { flows: {}, cursor: 0 });

    handlers['workspace:select']({ workspaceId: 'workspace-1' });
    expect(socket.join).toHaveBeenCalledWith('workspace:workspace-1');
    expect(socket.emit).toHaveBeenLastCalledWith('state:init', { flows: {}, cursor: 0 });

    const command = orchestration.service.createFlow({
      workflowId: 'workflow-1', workspaceId: 'workspace-1', prompt: 'realtime flow',
    }, 'realtime-start');
    await waitFor(() => expect(roomEvents).toHaveLength(1));
    expect(roomEvents[0]).toMatchObject({
      room: 'workspace:workspace-1',
      event: 'flow:updated',
      payload: { sequence: 1, flowId: command.flowId, workflow: { revision: 0, status: 'queued' } },
    });

    handlers['state:resync']();
    const latest = socket.emit.mock.calls.at(-1)?.[1];
    expect(latest.cursor).toBe(1);
    expect(latest.flows[command.flowId]).toMatchObject({ flowId: command.flowId, status: 'queued' });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(roomEvents).toHaveLength(1);
    closeEvents();
    orchestration.database.close();
  });

  it('broadcasts a session attempt before a run is subscribed, including watcher attach races', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-attempt-events-'));
    roots.push(root);
    const orchestration = createTestOrchestration(root, path.join(root, 'task-flows'), [
      { flowId: 'flow_001', workspaceId: 'workspace-1', workspaceName: 'Workspace 1' },
    ]);
    const attempt = {
      schemaVersion: 2 as const,
      runId: 'aaaaaaaa-1111-4222-8333-444444444444',
      attemptId: 'attempt-realtime',
      inngestRunId: 'inngest-realtime',
      inngestAttempt: 0,
      flowId: 'flow_001',
      step: 'implementer',
      threadId: null,
      status: 'starting' as const,
      startedAt: '2026-08-21T00:00:00.000Z',
      finishedAt: null,
      exitCode: null,
      usage: null,
      errorSummary: null,
    };
    const watcher = Object.assign(new EventEmitter(), {
      addFlow: vi.fn(),
      removeFlow: vi.fn(),
    });
    const sessionService = {
      getAttempt: vi.fn(() => attempt),
      list: vi.fn(() => [attempt]),
    };
    const roomEvents: Array<{ room: string; event: string; payload: any }> = [];
    const io = {
      on: vi.fn(),
      to: vi.fn((room: string) => ({
        emit: (event: string, payload: any) => roomEvents.push({ room, event, payload }),
      })),
    };

    const closeEvents = setupSocketEvents(
      io as any,
      orchestration.service,
      watcher as any,
      sessionService as any,
    );
    watcher.emit('session-attempt-changed', 'flow_001', 'implementer', attempt.runId);

    expect(sessionService.getAttempt).toHaveBeenCalledWith(
      'flow_001', 'implementer', attempt.runId, 'Workspace 1',
    );
    expect(roomEvents).toContainEqual({
      room: 'workspace:workspace-1',
      event: 'session:attempt-updated',
      payload: {
        workspaceName: 'Workspace 1',
        flowId: 'flow_001',
        step: 'implementer',
        attempt,
      },
    });

    roomEvents.length = 0;
    orchestration.service.setWorktree('flow_001', null, null);
    await waitFor(() => expect(roomEvents.some((entry) => entry.event === 'flow:updated')).toBe(true));
    expect(roomEvents).toContainEqual({
      room: 'workspace:workspace-1',
      event: 'session:attempt-updated',
      payload: {
        workspaceName: 'Workspace 1',
        flowId: 'flow_001',
        step: 'implementer',
        attempt,
      },
    });

    closeEvents();
    orchestration.database.close();
  });
});

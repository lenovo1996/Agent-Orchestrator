import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupSocketEvents, sessionRoom } from '../events.js';
import { SessionService } from './service.js';
import type { SessionSubscription } from '@devteam-dashboard/shared';
import { createTestOrchestration, insertTestAttempt } from '../test-helpers.js';

function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        assertion();
        resolve();
      } catch (error) {
        if (Date.now() - started >= timeout) reject(error);
        else setTimeout(check, 10);
      }
    };
    check();
  });
}

describe('session realtime lifecycle', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('closes a metadata watcher when its flow is deleted before the final fs event', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-delete-race-'));
    roots.push(root);
    const taskFlowsDir = path.join(root, 'task-flows');
    const codexHome = path.join(root, '.codex');
    const runId = 'dddddddd-1111-4222-8333-444444444444';
    const subscription: SessionSubscription = {
      workspaceName: 'workspace-a', flowId: 'flow_001', step: 'implementer', runId,
    };
    const orchestration = createTestOrchestration(root, taskFlowsDir, [
      { flowId: 'flow_001', workspaceId: 'workspace-a' },
    ]);
    insertTestAttempt(orchestration.database, {
      attemptId: 'attempt-delete-race', flowId: 'flow_001', runId,
      startedAt: '2026-08-25T00:00:00.000Z', status: 'running',
    });
    fs.mkdirSync(codexHome, { recursive: true });

    let metadataChanged: ((event: string, filename: string | Buffer | null) => void) | undefined;
    const closeWatcher = vi.fn();
    const fakeWatcher = {
      close: closeWatcher,
      on: vi.fn(),
    };
    fakeWatcher.on.mockReturnValue(fakeWatcher);
    vi.spyOn(fs, 'watch').mockImplementation(((
      _watchPath: fs.PathLike,
      listener: (event: string, filename: string | Buffer | null) => void,
    ) => {
      metadataChanged = listener;
      return fakeWatcher;
    }) as typeof fs.watch);

    const handlers: Record<string, (...args: any[]) => void> = {};
    const socket = {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => { handlers[event] = handler; }),
      join: vi.fn(),
      leave: vi.fn(),
    };
    let connection: ((socket: any) => void) | undefined;
    const io = {
      on: vi.fn((_event: string, handler: (socket: any) => void) => { connection = handler; }),
      to: vi.fn(() => ({ emit: vi.fn() })),
    };
    const service = new SessionService({ taskFlowsDir, codexHome }, orchestration.service);
    const closeEvents = setupSocketEvents(io as any, orchestration.service, undefined, service);
    connection!(socket);
    handlers['workspace:select']({ workspaceId: 'workspace-a' });
    handlers['session:subscribe'](subscription);
    await waitFor(() => expect(socket.join).toHaveBeenCalledWith(sessionRoom(subscription)));
    expect(metadataChanged).toBeTypeOf('function');

    orchestration.database.run("UPDATE flows SET status = 'stopped' WHERE id = 'flow_001'");
    orchestration.service.deleteFlow('flow_001');

    expect(() => metadataChanged!('rename', `${runId}.json`)).not.toThrow();
    expect(closeWatcher).toHaveBeenCalledOnce();

    closeEvents();
    orchestration.database.close();
  });

  it('emits one stable upsert to the workspace-scoped room and closes on unsubscribe', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-realtime-'));
    roots.push(root);
    const taskFlowsDir = path.join(root, 'task-flows');
    const codexHome = path.join(root, '.codex');
    const threadId = '019fffff-1111-7222-8333-444444444444';
    const runId = 'aaaaaaaa-1111-4222-8333-444444444444';
    const subscription: SessionSubscription = {
      workspaceName: 'workspace-a', flowId: 'flow_001', step: 'implementer', runId,
    };
    const attemptDir = path.join(taskFlowsDir, 'workspace-a', 'flow_001', 'sessions', 'implementer');
    const rolloutDir = path.join(codexHome, 'sessions', '2026', '08', '17');
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.mkdirSync(path.join(codexHome, 'archived_sessions'), { recursive: true });
    fs.writeFileSync(path.join(attemptDir, `${runId}.json`), JSON.stringify({
      schemaVersion: 2, runId, attemptId: 'attempt-realtime', inngestRunId: 'inngest-realtime', inngestAttempt: 0,
      flowId: 'flow_001', step: 'implementer', threadId,
      status: 'running', startedAt: '2026-08-17T00:00:00.000Z', finishedAt: null,
      exitCode: null, usage: null, errorSummary: null,
    }));
    const rollout = path.join(rolloutDir, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(rollout, `${JSON.stringify({
      timestamp: '2026-08-17T00:00:00.000Z', ordinal: 1, type: 'response_item',
      payload: { type: 'function_call', call_id: 'tool-1', name: 'mcp__test__call', arguments: '{}' },
    })}\n`);

    const handlers: Record<string, (...args: any[]) => void> = {};
    const socket = {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => { handlers[event] = handler; }),
      join: vi.fn(),
      leave: vi.fn(),
    };
    const roomEvents: Array<{ room: string; event: string; payload: any }> = [];
    let connection: ((socket: any) => void) | undefined;
    const io = {
      on: vi.fn((_event: string, handler: (socket: any) => void) => { connection = handler; }),
      emit: vi.fn(),
      to: vi.fn((room: string) => ({
        emit: (event: string, payload: any) => roomEvents.push({ room, event, payload }),
      })),
    };
    const orchestration = createTestOrchestration(root, taskFlowsDir, [
      { flowId: 'flow_001', workspaceId: 'workspace-a' },
    ]);
    insertTestAttempt(orchestration.database, {
      attemptId: 'attempt-realtime', flowId: 'flow_001', runId,
      startedAt: '2026-08-17T00:00:00.000Z', status: 'running',
    });
    const service = new SessionService({ taskFlowsDir, codexHome }, orchestration.service);
    const closeEvents = setupSocketEvents(io as any, orchestration.service, undefined, service);
    connection!(socket);
    handlers['workspace:select']({ workspaceId: 'workspace-a' });
    handlers['session:subscribe'](subscription);
    await waitFor(() => expect(socket.join).toHaveBeenCalledWith(sessionRoom(subscription)));

    const output = JSON.stringify({
      timestamp: '2026-08-17T00:00:01.000Z', ordinal: 2, type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'tool-1', output: 'complete' },
    });
    fs.appendFileSync(rollout, `${output}\n`);
    await waitFor(() => expect(roomEvents.filter((entry) => entry.event === 'session:item-upsert')).toHaveLength(1));
    const upsert = roomEvents.find((entry) => entry.event === 'session:item-upsert')!;
    expect(upsert.room).toBe(sessionRoom(subscription));
    expect(upsert.payload.item).toMatchObject({ id: 'ordinal-1', status: 'completed' });

    fs.appendFileSync(rollout, `${output}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(roomEvents.filter((entry) => entry.event === 'session:item-upsert')).toHaveLength(1);

    handlers['session:unsubscribe'](subscription);
    expect(socket.leave).toHaveBeenCalledWith(sessionRoom(subscription));
    closeEvents();
    orchestration.database.close();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { setupSocketEvents, type EventsConfig } from './events.js';
import type { WorkflowState } from '@devteam-dashboard/shared';

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'events-test-'));
}

function makeWorkflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    flowId: 'flow_test_001',
    jiraKey: 'TEST-1',
    status: 'running',
    currentStep: 'clarifier',
    startedAt: '2025-01-01T00:00:00.000Z',
    steps: {
      clarifier: 'running',
      architect: 'waiting',
      planner: 'waiting',
      implementer: 'waiting',
      verifier: 'waiting',
    },
    ...overrides,
  };
}

/**
 * Create a mock Socket.IO server with typed event tracking.
 */
function createMockIo() {
  const sockets: MockSocket[] = [];
  const connectionHandlers: Array<(socket: MockSocket) => void> = [];

  const io = {
    on: vi.fn((event: string, handler: (socket: MockSocket) => void) => {
      if (event === 'connection') {
        connectionHandlers.push(handler);
      }
    }),
    emit: vi.fn(),
    to: vi.fn(() => ({ emit: io.roomEmit })),
    roomEmit: vi.fn(),
  };

  function simulateConnect(): MockSocket {
    const socket = createMockSocket();
    sockets.push(socket);
    for (const handler of connectionHandlers) {
      handler(socket);
    }
    return socket;
  }

  return { io, simulateConnect, sockets };
}

interface MockSocket {
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  _handlers: Record<string, Array<(...args: unknown[]) => void>>;
  triggerEvent: (event: string, ...args: unknown[]) => void;
}

function createMockSocket(): MockSocket {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const socket: MockSocket = {
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    join: vi.fn(),
    leave: vi.fn(),
    _handlers: handlers,
    triggerEvent: (event: string, ...args: unknown[]) => {
      const eventHandlers = handlers[event];
      if (eventHandlers) {
        for (const handler of eventHandlers) {
          handler(...args);
        }
      }
    },
  };
  return socket;
}

describe('setupSocketEvents', () => {
  let tmpDir: string;
  let config: EventsConfig;

  beforeEach(() => {
    tmpDir = createTmpDir();
    config = {
      taskFlowsDir: tmpDir,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('state:init on connection', () => {
    it('should send state:init with flows when client connects', () => {
      // Setup a valid flow
      const flowDir = path.join(tmpDir, 'flow_001');
      fs.mkdirSync(flowDir);
      fs.writeFileSync(
        path.join(flowDir, 'workflow.json'),
        JSON.stringify(makeWorkflow({ flowId: 'flow_001' })),
      );

      const { io, simulateConnect } = createMockIo();
      setupSocketEvents(io as any, config);

      const socket = simulateConnect();

      expect(socket.emit).toHaveBeenCalledWith('state:init', {
        flows: { flow_001: expect.objectContaining({ flowId: 'flow_001' }) },
      });
    });

    it('should send empty flows when no valid flows exist', () => {
      const { io, simulateConnect } = createMockIo();
      setupSocketEvents(io as any, config);

      const socket = simulateConnect();

      expect(socket.emit).toHaveBeenCalledWith('state:init', {
        flows: {},
      });
    });
  });

  describe('state:resync', () => {
    it('should send full state again on state:resync event', () => {
      const flowDir = path.join(tmpDir, 'flow_002');
      fs.mkdirSync(flowDir);
      fs.writeFileSync(
        path.join(flowDir, 'workflow.json'),
        JSON.stringify(makeWorkflow({ flowId: 'flow_002', jiraKey: 'RESYNC-1' })),
      );

      const { io, simulateConnect } = createMockIo();
      setupSocketEvents(io as any, config);

      const socket = simulateConnect();
      // Clear initial emit
      socket.emit.mockClear();

      // Trigger resync
      socket.triggerEvent('state:resync');

      expect(socket.emit).toHaveBeenCalledWith('state:init', {
        flows: { flow_002: expect.objectContaining({ flowId: 'flow_002', jiraKey: 'RESYNC-1' }) },
      });
    });
  });

  describe('log:subscribe / log:unsubscribe', () => {
    it('should join the log room on log:subscribe', () => {
      const { io, simulateConnect } = createMockIo();
      setupSocketEvents(io as any, config);

      const socket = simulateConnect();
      socket.triggerEvent('log:subscribe', { flowId: 'flow_001', step: 'clarifier' });

      expect(socket.join).toHaveBeenCalledWith('log:flow_001:clarifier');
    });

    it('should leave the log room on log:unsubscribe', () => {
      const { io, simulateConnect } = createMockIo();
      setupSocketEvents(io as any, config);

      const socket = simulateConnect();
      socket.triggerEvent('log:unsubscribe', { flowId: 'flow_001', step: 'planner' });

      expect(socket.leave).toHaveBeenCalledWith('log:flow_001:planner');
    });
  });

  describe('watcher event wiring', () => {
    it('should broadcast flow:updated when watcher emits workflow-changed', () => {
      const watcher = new EventEmitter();
      const { io } = createMockIo();
      setupSocketEvents(io as any, config, watcher);

      const workflow = makeWorkflow({ flowId: 'flow_x' });
      watcher.emit('workflow-changed', 'flow_x', workflow);

      expect(io.emit).toHaveBeenCalledWith('flow:updated', { flowId: 'flow_x', workflow });
    });

    it('should emit log:append to subscribed room when watcher emits log-appended', () => {
      const watcher = new EventEmitter();
      const { io } = createMockIo();
      setupSocketEvents(io as any, config, watcher);

      const lines = ['line1', 'line2'];
      watcher.emit('log-appended', 'flow_a', 'architect', lines);

      expect(io.to).toHaveBeenCalledWith('log:flow_a:architect');
      expect(io.roomEmit).toHaveBeenCalledWith('log:append', {
        flowId: 'flow_a',
        step: 'architect',
        lines,
      });
    });

    it('should broadcast output:created when watcher emits output-created', () => {
      const watcher = new EventEmitter();
      const { io } = createMockIo();
      setupSocketEvents(io as any, config, watcher);

      watcher.emit('output-created', 'flow_b', 'planner', '/path/to/plan.md');

      expect(io.emit).toHaveBeenCalledWith('output:created', {
        flowId: 'flow_b',
        step: 'planner',
        filePath: '/path/to/plan.md',
      });
    });

    it('should broadcast output:updated when watcher emits output-updated', () => {
      const watcher = new EventEmitter();
      const { io } = createMockIo();
      setupSocketEvents(io as any, config, watcher);

      const metadata = { size: 1234, lastModified: '2025-01-01T12:00:00.000Z' };
      watcher.emit('output-updated', 'flow_c', 'verifier', '# Result', metadata);

      expect(io.emit).toHaveBeenCalledWith('output:updated', {
        flowId: 'flow_c',
        step: 'verifier',
        content: '# Result',
        metadata,
      });
    });

    it('should work without watcher (watcher is optional)', () => {
      const { io, simulateConnect } = createMockIo();

      // Should not throw
      expect(() => setupSocketEvents(io as any, config)).not.toThrow();

      const socket = simulateConnect();
      expect(socket.emit).toHaveBeenCalledWith('state:init', expect.any(Object));
    });
  });
});

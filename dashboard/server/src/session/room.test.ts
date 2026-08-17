import { describe, expect, it } from 'vitest';
import { sessionRoom } from '../events.js';

describe('sessionRoom', () => {
  it('includes workspace, flow, step and run ID', () => {
    const base = { flowId: 'same-flow', step: 'planner', runId: 'run-1' };
    const first = sessionRoom({ ...base, workspaceName: 'workspace-a' });
    const second = sessionRoom({ ...base, workspaceName: 'workspace-b' });
    expect(first).not.toBe(second);
    expect(first).toContain('workspace-a');
    expect(first).toContain('same-flow');
    expect(first).toContain('planner');
    expect(first).toContain('run-1');
  });
});

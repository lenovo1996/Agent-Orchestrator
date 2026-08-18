import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRunner } from './agent-runner.js';
import { PermanentAgentError, RetriableAgentError } from './errors.js';
import { createFlow, createTestService } from './test-helpers.js';

let context: ReturnType<typeof createTestService>;
let runner: AgentRunner;

beforeEach(() => {
  context = createTestService(['implementer']);
  const wrapperDirectory = path.join(context.root, 'scripts', 'agent');
  fs.mkdirSync(wrapperDirectory, { recursive: true });
  fs.writeFileSync(path.join(wrapperDirectory, 'wrapper.sh'), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${FAKE_SLEEP:-0}" = "1" ]; then
  trap 'exit 143' TERM INT
  sleep 30 &
  wait
fi
if [ "\${FAKE_AUTH_ERROR:-0}" = "1" ]; then
  echo "authentication failed" >&2
fi
if [ "\${FAKE_WRITE_OUTPUT:-1}" = "1" ]; then
  mkdir -p "$(dirname "$DEVTEAM_OUTPUT_FILE")"
  printf '## Status\\n%s\\n\\nTests: 2 passed, 0 failed\\n' "\${FAKE_STATUS:-DONE}" > "$DEVTEAM_OUTPUT_FILE"
fi
exit "\${FAKE_EXIT_CODE:-0}"
`, { mode: 0o755 });
  const runtimeDirectory = path.join(context.root, 'scripts', 'runtimes');
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(path.join(runtimeDirectory, 'fake.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  context.database.run("UPDATE agents SET runtime = 'fake' WHERE id = 'implementer'");
  const memoryDirectory = path.join(context.root, 'scripts', 'utils');
  fs.mkdirSync(memoryDirectory, { recursive: true });
  fs.writeFileSync(path.join(memoryDirectory, 'memory-tree.js'), `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(process.cwd(), 'memory-calls.log'), process.argv.slice(2).join(' ') + '\\n');
`);
  runner = new AgentRunner(context.service);
});

afterEach(() => {
  delete process.env.FAKE_STATUS;
  delete process.env.FAKE_EXIT_CODE;
  delete process.env.FAKE_WRITE_OUTPUT;
  delete process.env.FAKE_AUTH_ERROR;
  delete process.env.FAKE_SLEEP;
  context.close();
});

function invocation(inngestRunId = 'child-run-1', inngestAttempt = 0) {
  const command = createFlow(context.service);
  context.service.queueStep(command.flowId, 'implementer');
  return {
    flowId: command.flowId,
    step: 'implementer',
    cycle: 1,
    inngestRunId,
    inngestAttempt,
    runnerId: 'test-runner',
  };
}

describe('AgentRunner', () => {
  it('runs a foreground attempt and persists DONE', async () => {
    const input = invocation();
    const result = await runner.execute(input);
    expect(result.status).toBe('DONE');
    expect(context.service.listAttempts(input.flowId)).toEqual([
      expect.objectContaining({
        id: result.attemptId,
        status: 'completed',
        inngestRunId: 'child-run-1',
        inngestAttempt: 0,
        pid: expect.any(Number),
        processGroupId: expect.any(Number),
      }),
    ]);
    expect(fs.readFileSync(path.join(context.root, 'memory-calls.log'), 'utf8')).toContain(`generate ${input.flowId} implementer`);
    expect(fs.readFileSync(path.join(context.root, 'memory-calls.log'), 'utf8')).toContain(`update ${input.flowId} implementer`);
  });

  it('projects a finalized recovered attempt without spawning a duplicate', async () => {
    const input = invocation();
    const first = await runner.execute(input);
    process.env.FAKE_WRITE_OUTPUT = '0';
    process.env.FAKE_EXIT_CODE = '99';
    const recovered = await runner.execute({ ...input, inngestRunId: 'retried-child-run', inngestAttempt: 1 });
    expect(recovered).toEqual(first);
    expect(context.service.listAttempts(input.flowId)).toHaveLength(1);
  });

  it('accepts structured BLOCKED even when the process exits non-zero', async () => {
    process.env.FAKE_STATUS = 'BLOCKED';
    process.env.FAKE_EXIT_CODE = '17';
    expect((await runner.execute(invocation())).status).toBe('BLOCKED');
  });

  it('classifies missing output as retriable', async () => {
    process.env.FAKE_WRITE_OUTPUT = '0';
    const input = invocation();
    await expect(runner.execute(input)).rejects.toBeInstanceOf(RetriableAgentError);
    expect(context.service.listAttempts(input.flowId)[0]).toMatchObject({
      status: 'failed', error: { stage: 'missing_output', retriable: true },
    });
  });

  it('classifies authentication failures as permanent', async () => {
    process.env.FAKE_WRITE_OUTPUT = '0';
    process.env.FAKE_AUTH_ERROR = '1';
    process.env.FAKE_EXIT_CODE = '1';
    const input = invocation();
    await expect(runner.execute(input)).rejects.toBeInstanceOf(PermanentAgentError);
    expect(context.service.listAttempts(input.flowId)[0].error?.retriable).toBe(false);
  });

  it('rejects invalid runtime configuration without a technical retry', async () => {
    context.database.run("UPDATE agents SET runtime = 'missing-runtime' WHERE id = 'implementer'");
    const input = invocation();
    await expect(runner.execute(input)).rejects.toBeInstanceOf(PermanentAgentError);
    expect(context.service.listAttempts(input.flowId)[0]).toMatchObject({
      status: 'failed', error: { stage: 'configuration', retriable: false },
    });
  });

  it('terminates a timed-out process group', async () => {
    process.env.FAKE_SLEEP = '1';
    context.config.agentTimeoutMs = 50;
    const input = invocation();
    await expect(runner.execute(input)).rejects.toMatchObject({ stage: 'timeout' });
    const attempt = context.service.listAttempts(input.flowId)[0];
    expect(attempt).toMatchObject({ status: 'failed', error: { stage: 'timeout', retriable: true } });
    expect(runner.supervisor.isAlive(attempt.pid)).toBe(false);
  });
});

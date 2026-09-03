import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner } from './agent-runner.js';
import type { AppServerClient } from './appserver-client.js';
import { PermanentAgentError, RetriableAgentError } from './errors.js';
import { createFlow, createTestService } from './test-helpers.js';

class FakeAppServerClient extends EventEmitter {
  readonly connected = true;
  readonly createThread = vi.fn(async (params: {
    cwd: string;
    runtimeWorkspaceRoots?: string[];
    model?: string;
    sandbox?: string;
  }) => {
    this.emit('thread:started', 'thread-1');
    return { threadId: 'thread-1', sessionId: 'session-1', model: 'test-model', cwd: params.cwd };
  });
  readonly resumeThread = vi.fn(async (threadId: string, params?: {
    cwd?: string;
    runtimeWorkspaceRoots?: string[];
    model?: string;
    sandbox?: string;
  }) => {
    this.emit('thread:started', threadId);
    return { threadId, sessionId: 'session-1', model: 'test-model', cwd: params?.cwd || '/workspace' };
  });
  readonly startTurn = vi.fn(async (threadId: string, _input: string, _params?: unknown) => {
    this.emit('turn:started', threadId, 'turn-1');
    return { turnId: 'turn-1', status: 'inProgress' };
  });
  readonly interruptTurn = vi.fn(async (threadId: string, turnId: string) => {
    this.emit('turn:completed', threadId, turnId, 'interrupted');
  });
}

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
if [ -n "\${DEVTEAM_CAPTURE_PROMPT:-}" ]; then
  cp "$4" "$DEVTEAM_CAPTURE_PROMPT"
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
const [command, flowId] = process.argv.slice(2);
if (command === 'generate') {
  const taskDir = path.join(process.env.DEVTEAM_TASK_MEMORY_DIR, flowId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'active-context.md'), '# Active memory for ' + flowId + '\\n');
}
`);
  runner = new AgentRunner(context.service);
});

afterEach(() => {
  delete process.env.FAKE_STATUS;
  delete process.env.FAKE_EXIT_CODE;
  delete process.env.FAKE_WRITE_OUTPUT;
  delete process.env.FAKE_AUTH_ERROR;
  delete process.env.FAKE_SLEEP;
  delete process.env.DEVTEAM_CAPTURE_PROMPT;
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
  it('grants full filesystem access without tool flags and interrupts a stopped flow', async () => {
    context.database.run(`
      UPDATE agents SET runtime = 'appserver', model = 'gpt-5.6-sol', thinking = 'high'
      WHERE id = 'implementer'
    `);
    const client = new FakeAppServerClient();
    (runner as unknown as { _appServerClient: AppServerClient | null })._appServerClient = client as unknown as AppServerClient;
    runner.supervisor.setAppServerClient(client as unknown as AppServerClient);
    const input = invocation();
    const flow = context.service.getFlow(input.flowId);
    const runtimeWorkspaceRoots = [
      path.resolve(flow.workspacePath),
      path.resolve(context.service.artifactDirectory(flow)),
    ];

    const execution = runner.execute(input);
    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledOnce());
    await runner.supervisor.terminateFlow(input.flowId);

    await expect(execution).rejects.toMatchObject({ stage: 'cancelled' });
    expect(client.startTurn).toHaveBeenCalledWith('thread-1', expect.any(String), {
      model: 'gpt-5.6-sol',
      cwd: flow.workspacePath,
      runtimeWorkspaceRoots,
      sandboxPolicy: { type: 'dangerFullAccess' },
      effort: 'high',
      summary: 'detailed',
    });
    expect(client.createThread).toHaveBeenCalledWith({
      cwd: flow.workspacePath,
      runtimeWorkspaceRoots,
      model: 'gpt-5.6-sol',
      sandbox: 'danger-full-access',
    });
    expect(client.startTurn.mock.calls[0]?.[1]).toContain(
      `Write your output to: ${context.service.outputFile(input.flowId, input.step)}`,
    );
    const memoryContext = path.join(context.config.taskMemoryDir, input.flowId, 'active-context.md');
    expect(fs.readFileSync(path.join(context.root, 'memory-calls.log'), 'utf8'))
      .toContain(`generate ${input.flowId} implementer`);
    expect(client.startTurn.mock.calls[0]?.[1]).toContain(
      `## Memory Context\n\nRead the active memory context at: ${memoryContext}`,
    );
    expect(client.startTurn.mock.calls[0]?.[1]).toContain([
      'Start the file with this exact machine-readable status block (without a code fence):',
      '',
      '## Status',
      'DONE',
      '',
      'Replace DONE with NEEDS_FIX, BLOCKED, or FAILED when appropriate.',
      'Keep the status as plain text; do not wrap it in Markdown emphasis or inline code.',
    ].join('\n'));
    expect(client.interruptTurn).toHaveBeenCalledWith('thread-1', 'turn-1');
    expect(context.service.listAttempts(input.flowId)[0]).toMatchObject({ status: 'cancelled' });
    const attempt = context.service.listAttempts(input.flowId)[0];
    expect(JSON.parse(fs.readFileSync(path.join(
      context.service.artifactDirectory(input.flowId),
      'sessions',
      input.step,
      `${attempt.sessionRunId}.json`,
    ), 'utf8'))).toMatchObject({
      threadId: 'thread-1', turnId: 'turn-1', status: 'cancelled',
    });

    await runner.supervisor.terminateFlow(input.flowId);
    expect(client.interruptTurn).toHaveBeenCalledOnce();
  });

  it('fails safely before starting a turn when app-server returns another workspace cwd', async () => {
    context.database.run("UPDATE agents SET runtime = 'appserver' WHERE id = 'implementer'");
    const client = new FakeAppServerClient();
    client.createThread.mockResolvedValueOnce({
      threadId: 'thread-wrong-workspace',
      sessionId: 'session-wrong-workspace',
      model: 'test-model',
      cwd: '/another/workspace',
    });
    (runner as unknown as { _appServerClient: AppServerClient | null })._appServerClient = client as unknown as AppServerClient;
    runner.supervisor.setAppServerClient(client as unknown as AppServerClient);
    const input = invocation();

    await expect(runner.execute(input)).rejects.toMatchObject({ stage: 'configuration' });
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(context.service.listAttempts(input.flowId)[0]).toMatchObject({
      status: 'failed',
      error: { stage: 'configuration', retriable: false },
    });
    expect(client.listenerCount('item:completed')).toBe(0);
  });

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

  it('uses a chat follow-up only for the resumed attempt and preserves the flow prompt', async () => {
    const command = createFlow(context.service);
    context.service.claimCoordinator(command.commandId, command.flowId, 'run-1', 'test-runner');
    context.service.queueStep(command.flowId, 'implementer');
    context.service.createAttempt({
      id: 'attempt-chat',
      flowId: command.flowId,
      step: 'implementer',
      cycle: 1,
      technicalAttempt: 0,
      inngestRunId: 'child-original',
      inngestAttempt: 0,
      sessionRunId: 'session-chat',
      runnerId: 'test-runner',
    });
    context.service.markAttemptRunning('attempt-chat', 0, 0);
    context.service.finishAttempt('attempt-chat', 'completed', 0);
    context.service.failFlow(command.flowId, 'ready for chat follow-up', 'implementer', command.commandId);
    const retry = context.service.retryFlow(command.flowId, {
      step: 'implementer',
      resumeThread: true,
      sessionRunId: 'session-chat',
      followUpMessage: 'Apply only this follow-up',
    });
    context.service.claimCoordinator(retry.commandId, command.flowId, 'run-2', 'test-runner');
    const queued = context.service.queueStep(command.flowId, 'implementer');
    const capturedPrompt = path.join(context.root, 'captured-prompt.txt');
    process.env.DEVTEAM_CAPTURE_PROMPT = capturedPrompt;

    const result = await runner.execute({
      flowId: command.flowId,
      step: 'implementer',
      cycle: queued.cycle,
      inngestRunId: 'child-chat',
      inngestAttempt: 0,
      runnerId: 'test-runner',
    });

    expect(result.attemptId).toBe('attempt-chat');
    expect(fs.readFileSync(capturedPrompt, 'utf8')).toBe('Apply only this follow-up\n');
    expect(context.service.getFlow(command.flowId).customPrompt).toBe('Implement the test task');
  });

  it('keeps the existing output when an app-server chat follow-up only returns a final message', async () => {
    context.database.run("UPDATE agents SET runtime = 'appserver' WHERE id = 'implementer'");
    const client = new FakeAppServerClient();
    (runner as unknown as { _appServerClient: AppServerClient | null })._appServerClient = client as unknown as AppServerClient;
    runner.supervisor.setAppServerClient(client as unknown as AppServerClient);
    const command = createFlow(context.service);
    context.service.claimCoordinator(command.commandId, command.flowId, 'run-1', 'test-runner');
    context.service.queueStep(command.flowId, 'implementer');
    context.service.createAttempt({
      id: 'attempt-appserver-chat',
      flowId: command.flowId,
      step: 'implementer',
      cycle: 1,
      technicalAttempt: 0,
      inngestRunId: 'child-original',
      inngestAttempt: 0,
      sessionRunId: 'session-appserver-chat',
      runnerId: 'test-runner',
    });
    context.service.markAttemptRunning('attempt-appserver-chat', 0, 0);
    context.service.finishAttempt('attempt-appserver-chat', 'completed', 0);
    const outputFile = context.service.outputFile(command.flowId, 'implementer');
    const originalOutput = '## Status\nDONE\n\nOriginal artifact\n';
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, originalOutput);
    const sessionDirectory = path.join(
      context.service.artifactDirectory(command.flowId),
      'sessions',
      'implementer',
    );
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessionDirectory, 'session-appserver-chat.json'), JSON.stringify({
      schemaVersion: 2,
      runId: 'session-appserver-chat',
      attemptId: 'attempt-appserver-chat',
      inngestRunId: 'child-original',
      inngestAttempt: 0,
      flowId: command.flowId,
      step: 'implementer',
      threadId: 'thread-existing',
      turnId: 'turn-old',
      status: 'completed',
      startedAt: '2026-08-17T00:00:00.000Z',
      finishedAt: '2026-08-17T00:01:00.000Z',
      exitCode: 0,
      usage: null,
      errorSummary: null,
    }));
    context.service.failFlow(command.flowId, 'ready for chat follow-up', 'implementer', command.commandId);
    const retry = context.service.retryFlow(command.flowId, {
      step: 'implementer',
      resumeThread: true,
      sessionRunId: 'session-appserver-chat',
      followUpMessage: 'Answer without changing the artifact',
    });
    context.service.claimCoordinator(retry.commandId, command.flowId, 'run-2', 'test-runner');
    const queued = context.service.queueStep(command.flowId, 'implementer');

    const execution = runner.execute({
      flowId: command.flowId,
      step: 'implementer',
      cycle: queued.cycle,
      inngestRunId: 'child-chat',
      inngestAttempt: 0,
      runnerId: 'test-runner',
    });
    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledOnce());
    const flow = context.service.getFlow(command.flowId);
    expect(client.resumeThread).toHaveBeenCalledWith('thread-existing', {
      cwd: flow.workspacePath,
      runtimeWorkspaceRoots: [
        path.resolve(flow.workspacePath),
        path.resolve(context.service.artifactDirectory(flow)),
      ],
      model: undefined,
      sandbox: 'danger-full-access',
    });
    client.emit('item:completed', 'thread-existing', 'turn-1', {
      type: 'agentMessage',
      text: 'Final chat answer without a status marker',
    });
    client.emit('turn:completed', 'thread-existing', 'turn-1', 'completed');

    await expect(execution).resolves.toEqual({ status: 'DONE', attemptId: 'attempt-appserver-chat' });
    expect(fs.readFileSync(outputFile, 'utf8')).toBe(originalOutput);
    const memoryCalls = fs.readFileSync(path.join(context.root, 'memory-calls.log'), 'utf8');
    expect(memoryCalls).toContain(`generate ${command.flowId} implementer`);
    expect(memoryCalls).toContain(`update ${command.flowId} implementer`);
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

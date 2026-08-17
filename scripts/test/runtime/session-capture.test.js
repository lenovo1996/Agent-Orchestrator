'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');

const helper = path.resolve(__dirname, '../../runtimes/session-capture.js');
const codexRuntime = path.resolve(__dirname, '../../runtimes/codex.sh');
const execFile = util.promisify(childProcess.execFile);

function run(args, options = {}) {
  return childProcess.spawnSync(process.execPath, [helper, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

describe('session-capture', () => {
  test('init, stream and finalize create one atomic attempt registry entry', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-capture-'));
    try {
      const initialized = run(['init', '--work-dir', workDir, '--flow-id', 'flow_001', '--step', 'implementer']);
      assert.equal(initialized.status, 0, initialized.stderr);
      const runId = initialized.stdout;
      assert.match(runId, /^[0-9a-f-]{36}$/);

      const stream = run([
        'stream', '--work-dir', workDir, '--step', 'implementer', '--run-id', runId,
      ], {
        input: [
          JSON.stringify({ type: 'thread.started', thread_id: '019fffff-1111-7222-8333-444444444444' }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 5 } }),
          '',
        ].join('\n'),
      });
      assert.equal(stream.status, 0, stream.stderr);
      assert.match(stream.stdout, /thread\.started/);

      const stderrFile = path.join(workDir, 'stderr.txt');
      fs.writeFileSync(stderrFile, '');
      const finalized = run([
        'finalize', '--work-dir', workDir, '--step', 'implementer', '--run-id', runId,
        '--exit-code', '0', '--stderr-file', stderrFile,
      ]);
      assert.equal(finalized.status, 0, finalized.stderr);

      const registryDir = path.join(workDir, 'sessions', 'implementer');
      assert.deepEqual(fs.readdirSync(registryDir), [`${runId}.json`]);
      const attempt = JSON.parse(fs.readFileSync(path.join(registryDir, `${runId}.json`), 'utf8'));
      assert.equal(attempt.threadId, '019fffff-1111-7222-8333-444444444444');
      assert.equal(attempt.status, 'completed');
      assert.equal(attempt.exitCode, 0);
      assert.deepEqual(attempt.usage, {
        inputTokens: 100,
        cachedInputTokens: 80,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      });
      assert.equal(attempt.errorSummary, null);
      assert.ok(attempt.finishedAt);
      assert.equal(fs.readdirSync(registryDir).some((name) => name.endsWith('.tmp')), false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('records a stripped and bounded error when Codex fails before thread.started', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-capture-fail-'));
    try {
      const initialized = run(['init', '--work-dir', workDir, '--flow-id', 'flow_fail', '--step', 'clarifier']);
      const runId = initialized.stdout;
      const stderrFile = path.join(workDir, 'stderr.txt');
      fs.writeFileSync(stderrFile, `noise\n\u001b[31mAuthentication failed\u001b[0m\n`);
      const finalized = run([
        'finalize', '--work-dir', workDir, '--step', 'clarifier', '--run-id', runId,
        '--exit-code', '1', '--stderr-file', stderrFile,
      ]);
      assert.equal(finalized.status, 0, finalized.stderr);
      const attempt = JSON.parse(fs.readFileSync(path.join(workDir, 'sessions', 'clarifier', `${runId}.json`), 'utf8'));
      assert.equal(attempt.threadId, null);
      assert.equal(attempt.status, 'failed');
      assert.deepEqual(attempt.errorSummary, { stage: 'before_thread', message: 'Authentication failed' });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('turn.failed takes precedence over stderr process output', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-capture-turn-'));
    try {
      const runId = run(['init', '--work-dir', workDir, '--flow-id', 'flow_turn', '--step', 'planner']).stdout;
      run(['stream', '--work-dir', workDir, '--step', 'planner', '--run-id', runId], {
        input: `${JSON.stringify({ type: 'thread.started', thread_id: '019fffff-1111-7222-8333-555555555555' })}\n${JSON.stringify({ type: 'turn.failed', error: { message: 'Model rejected request' } })}\n`,
      });
      const stderrFile = path.join(workDir, 'stderr.txt');
      fs.writeFileSync(stderrFile, 'generic process failure\n');
      run(['finalize', '--work-dir', workDir, '--step', 'planner', '--run-id', runId, '--exit-code', '1', '--stderr-file', stderrFile]);
      const attempt = JSON.parse(fs.readFileSync(path.join(workDir, 'sessions', 'planner', `${runId}.json`), 'utf8'));
      assert.deepEqual(attempt.errorSummary, { stage: 'turn', message: 'Model rejected request' });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('parallel attempts in the same work directory retain distinct thread IDs', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-capture-parallel-'));
    try {
      const args = (step) => [helper, 'init', '--work-dir', workDir, '--flow-id', 'flow_parallel', '--step', step];
      const [first, second] = await Promise.all([
        execFile(process.execPath, args('implementer'), { encoding: 'utf8' }),
        execFile(process.execPath, args('verifier'), { encoding: 'utf8' }),
      ]);
      assert.notEqual(first.stdout, second.stdout);

      const pairs = [
        ['implementer', first.stdout, '019fffff-1111-7222-8333-111111111111'],
        ['verifier', second.stdout, '019fffff-1111-7222-8333-222222222222'],
      ];
      for (const [step, runId, threadId] of pairs) {
        const streamed = run(['stream', '--work-dir', workDir, '--step', step, '--run-id', runId], {
          input: `${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`,
        });
        assert.equal(streamed.status, 0, streamed.stderr);
        const metadata = JSON.parse(fs.readFileSync(path.join(workDir, 'sessions', step, `${runId}.json`), 'utf8'));
        assert.equal(metadata.threadId, threadId);
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('codex runtime preserves CLI exit code while capturing JSON events and stderr', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-'));
    try {
      const fakeBin = path.join(workDir, 'bin');
      fs.mkdirSync(fakeBin);
      const fakeCodex = path.join(fakeBin, 'codex');
      fs.writeFileSync(fakeCodex, `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_CODEX_ARGS_FILE"
printf '%s\\n' '{"type":"thread.started","thread_id":"019fffff-1111-7222-8333-333333333333"}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":40,"cached_input_tokens":20,"output_tokens":2,"reasoning_output_tokens":1}}'
printf '%s\\n' 'model process failed' >&2
exit 7
`);
      fs.chmodSync(fakeCodex, 0o755);
      const prompt = path.join(workDir, 'prompt.txt');
      const log = path.join(workDir, 'implementer.log');
      const argsFile = path.join(workDir, 'args.txt');
      fs.writeFileSync(prompt, 'Implement the task');

      const result = childProcess.spawnSync('bash', [
        codexRuntime, prompt, log, workDir, workDir, 'flow_runtime', 'implementer',
      ], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_CODEX_ARGS_FILE: argsFile },
      });
      assert.equal(result.status, 7);
      assert.match(fs.readFileSync(argsFile, 'utf8'), /exec\n--json\n-\n/);
      const logContent = fs.readFileSync(log, 'utf8');
      assert.match(logContent, /thread\.started/);
      assert.match(logContent, /model process failed/);

      const registry = path.join(workDir, 'sessions', 'implementer');
      const names = fs.readdirSync(registry);
      assert.equal(names.length, 1);
      const metadata = JSON.parse(fs.readFileSync(path.join(registry, names[0]), 'utf8'));
      assert.equal(metadata.threadId, '019fffff-1111-7222-8333-333333333333');
      assert.equal(metadata.status, 'failed');
      assert.equal(metadata.exitCode, 7);
      assert.deepEqual(metadata.usage, { inputTokens: 40, cachedInputTokens: 20, outputTokens: 2, reasoningOutputTokens: 1 });
      assert.deepEqual(metadata.errorSummary, { stage: 'process', message: 'model process failed' });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

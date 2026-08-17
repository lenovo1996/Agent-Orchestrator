import { describe, expect, it } from 'vitest';
import { parseRolloutRecords } from './parser.js';

function record(ordinal: number | undefined, type: string, payload: object, timestamp = '2026-08-17T00:00:00.000Z') {
  return { ...(ordinal === undefined ? {} : { ordinal }), timestamp, type, payload };
}

describe('parseRolloutRecords', () => {
  it('normalizes current Codex messages, commands, patches, plan, search, tools and stats', () => {
    const parsed = parseRolloutRecords([
      record(0, 'session_meta', { timestamp: '2026-08-17T00:00:00.000Z', cli_version: '0.147.0', cwd: '/secret', base_instructions: 'hidden' }),
      record(1, 'response_item', { type: 'message', id: 'dev', role: 'developer', content: [{ type: 'input_text', text: 'hidden developer' }] }),
      record(2, 'response_item', { type: 'message', id: 'sys', role: 'system', content: [{ type: 'input_text', text: 'hidden system' }] }),
      record(3, 'world_state', { full: { secret: true } }),
      record(4, 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5', cwd: '/secret' }),
      record(5, 'response_item', { type: 'message', id: 'user', role: 'user', content: [{ type: 'input_text', text: 'Build it' }] }),
      record(6, 'response_item', { type: 'message', id: 'comment', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Working' }] }),
      record(7, 'response_item', { type: 'reasoning', id: 'reason', summary: [{ type: 'summary_text', text: 'Consider options' }], encrypted_content: 'hidden' }),
      record(8, 'event_msg', { type: 'item_started', turn_id: 'turn-1', item: { type: 'CommandExecution', id: 'cmd-1', command: ['/bin/sh', '-lc', 'npm test'], status: 'running' } }),
      record(9, 'event_msg', { type: 'item_completed', turn_id: 'turn-1', item: { type: 'CommandExecution', id: 'cmd-1', command: ['/bin/sh', '-lc', 'npm test'], status: 'completed', aggregated_output: '42 tests passed', exit_code: 0, duration: { ms: 1200 } } }),
      record(10, 'response_item', { type: 'custom_tool_call', id: 'patch', call_id: 'patch-call', name: 'apply_patch', status: 'completed', input: '*** Begin Patch\n*** Update File: /home/user/project/src/a.ts\n@@\n-old\n+new\n*** End Patch' }),
      record(11, 'response_item', { type: 'custom_tool_call_output', call_id: 'patch-call', output: 'Done!' }),
      record(12, 'response_item', { type: 'function_call', id: 'plan', call_id: 'plan-call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Ship', status: 'in_progress' }] }) }),
      record(13, 'response_item', { type: 'function_call_output', call_id: 'plan-call', output: '{}' }),
      record(14, 'response_item', { type: 'function_call', id: 'search', call_id: 'search-call', name: 'web__run', arguments: JSON.stringify({ search_query: [{ q: 'Codex docs' }] }) }),
      record(15, 'response_item', { type: 'function_call_output', call_id: 'search-call', output: 'results' }),
      record(16, 'response_item', { type: 'function_call', id: 'mcp', call_id: 'mcp-call', name: 'mcp__jira__get', arguments: '{"key":"ABC-1"}' }),
      record(17, 'response_item', { type: 'function_call_output', call_id: 'mcp-call', output: '{"ok":true}' }),
      record(18, 'response_item', { type: 'message', id: 'final', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done' }] }),
      record(19, 'response_item', { type: 'future_item', secret: 'never expose' }),
      record(20, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 25, reasoning_output_tokens: 10 } } }),
      record(21, 'event_msg', { type: 'task_complete', turn_id: 'turn-1', duration_ms: 5000 }, '2026-08-17T00:01:00.000Z'),
    ]);

    expect(parsed.header).toMatchObject({ model: 'gpt-5.5', cliVersion: '0.147.0' });
    expect(parsed.items.map((item) => item.kind)).toEqual([
      'message', 'message', 'reasoning', 'command', 'patch', 'plan', 'search', 'tool', 'message', 'unknown',
    ]);
    expect(parsed.items.map((item) => item.text).join(' ')).not.toContain('hidden developer');
    expect(JSON.stringify(parsed)).not.toContain('/secret');
    expect(parsed.items.find((item) => item.kind === 'command')).toMatchObject({ command: 'npm test', status: 'completed', exitCode: 0 });
    const patch = parsed.items.find((item) => item.kind === 'patch')!;
    expect(patch.filePaths).toEqual(['a.ts']);
    expect(parsed.details.get(patch.id)?.diff).toContain('+new');
    expect(parsed.items.find((item) => item.kind === 'plan')?.plan).toEqual([{ step: 'Ship', status: 'in_progress' }]);
    expect(parsed.stats).toMatchObject({ turns: 1, commands: 1, patches: 1, filesTouched: 1, totalTokens: 125 });
    expect(parsed.stats.usage).toEqual({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 25, reasoningOutputTokens: 10 });
  });

  it('matches lifecycle output by call_id and keeps write_stdin separate from the command item', () => {
    const parsed = parseRolloutRecords([
      record(1, 'response_item', { type: 'custom_tool_call', call_id: 'exec-call', name: 'exec', input: 'tool wrapper' }),
      record(2, 'event_msg', { type: 'item_started', item: { type: 'CommandExecution', id: 'process-1', command: ['bash'], status: 'running' } }),
      record(3, 'response_item', { type: 'function_call', call_id: 'stdin-call', name: 'write_stdin', arguments: '{"chars":"y"}' }),
      record(4, 'response_item', { type: 'function_call_output', call_id: 'stdin-call', output: 'accepted' }),
      record(5, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'process-1', command: ['bash'], status: 'completed', aggregated_output: 'done' } }),
      record(6, 'response_item', { type: 'custom_tool_call_output', call_id: 'exec-call', output: 'wrapper result' }),
    ]);
    expect(parsed.items.filter((item) => item.kind === 'command')).toHaveLength(1);
    expect(parsed.items.filter((item) => item.kind === 'tool')).toHaveLength(2);
    expect(new Set(parsed.items.map((item) => item.id)).size).toBe(parsed.items.length);
  });

  it('creates stable fallback IDs for legacy records without ordinal', () => {
    const records = [record(undefined, 'response_item', { type: 'message', role: 'user', content: [{ text: 'legacy' }] })];
    expect(parseRolloutRecords(records).items[0].id).toBe(parseRolloutRecords(records).items[0].id);
  });

  it('marks a failed apply_patch result without exposing the diff in its summary', () => {
    const parsed = parseRolloutRecords([
      record(1, 'response_item', { type: 'custom_tool_call', call_id: 'patch-fail', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' }),
      record(2, 'response_item', { type: 'custom_tool_call_output', call_id: 'patch-fail', output: 'apply_patch failed: context mismatch' }),
    ]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ id: 'ordinal-1', kind: 'patch', status: 'failed', hasDetail: true });
    expect(parsed.items[0] as any).not.toHaveProperty('diff');
    expect(parsed.details.get('ordinal-1')?.diff).toContain('*** Begin Patch');
  });
});

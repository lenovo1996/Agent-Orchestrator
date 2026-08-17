import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import * as zlib from 'node:zlib';
import type {
  SessionHeader,
  SessionItemDetail,
  SessionItemKind,
  SessionItemSummary,
  SessionStats,
  SessionUsage,
} from '@devteam-dashboard/shared';

type JsonObject = Record<string, any>;

export interface ParsedSession {
  header: SessionHeader;
  stats: SessionStats;
  items: SessionItemSummary[];
  details: Map<string, SessionItemDetail>;
  diagnostics: string[];
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => typeof part === 'string' ? part : part?.text || part?.content || '')
    .filter(Boolean)
    .join('\n');
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ''); }
}

function parseJson(value: unknown): JsonObject | null {
  if (value && typeof value === 'object') return value as JsonObject;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value) as JsonObject; } catch { return null; }
}

function preview(value: unknown, limit = 240): string {
  const compact = stringify(value).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function usageFrom(value: JsonObject | undefined): SessionUsage | null {
  if (!value) return null;
  return {
    inputTokens: Number(value.input_tokens ?? value.inputTokens ?? 0),
    cachedInputTokens: Number(value.cached_input_tokens ?? value.cachedInputTokens ?? 0),
    outputTokens: Number(value.output_tokens ?? value.outputTokens ?? 0),
    reasoningOutputTokens: Number(value.reasoning_output_tokens ?? value.reasoningOutputTokens ?? 0),
  };
}

function fallbackId(timestamp: string, discriminator: string, sequence: number): string {
  return `legacy-${crypto.createHash('sha1').update(`${timestamp}:${discriminator}:${sequence}`).digest('hex').slice(0, 20)}`;
}

function recordId(record: JsonObject, discriminator: string, sequence: number): string {
  return Number.isInteger(record.ordinal)
    ? `ordinal-${record.ordinal}`
    : fallbackId(String(record.timestamp || ''), discriminator, sequence);
}

function normalizedDuration(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const duration = value as JsonObject;
    if (Number.isFinite(duration.ms)) return Number(duration.ms);
    if (Number.isFinite(duration.secs)) return Number(duration.secs) * 1000;
  }
  return null;
}

function safeFilePath(value: string): string {
  if (!value) return value;
  return value.startsWith('/') ? value.split('/').filter(Boolean).at(-1) || '' : value.replace(/^\.\//, '');
}

function patchFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/)
      || line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (match && match[1] !== '/dev/null') files.add(safeFilePath(match[1].trim()));
  }
  return [...files].filter(Boolean);
}

function commandText(command: unknown): string {
  if (Array.isArray(command)) {
    if (command.length >= 3 && ['-lc', '-c'].includes(String(command.at(-2)))) return String(command.at(-1));
    return command.map(String).join(' ');
  }
  return stringify(command);
}

function nestedValue(value: JsonObject | null, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as JsonObject)[key];
  }
  return current;
}

function toolExitCode(payload: JsonObject, parsedOutput: JsonObject | null, output: string): number | null {
  const candidates = [
    payload.exit_code,
    payload.exitCode,
    nestedValue(payload, ['metadata', 'exit_code']),
    parsedOutput?.exit_code,
    parsedOutput?.exitCode,
    nestedValue(parsedOutput, ['structuredContent', 'exit_code']),
    nestedValue(parsedOutput, ['structuredContent', 'exitCode']),
    nestedValue(parsedOutput, ['result', 'exit_code']),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
    if (typeof candidate === 'string' && /^-?\d+$/.test(candidate.trim())) return Number(candidate);
  }
  const match = output.match(/\b(?:process\s+)?exit(?:ed)?(?:\s+with)?\s+code\s*[:=]?\s*(-?\d+)\b/i)
    || output.match(/\bexit_code["']?\s*[:=]\s*(-?\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function toolResultStatus(payload: JsonObject, output: string, kind: SessionItemKind): { status: string; exitCode: number | null } {
  const parsedOutput = parseJson(payload.output ?? payload.tools ?? payload.execution);
  const explicitStatus = String(payload.status || parsedOutput?.status || '').toLowerCase();
  const isError = payload.isError === true
    || payload.is_error === true
    || parsedOutput?.isError === true
    || parsedOutput?.is_error === true;
  const exitCode = toolExitCode(payload, parsedOutput, output);

  if (isError || /^(?:failed|error|aborted)$/.test(explicitStatus)) return { status: 'failed', exitCode };
  if (exitCode !== null) return { status: exitCode === 0 ? 'completed' : 'failed', exitCode };
  if (payload.success === false || parsedOutput?.success === false) return { status: 'failed', exitCode };
  if (/^(?:completed|success|succeeded)$/.test(explicitStatus) || payload.success === true || parsedOutput?.success === true) {
    return { status: 'completed', exitCode };
  }

  // Plain tool output has no universal status schema. Only treat an explicit
  // leading error as failure; successful command output can legitimately
  // contain words such as "0 failed" or "error count: 0".
  const failed = kind === 'patch'
    ? /\b(?:failed|error)\b/i.test(output)
    : /^\s*(?:error|failed|tool call failed)\b/i.test(output);
  return { status: failed ? 'failed' : 'completed', exitCode };
}

export function parseRolloutRecords(records: JsonObject[]): ParsedSession {
  const items = new Map<string, SessionItemSummary>();
  const details = new Map<string, SessionItemDetail>();
  const calls = new Map<string, string>();
  const lifecycleItems = new Map<string, string>();
  const diagnostics: string[] = [];
  const turns = new Set<string>();
  let cliVersion: string | null = null;
  let model: string | null = null;
  let startedAt = '';
  let finishedAt: string | null = null;
  let activeDurationMs = 0;
  let usage: SessionUsage | null = null;
  let sequence = 0;

  const put = (item: SessionItemSummary, detail?: SessionItemDetail) => {
    const previous = items.get(item.id);
    items.set(item.id, previous ? { ...previous, ...item } : item);
    if (detail) details.set(item.id, { ...details.get(item.id), ...detail });
  };

  for (const record of records) {
    sequence += 1;
    const payload = record.payload || {};
    const timestamp = String(record.timestamp || startedAt || new Date(0).toISOString());
    const ordinal = Number.isInteger(record.ordinal) ? Number(record.ordinal) : null;

    if (record.type === 'session_meta') {
      cliVersion = typeof payload.cli_version === 'string' ? payload.cli_version : cliVersion;
      startedAt = String(payload.timestamp || timestamp);
      continue;
    }
    if (record.type === 'turn_context') {
      model = typeof payload.model === 'string' ? payload.model : model;
      if (payload.turn_id) turns.add(String(payload.turn_id));
      continue;
    }
    if (record.type === 'world_state') continue;

    if (record.type === 'event_msg') {
      if (payload.turn_id) turns.add(String(payload.turn_id));
      if (payload.type === 'token_count') {
        usage = usageFrom(payload.info?.total_token_usage) || usage;
        continue;
      }
      if (payload.type === 'task_complete') {
        finishedAt = timestamp;
        if (Number.isFinite(payload.duration_ms)) activeDurationMs += Number(payload.duration_ms);
        continue;
      }
      if (['error', 'turn_failed', 'turn_aborted', 'aborted'].includes(payload.type)) {
        const id = recordId(record, payload.type, sequence);
        put({
          id, ordinal, kind: 'error', timestamp,
          title: payload.type === 'turn_aborted' || payload.type === 'aborted' ? 'Turn aborted' : 'Session error',
          text: preview(payload.message || payload.error || payload.type, 500),
          status: payload.type,
          hasDetail: false,
        });
        continue;
      }

      if ((payload.type === 'item_started' || payload.type === 'item_completed') && payload.item) {
        const eventItem = payload.item as JsonObject;
        const itemType = String(eventItem.type || '');
        if (itemType === 'CommandExecution') {
          const lifecycleKey = String(eventItem.id || '');
          const id = lifecycleItems.get(lifecycleKey) || recordId(record, `command:${lifecycleKey}`, sequence);
          if (lifecycleKey) lifecycleItems.set(lifecycleKey, id);
          const previous = items.get(id);
          const output = stringify(eventItem.aggregated_output || eventItem.formatted_output || '');
          put({
            id, ordinal: previous?.ordinal ?? ordinal, kind: 'command', timestamp: previous?.timestamp ?? timestamp,
            turnId: payload.turn_id ? String(payload.turn_id) : undefined,
            title: 'Command', command: commandText(eventItem.command),
            status: String(eventItem.status || (payload.type === 'item_started' ? 'running' : 'completed')),
            exitCode: Number.isInteger(eventItem.exit_code) ? eventItem.exit_code : null,
            durationMs: normalizedDuration(eventItem.duration),
            outputPreview: preview(output), hasDetail: Boolean(output || eventItem.stdout || eventItem.stderr),
          }, {
            id,
            output,
            stdout: stringify(eventItem.stdout || ''),
            stderr: stringify(eventItem.stderr || ''),
          });
          continue;
        }
        if (itemType === 'Plan') {
          const lifecycleKey = String(eventItem.id || '');
          const id = lifecycleItems.get(lifecycleKey) || recordId(record, `plan:${lifecycleKey}`, sequence);
          if (lifecycleKey) lifecycleItems.set(lifecycleKey, id);
          const parsed = parseJson(eventItem.text) || eventItem;
          const plan = Array.isArray(parsed.plan) ? parsed.plan.map((entry: JsonObject) => ({
            step: String(entry.step || entry.text || ''), status: String(entry.status || 'pending'),
          })) : [];
          put({
            id, ordinal, kind: 'plan', timestamp, title: 'Plan updated', plan,
            text: plan.length === 0 && typeof eventItem.text === 'string' ? eventItem.text : undefined,
            hasDetail: false,
          });
          continue;
        }
        if (itemType === 'Extension' && (eventItem.query || eventItem.action === 'search')) {
          const lifecycleKey = String(eventItem.id || '');
          const id = lifecycleItems.get(lifecycleKey) || recordId(record, `search:${lifecycleKey}`, sequence);
          if (lifecycleKey) lifecycleItems.set(lifecycleKey, id);
          const result = stringify(eventItem.results || '');
          put({
            id, ordinal, kind: 'search', timestamp, title: 'Web search',
            text: stringify(eventItem.query || ''), status: String(eventItem.status || 'completed'),
            outputPreview: preview(result), hasDetail: Boolean(result),
          }, { id, toolOutput: result });
          continue;
        }
      }
      continue;
    }

    if (record.type !== 'response_item') continue;

    if (payload.type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') continue;
      const text = textContent(payload.content);
      if (!text) continue;
      const id = recordId(record, `message:${String(payload.id || '')}`, sequence);
      put({
        id, ordinal, kind: 'message', timestamp,
        role: payload.role,
        phase: payload.role === 'assistant'
          ? (payload.phase === 'final_answer' ? 'final' : 'commentary')
          : undefined,
        text, hasDetail: false,
      });
      continue;
    }

    if (payload.type === 'reasoning') {
      const summary = textContent(payload.summary) || textContent(payload.summary_text);
      if (!summary) continue;
      const id = recordId(record, `reasoning:${String(payload.id || '')}`, sequence);
      put({ id, ordinal, kind: 'reasoning', timestamp, title: 'Reasoning summary', text: summary, hasDetail: false });
      continue;
    }

    if (payload.type === 'custom_tool_call' || payload.type === 'function_call' || payload.type === 'tool_search_call') {
      const callId = String(payload.call_id || payload.id || recordId(record, 'tool', sequence));
      const id = recordId(record, `call:${callId}`, sequence);
      const name = String(payload.name || (payload.type === 'tool_search_call' ? 'tool_search' : 'tool'));
      const input = stringify(payload.input ?? payload.arguments ?? payload.execution ?? '');
      const parsedInput = parseJson(payload.input ?? payload.arguments);
      let kind: SessionItemKind = 'tool';
      if (name === 'apply_patch') kind = 'patch';
      else if (/search|web__run|web\.run/i.test(name)) kind = 'search';
      else if (name === 'update_plan') kind = 'plan';

      const plan = kind === 'plan' && Array.isArray(parsedInput?.plan)
        ? parsedInput!.plan.map((entry: JsonObject) => ({ step: String(entry.step || ''), status: String(entry.status || 'pending') }))
        : undefined;
      const filePaths = kind === 'patch' ? patchFiles(input) : undefined;
      put({
        id, ordinal, kind, timestamp, callId, toolName: name,
        title: kind === 'patch' ? 'File changes' : kind === 'plan' ? 'Plan updated' : kind === 'search' ? 'Web search' : name === 'tool_search' ? 'Tool search' : name,
        text: kind === 'search' ? preview(parsedInput?.search_query || parsedInput?.query || input, 500) : undefined,
        status: String(payload.status || 'running'),
        filePaths, plan, hasDetail: kind !== 'plan',
      }, kind === 'patch' ? { id, diff: input } : { id, toolInput: input });
      calls.set(callId, id);
      continue;
    }

    if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output' || payload.type === 'tool_search_output') {
      const callId = String(payload.call_id || '');
      const id = calls.get(callId);
      if (!id) {
        diagnostics.push(`Unmatched tool output: ${callId || '<missing call_id>'}`);
        continue;
      }
      const output = stringify(payload.output ?? payload.tools ?? payload.execution ?? '');
      const existing = items.get(id)!;
      const result = toolResultStatus(payload, output, existing.kind);
      put({
        ...existing,
        status: result.status,
        exitCode: result.exitCode,
        outputPreview: preview(output),
        hasDetail: true,
      }, existing.kind === 'patch' ? { id, toolOutput: output } : { id, toolOutput: output });
      continue;
    }

    const id = recordId(record, String(payload.type || 'unknown'), sequence);
    put({
      id, ordinal, kind: 'unknown', timestamp,
      title: `Unknown event: ${String(payload.type || 'response_item')}`,
      hasDetail: false,
    });
  }

  const sortedItems = [...items.values()].sort((a, b) => {
    if (a.ordinal !== null && b.ordinal !== null) return a.ordinal - b.ordinal;
    if (a.ordinal !== null) return -1;
    if (b.ordinal !== null) return 1;
    return a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
  });
  const files = new Set(sortedItems.flatMap((item) => item.filePaths || []));
  const commands = sortedItems.filter((item) => item.kind === 'command' || item.toolName === 'exec_command').length;
  const patches = sortedItems.filter((item) => item.kind === 'patch').length;
  const totalTokens = usage ? usage.inputTokens + usage.outputTokens : 0;
  const startMs = Date.parse(startedAt);
  const finishMs = finishedAt ? Date.parse(finishedAt) : NaN;

  return {
    header: {
      model, cliVersion,
      startedAt: startedAt || new Date(0).toISOString(),
      finishedAt,
      totalDurationMs: Number.isFinite(startMs) && Number.isFinite(finishMs) ? finishMs - startMs : null,
      activeDurationMs: activeDurationMs || null,
    },
    stats: { turns: turns.size, commands, patches, filesTouched: files.size, usage, totalTokens },
    items: sortedItems,
    details,
    diagnostics,
  };
}

export async function readRollout(filePath: string, compressed: boolean): Promise<ParsedSession> {
  const records: JsonObject[] = [];
  const diagnostics: string[] = [];
  const file = fs.createReadStream(filePath);
  const input = compressed
    ? file.pipe((zlib as typeof zlib & { createZstdDecompress: () => NodeJS.ReadWriteStream }).createZstdDecompress())
    : file;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch (error) { diagnostics.push(`Line ${lineNumber}: ${(error as Error).message}`); }
  }
  const result = parseRolloutRecords(records);
  result.diagnostics.unshift(...diagnostics);
  return result;
}

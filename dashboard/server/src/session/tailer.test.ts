import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTailer } from './tailer.js';

describe('JsonlTailer', () => {
  let directory: string;
  let file: string;
  let tailer: JsonlTailer;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tailer-'));
    file = path.join(directory, 'rollout.jsonl');
    fs.writeFileSync(file, '');
    tailer = new JsonlTailer(file);
  });

  afterEach(() => {
    tailer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('commits only complete lines and handles multiple records per read', async () => {
    const records: object[] = [];
    tailer.on('record', (value) => records.push(value));
    fs.writeFileSync(file, '{"a":1}\n{"b"');
    await tailer.poll();
    expect(records).toEqual([{ a: 1 }]);
    expect(tailer.partialLine).toBe('{"b"');
    expect(tailer.offset).toBe(Buffer.byteLength('{"a":1}\n'));

    fs.appendFileSync(file, ':2}\n{"c":3}\n');
    await tailer.poll();
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(tailer.partialLine).toBe('');
  });

  it('skips malformed lines and continues parsing', async () => {
    const records: object[] = [];
    const diagnostic = vi.fn();
    tailer.on('record', (value) => records.push(value));
    tailer.on('diagnostic', diagnostic);
    fs.writeFileSync(file, 'not json\n{"ok":true}\n');
    await tailer.poll();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(records).toEqual([{ ok: true }]);
  });

  it('resets on truncate and rename/recreate', async () => {
    const records: object[] = [];
    const reset = vi.fn();
    tailer.on('record', (value) => records.push(value));
    tailer.on('reset', reset);
    fs.writeFileSync(file, '{"first":true}\n');
    await tailer.poll();
    fs.writeFileSync(file, '{"x":1}\n');
    await tailer.poll();
    expect(reset).toHaveBeenCalledTimes(1);

    fs.renameSync(file, path.join(directory, 'old.jsonl'));
    fs.writeFileSync(file, '{"replacement":true}\n');
    await tailer.poll();
    expect(reset).toHaveBeenCalledTimes(2);
    expect(records.at(-1)).toEqual({ replacement: true });
  });

  it('does not skip an in-progress partial line when starting at the end', async () => {
    tailer.close();
    fs.writeFileSync(file, '{"old":true}\n{"live"');
    tailer = new JsonlTailer(file, { startAtEnd: true });
    const records: object[] = [];
    tailer.on('record', (value) => records.push(value));
    tailer.start();
    fs.appendFileSync(file, ':true}\n');
    await tailer.poll();
    expect(records).toEqual([{ live: true }]);
  });

  it('refuses a symlink that escapes the configured rollout root', () => {
    tailer.close();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tailer-outside-'));
    try {
      const outsideFile = path.join(outside, 'outside.jsonl');
      fs.writeFileSync(outsideFile, '{"secret":true}\n');
      fs.rmSync(file);
      fs.symlinkSync(outsideFile, file);
      tailer = new JsonlTailer(file, { allowedRoot: directory });
      expect(() => tailer.start()).toThrow(/outside the configured Codex home/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionResolver } from './resolver.js';

describe('SessionResolver', () => {
  let root: string;
  const threadId = '019fffff-1111-7222-8333-444444444444';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resolver-'));
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(root, 'archived_sessions'), { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('resolves date candidates across a one-day boundary and prefers plain JSONL', () => {
    const directory = path.join(root, 'sessions', '2026', '08', '16');
    fs.mkdirSync(directory, { recursive: true });
    const compressed = path.join(directory, `rollout-${threadId}.jsonl.zst`);
    const plain = path.join(directory, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(compressed, 'compressed');
    fs.writeFileSync(plain, '{}\n');

    const result = new SessionResolver(root).resolve(threadId, '2026-08-17T00:01:00.000Z');
    expect(result).toEqual({ path: fs.realpathSync(plain), compressed: false });
  });

  it('resolves archived and recursive fallback sessions', () => {
    const archived = path.join(root, 'archived_sessions', `rollout-${threadId}.jsonl.zst`);
    fs.writeFileSync(archived, 'zstd');
    expect(new SessionResolver(root).resolve(threadId, '2026-08-17T00:00:00Z')).toEqual({
      path: fs.realpathSync(archived), compressed: true,
    });

    fs.rmSync(archived);
    const oldDir = path.join(root, 'sessions', '2020', '01', '02');
    fs.mkdirSync(oldDir, { recursive: true });
    const old = path.join(oldDir, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(old, '{}\n');
    const resolver = new SessionResolver(root);
    expect(resolver.resolve(threadId, '2026-08-17T00:00:00Z')?.path).toBe(fs.realpathSync(old));
    fs.rmSync(old);
    expect(resolver.resolve(threadId, '2026-08-17T00:00:00Z')).toBeNull();
  });

  it('rejects invalid thread IDs and symlinks escaping Codex home', () => {
    expect(new SessionResolver(root).resolve('../../etc/passwd', '2026-08-17T00:00:00Z')).toBeNull();

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'session-outside-'));
    try {
      const target = path.join(outside, `rollout-${threadId}.jsonl`);
      fs.writeFileSync(target, '{}\n');
      const directory = path.join(root, 'sessions', '2026', '08', '17');
      fs.mkdirSync(directory, { recursive: true });
      fs.symlinkSync(target, path.join(directory, `rollout-${threadId}.jsonl`));
      expect(new SessionResolver(root).resolve(threadId, '2026-08-17T00:00:00Z')).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

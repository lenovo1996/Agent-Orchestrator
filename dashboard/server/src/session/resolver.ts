import fs from 'node:fs';
import path from 'node:path';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedRollout {
  path: string;
  compressed: boolean;
}

function datesAround(startedAt: string): string[] {
  const center = new Date(startedAt);
  if (Number.isNaN(center.getTime())) return [];
  return [-1, 0, 1].map((delta) => {
    const date = new Date(center.getTime() + delta * 86_400_000);
    return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('/');
  });
}

function containedRealPath(candidate: string, codexHome: string): string | null {
  try {
    const root = fs.realpathSync(codexHome);
    const resolved = fs.realpathSync(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function choose(files: string[], codexHome: string): ResolvedRollout | null {
  const matches = files
    .filter((file) => file.endsWith('.jsonl') || file.endsWith('.jsonl.zst'))
    .sort((a, b) => Number(a.endsWith('.zst')) - Number(b.endsWith('.zst')));
  for (const file of matches) {
    const resolved = containedRealPath(file, codexHome);
    if (resolved) return { path: resolved, compressed: resolved.endsWith('.zst') };
  }
  return null;
}

function matchingFiles(directory: string, threadId: string): string[] {
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.includes(threadId))
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

function recursiveMatches(root: string, threadId: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.includes(threadId)) result.push(target);
    }
  };
  visit(root);
  return result;
}

export class SessionResolver {
  private readonly fallbackCache = new Map<string, ResolvedRollout | null>();

  constructor(private readonly codexHome: string) {}

  resolve(threadId: string, startedAt: string): ResolvedRollout | null {
    if (!THREAD_ID.test(threadId)) return null;

    for (const date of datesAround(startedAt)) {
      const result = choose(
        matchingFiles(path.join(this.codexHome, 'sessions', ...date.split('/')), threadId),
        this.codexHome,
      );
      if (result) return result;
    }

    const archived = choose(matchingFiles(path.join(this.codexHome, 'archived_sessions'), threadId), this.codexHome);
    if (archived) return archived;

    if (this.fallbackCache.has(threadId)) {
      const cached = this.fallbackCache.get(threadId);
      if (!cached) return null;
      const securePath = containedRealPath(cached.path, this.codexHome);
      return securePath ? { path: securePath, compressed: securePath.endsWith('.zst') } : null;
    }
    const result = choose([
      ...recursiveMatches(path.join(this.codexHome, 'sessions'), threadId),
      ...recursiveMatches(path.join(this.codexHome, 'archived_sessions'), threadId),
    ], this.codexHome);
    this.fallbackCache.set(threadId, result);
    return result;
  }
}

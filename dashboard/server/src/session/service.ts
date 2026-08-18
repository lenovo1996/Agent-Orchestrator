import fs from 'node:fs';
import path from 'node:path';
import type { OrchestrationService, StepAttemptRecord } from '@devteam-dashboard/orchestration';
import type {
  SessionAttemptSummary,
  SessionItemDetail,
  SessionSnapshot,
} from '@devteam-dashboard/shared';
import { readAttempt } from './registry.js';
import { readRollout, type ParsedSession } from './parser.js';
import { SessionResolver, type ResolvedRollout } from './resolver.js';

interface CacheEntry {
  signature: string;
  accessedAt: number;
  parsed: ParsedSession;
}

const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 32;

function emptyStats(attempt: SessionAttemptSummary) {
  const usage = attempt.usage;
  return {
    turns: 0,
    commands: 0,
    patches: 0,
    filesTouched: 0,
    usage,
    totalTokens: usage ? usage.inputTokens + usage.outputTokens : 0,
  };
}

export interface SessionServiceConfig {
  taskFlowsDir: string;
  codexHome: string;
}

export class SessionService {
  private readonly resolver: SessionResolver;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: SessionServiceConfig,
    private readonly orchestration: OrchestrationService,
  ) {
    this.resolver = new SessionResolver(config.codexHome);
  }

  get rolloutRoot(): string {
    return this.config.codexHome;
  }

  private redact(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const roots = new Set([this.config.codexHome]);
    try { roots.add(fs.realpathSync(this.config.codexHome)); } catch { /* home may not exist yet */ }
    let result = value;
    for (const root of roots) {
      if (root) result = result.split(root).join('$CODEX_HOME');
    }
    return result;
  }

  private sanitizedParsed(parsed: ParsedSession): ParsedSession {
    const items = parsed.items.map((item) => ({
      ...item,
      text: this.redact(item.text),
      title: this.redact(item.title),
      command: this.redact(item.command),
      outputPreview: this.redact(item.outputPreview),
      filePaths: item.filePaths?.map((file) => this.redact(file) || ''),
    }));
    const details = new Map<string, SessionItemDetail>();
    for (const [id, detail] of parsed.details) {
      details.set(id, {
        id,
        output: this.redact(detail.output),
        stdout: this.redact(detail.stdout),
        stderr: this.redact(detail.stderr),
        diff: this.redact(detail.diff),
        toolInput: this.redact(detail.toolInput),
        toolOutput: this.redact(detail.toolOutput),
      });
    }
    return { ...parsed, items, details };
  }

  private validateWorkspace(flowId: string, workspaceName?: string | null): void {
    const flow = this.orchestration.getFlow(flowId);
    if (workspaceName && flow.workspaceId !== workspaceName && flow.workspaceName !== workspaceName) {
      throw new Error('Flow not found in selected workspace');
    }
  }

  private summary(attempt: StepAttemptRecord): SessionAttemptSummary {
    const fromFile = readAttempt(this.attemptPath(
      attempt.flowId, attempt.step, attempt.sessionRunId,
    ));
    if (fromFile?.attemptId === attempt.id || (fromFile?.schemaVersion === 1 && fromFile.runId === attempt.sessionRunId)) {
      return fromFile;
    }
    return {
      schemaVersion: 2,
      runId: attempt.sessionRunId,
      attemptId: attempt.id,
      inngestRunId: attempt.inngestRunId,
      inngestAttempt: attempt.inngestAttempt,
      flowId: attempt.flowId,
      step: attempt.step,
      threadId: null,
      status: attempt.status === 'queued' ? 'starting' : attempt.status === 'running' ? 'running'
        : attempt.status === 'completed' ? 'completed' : 'failed',
      startedAt: attempt.startedAt || attempt.createdAt,
      finishedAt: attempt.finishedAt,
      exitCode: attempt.exitCode,
      usage: null,
      errorSummary: attempt.error ? {
        stage: attempt.error.stage === 'process' ? 'process' : 'before_thread',
        message: attempt.error.message,
      } : null,
    };
  }

  list(flowId: string, step: string, workspaceName?: string | null): SessionAttemptSummary[] {
    this.validateWorkspace(flowId, workspaceName);
    return this.orchestration.listAttempts(flowId, step).map((attempt) => this.summary(attempt));
  }

  attemptPath(flowId: string, step: string, runId: string, workspaceName?: string | null): string {
    this.validateWorkspace(flowId, workspaceName);
    const attempt = this.orchestration.listAttempts(flowId, step)
      .find((candidate) => candidate.sessionRunId === runId);
    if (!attempt) throw new Error('Session attempt not found');
    return path.join(this.orchestration.artifactDirectory(flowId), 'sessions', step, `${runId}.json`);
  }

  getAttempt(flowId: string, step: string, runId: string, workspaceName?: string | null): SessionAttemptSummary | null {
    this.validateWorkspace(flowId, workspaceName);
    const attempt = this.orchestration.listAttempts(flowId, step)
      .find((candidate) => candidate.sessionRunId === runId);
    return attempt ? this.summary(attempt) : null;
  }

  resolve(attempt: SessionAttemptSummary): ResolvedRollout | null {
    return attempt.threadId ? this.resolver.resolve(attempt.threadId, attempt.startedAt) : null;
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.accessedAt > CACHE_TTL_MS) this.cache.delete(key);
    }
    if (this.cache.size <= MAX_CACHE_ENTRIES) return;
    const oldest = [...this.cache.entries()].sort((a, b) => a[1].accessedAt - b[1].accessedAt);
    for (const [key] of oldest.slice(0, this.cache.size - MAX_CACHE_ENTRIES)) this.cache.delete(key);
  }

  async parsed(rollout: ResolvedRollout): Promise<ParsedSession> {
    const stat = await fs.promises.stat(rollout.path);
    const signature = `${stat.mtimeMs}:${stat.size}`;
    const existing = this.cache.get(rollout.path);
    if (existing?.signature === signature) {
      existing.accessedAt = Date.now();
      return existing.parsed;
    }
    const parsed = this.sanitizedParsed(await readRollout(rollout.path, rollout.compressed));
    this.cache.set(rollout.path, { signature, accessedAt: Date.now(), parsed });
    this.evict();
    return parsed;
  }

  async snapshot(
    flowId: string,
    step: string,
    runId: string,
    workspaceName?: string | null,
  ): Promise<SessionSnapshot | null> {
    const attempt = this.getAttempt(flowId, step, runId, workspaceName);
    if (!attempt) return null;
    const rollout = this.resolve(attempt);
    if (!rollout) {
      return { attempt, header: null, stats: emptyStats(attempt), items: [], rolloutAvailable: false };
    }

    try {
      const parsed = await this.parsed(rollout);
      const start = Date.parse(attempt.startedAt);
      const finish = attempt.finishedAt ? Date.parse(attempt.finishedAt) : NaN;
      const usage = attempt.usage || parsed.stats.usage;
      return {
        attempt,
        rolloutAvailable: true,
        header: {
          ...parsed.header,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
          totalDurationMs: Number.isFinite(start) && Number.isFinite(finish) ? finish - start : parsed.header.totalDurationMs,
        },
        stats: {
          ...parsed.stats,
          usage,
          totalTokens: usage ? usage.inputTokens + usage.outputTokens : 0,
        },
        items: parsed.items,
      };
    } catch {
      return { attempt, header: null, stats: emptyStats(attempt), items: [], rolloutAvailable: false };
    }
  }

  async detail(
    flowId: string,
    step: string,
    runId: string,
    itemId: string,
    workspaceName?: string | null,
  ): Promise<SessionItemDetail | null> {
    const attempt = this.getAttempt(flowId, step, runId, workspaceName);
    if (!attempt) return null;
    const rollout = this.resolve(attempt);
    if (!rollout) return null;
    const parsed = await this.parsed(rollout);
    return parsed.items.some((item) => item.id === itemId) ? parsed.details.get(itemId) || null : null;
  }
}

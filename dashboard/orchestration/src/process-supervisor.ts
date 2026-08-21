import type { ChildProcess } from 'node:child_process';
import type { OrchestrationService } from './service.js';
import type { AppServerClient } from './appserver-client.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ProcessSupervisor {
  private _appServerClient: AppServerClient | null = null;
  private activeThreads = new Map<string, { attemptId: string; threadId: string; turnId: string }>();
  private terminations = new Map<string, Promise<void>>();

  constructor(private readonly service: OrchestrationService) {}

  setAppServerClient(client: AppServerClient | null): void {
    this._appServerClient = client;
  }

  registerActiveThread(flowId: string, step: string, attemptId: string, threadId: string, turnId: string): void {
    this.activeThreads.set(`${flowId}:${step}`, { attemptId, threadId, turnId });
  }

  unregisterActiveThread(flowId: string, step: string): void {
    this.activeThreads.delete(`${flowId}:${step}`);
  }

  isAlive(pid: number | null): boolean {
    if (!pid || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async waitForPid(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.isAlive(pid) && Date.now() < deadline) await delay(500);
    return !this.isAlive(pid);
  }

  isGroupAlive(processGroupId: number | null): boolean {
    if (!processGroupId || processGroupId <= 1 || processGroupId === process.pid) return false;
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch {
      return false;
    }
  }

  async waitForGroup(processGroupId: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.isGroupAlive(processGroupId) && Date.now() < deadline) await delay(100);
    return !this.isGroupAlive(processGroupId);
  }

  async terminateGroup(processGroupId: number | null, graceMs = 10_000): Promise<void> {
    if (!processGroupId || processGroupId <= 1 || processGroupId === process.pid) return;
    try { process.kill(-processGroupId, 'SIGTERM'); } catch { return; }
    const exited = await this.waitForGroup(processGroupId, graceMs);
    if (!exited) {
      try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* already gone */ }
      await this.waitForGroup(processGroupId, 2_000);
    }
  }

  terminateFlow(flowId: string): Promise<void> {
    const existing = this.terminations.get(flowId);
    if (existing) return existing;
    const termination = this.performTerminateFlow(flowId).finally(() => {
      if (this.terminations.get(flowId) === termination) this.terminations.delete(flowId);
    });
    this.terminations.set(flowId, termination);
    return termination;
  }

  private async performTerminateFlow(flowId: string): Promise<void> {
    const attempts = this.service.runningAttempts(flowId);
    const turns = new Map<string, { attemptId: string; threadId: string; turnId: string }>();
    for (const [key, turn] of this.activeThreads) {
      if (key.startsWith(`${flowId}:`)) turns.set(`${turn.threadId}:${turn.turnId}`, turn);
    }

    const unresolvedAttempts: string[] = [];
    for (const attempt of attempts.filter((candidate) => !candidate.processGroupId && !candidate.pid)) {
      if ([...turns.values()].some((turn) => turn.attemptId === attempt.id)) continue;
      const durableTurn = this.service.attemptTurn(attempt.id);
      if (durableTurn) {
        turns.set(`${durableTurn.threadId}:${durableTurn.turnId}`, { attemptId: attempt.id, ...durableTurn });
      } else {
        unresolvedAttempts.push(attempt.id);
      }
    }

    const errors: Error[] = [];
    if (turns.size && !this._appServerClient?.connected) {
      errors.push(new Error('Codex app-server is not connected'));
    } else if (this._appServerClient) {
      const results = await Promise.allSettled([...turns.values()].map(async (turn) => {
        await this._appServerClient!.interruptTurn(turn.threadId, turn.turnId);
        for (const [key, active] of this.activeThreads) {
          if (active.attemptId === turn.attemptId) this.activeThreads.delete(key);
        }
      }));
      for (const result of results) {
        if (result.status === 'rejected') {
          errors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
        }
      }
    }

    await Promise.all(attempts
      .filter((a) => a.processGroupId || a.pid)
      .map((attempt) => this.terminateGroup(attempt.processGroupId || attempt.pid)));

    if (unresolvedAttempts.length) {
      errors.push(new Error(`Running attempts have no termination handle: ${unresolvedAttempts.join(', ')}`));
    }
    if (errors.length) throw new AggregateError(errors, `Failed to stop flow ${flowId}`);
  }

  async waitForChild(child: ChildProcess, timeoutMs: number): Promise<{ exitCode: number | null; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutRequested = false;
      let timer: NodeJS.Timeout;
      const finish = (exitCode: number | null, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, timedOut });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', fail);
      child.once('close', (code) => finish(code, timeoutRequested));
      timer = setTimeout(() => {
        timeoutRequested = true;
        void this.terminateGroup(child.pid || null).then(() => finish(child.exitCode, true), fail);
      }, timeoutMs);
      timer.unref();
    });
  }
}

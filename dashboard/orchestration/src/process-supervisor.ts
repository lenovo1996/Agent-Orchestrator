import type { ChildProcess } from 'node:child_process';
import type { OrchestrationService } from './service.js';
import type { AppServerClient } from './appserver-client.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ProcessSupervisor {
  private _appServerClient: AppServerClient | null = null;
  private activeThreads = new Map<string, { threadId: string; turnId: string }>();

  constructor(private readonly service: OrchestrationService) {}

  setAppServerClient(client: AppServerClient | null): void {
    this._appServerClient = client;
  }

  registerActiveThread(flowId: string, step: string, threadId: string, turnId: string): void {
    this.activeThreads.set(`${flowId}:${step}`, { threadId, turnId });
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

  async terminateFlow(flowId: string): Promise<void> {
    // Interrupt app-server threads first
    if (this._appServerClient?.connected) {
      const interruptPromises: Promise<void>[] = [];
      for (const [key, { threadId, turnId }] of this.activeThreads) {
        if (key.startsWith(`${flowId}:`)) {
          interruptPromises.push(
            this._appServerClient.interruptTurn(threadId, turnId).catch(() => { /* ignore */ }),
          );
          this.activeThreads.delete(key);
        }
      }
      await Promise.all(interruptPromises);
    }

    // Also terminate process-based attempts
    const attempts = this.service.runningAttempts(flowId);
    await Promise.all(attempts
      .filter((a) => a.processGroupId || a.pid)
      .map((attempt) => this.terminateGroup(attempt.processGroupId || attempt.pid)));
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

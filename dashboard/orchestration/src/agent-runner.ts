import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentStepResult, StepAttemptRecord } from './types.js';
import { PermanentAgentError, RetriableAgentError } from './errors.js';
import { parseOutputStatus } from './output-parser.js';
import { ProcessSupervisor } from './process-supervisor.js';
import type { OrchestrationService } from './service.js';

function deterministicUuid(value: string): string {
  const hash = crypto.createHash('sha256').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function isPermanentCliError(text: string): boolean {
  return [
    /authentication\s+(?:failed|required)/i,
    /invalid\s+(?:api[_ -]?key|model|configuration)/i,
    /unauthorized|forbidden/i,
    /model\s+.+\s+(?:not found|does not exist)/i,
    /unknown\s+runtime/i,
    /AGENT_COMMAND.+(?:not set|required)/i,
  ].some((pattern) => pattern.test(text));
}

function tail(value: string, max = 20_000): string {
  return value.length <= max ? value : value.slice(-max);
}

export class AgentRunner {
  readonly supervisor: ProcessSupervisor;

  constructor(private readonly service: OrchestrationService) {
    this.supervisor = new ProcessSupervisor(service);
  }

  private runMemory(command: 'init' | 'update' | 'generate', flowId: string, step?: string): void {
    const script = path.join(this.service.config.repoRoot, 'scripts', 'utils', 'memory-tree.js');
    if (!fs.existsSync(script)) return;
    const args = [script, command, flowId, ...(step ? [step] : [])];
    spawnSync(process.execPath, args, {
      cwd: this.service.config.repoRoot,
      env: {
        ...process.env,
        DEVTEAM_DB_PATH: this.service.config.dbPath,
        DEVTEAM_TASK_FLOWS_DIR: this.service.config.taskFlowsDir,
      },
      stdio: 'ignore',
      timeout: 10_000,
    });
  }

  private prepareMemory(flowId: string, step: string): void {
    const flow = this.service.getFlow(flowId);
    const taskId = flow.jiraKey && /^[A-Za-z0-9._-]+$/.test(flow.jiraKey) ? flow.jiraKey : flow.flowId;
    const tree = path.join(this.service.config.repoRoot, '.tasks', taskId, 'flows', flow.flowId, 'tree.json');
    if (!fs.existsSync(tree)) this.runMemory('init', flowId);
    this.runMemory('generate', flowId, step);
  }

  private updateMemory(flowId: string, step: string): void {
    this.runMemory('update', flowId, step);
  }

  private buildPrompt(flowId: string, step: string): string {
    const flow = this.service.getFlow(flowId);
    const agent = this.service.getAgent(step);
    const workDirectory = this.service.artifactDirectory(flow);
    const effectiveWorkspace = flow.worktreePath || flow.workspacePath;
    const currentIndex = flow.stepOrder.indexOf(step);
    const previousOutputs = flow.stepDetails
      .filter((candidate) => candidate.position < currentIndex && candidate.outputPath)
      .map((candidate) => path.join(workDirectory, candidate.outputPath as string))
      .filter((file) => fs.existsSync(file));
    const parts = [
      `You are the **${agent.role}** on a dev team.`,
      '',
      '## Instructions',
      '',
      agent.instructions,
      '',
      '## Context',
      '',
      `- Flow ID: ${flow.flowId}`,
      `- Jira ticket: ${flow.jiraKey || '(custom task)'}`,
      `- Workspace dir: ${effectiveWorkspace}`,
      `- Work dir: ${workDirectory}`,
    ];
    if (flow.worktreePath) parts.push(`- Main workspace: ${flow.workspacePath} (do not modify directly)`);
    if (flow.customPrompt) parts.push('', '## Custom Requirement', '', flow.customPrompt);
    const taskId = flow.jiraKey && /^[A-Za-z0-9._-]+$/.test(flow.jiraKey) ? flow.jiraKey : flow.flowId;
    const memoryContext = path.join(
      this.service.config.repoRoot,
      '.tasks',
      taskId,
      'active-context.md',
    );
    if (fs.existsSync(memoryContext)) {
      parts.push('', '## Memory Context', '', `Read the active memory context at: ${memoryContext}`);
    }
    if (previousOutputs.length) {
      parts.push('', '## Previous Outputs', '', ...previousOutputs.map((file) => `- ${file}`));
    }
    const output = this.service.outputFile(flowId, step);
    parts.push('', '## Your Output', '', `Write your output to: ${output}`, '', 'Follow the instructions exactly.');
    return parts.join('\n').replaceAll('{{REPO_ROOT}}', effectiveWorkspace)
      .replaceAll('{{TASK_ID}}', flow.jiraKey || flow.flowId)
      .replaceAll('{{TASK_NAME}}', flow.jiraKey || flow.flowId);
  }

  private readResult(flowId: string, step: string, attempt: StepAttemptRecord, previousMtime = 0): AgentStepResult {
    const outputFile = this.service.outputFile(flowId, step);
    let stat: fs.Stats;
    let content: string;
    try {
      stat = fs.statSync(outputFile);
      content = fs.readFileSync(outputFile, 'utf8');
    } catch {
      throw new RetriableAgentError(`Agent produced no output for ${step}`, 'missing_output');
    }
    if (previousMtime && stat.mtimeMs <= previousMtime) {
      throw new RetriableAgentError(`Agent did not refresh output for ${step}`, 'stale_output');
    }
    const status = parseOutputStatus(content, outputFile);
    if (status === 'UNKNOWN') {
      throw new RetriableAgentError(`Output for ${step} has no parseable status`, 'parse_output');
    }
    return { status, attemptId: attempt.id };
  }

  private recoveredExitCode(attempt: StepAttemptRecord): number | null {
    const agent = this.service.getAgent(attempt.step);
    if ((agent.runtime || 'codex') !== 'codex') return attempt.exitCode;

    const flow = this.service.getFlow(attempt.flowId);
    const metadataFile = path.join(
      this.service.artifactDirectory(flow),
      'sessions',
      attempt.step,
      `${attempt.sessionRunId}.json`,
    );
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')) as {
        schemaVersion?: number;
        attemptId?: string;
        inngestRunId?: string;
        inngestAttempt?: number;
        status?: string;
        finishedAt?: string | null;
        exitCode?: number | null;
      };
      const finalized = metadata.schemaVersion === 2
        && metadata.attemptId === attempt.id
        && metadata.inngestRunId === attempt.inngestRunId
        && metadata.inngestAttempt === attempt.inngestAttempt
        && (metadata.status === 'completed' || metadata.status === 'failed')
        && Boolean(metadata.finishedAt);
      if (!finalized) throw new Error('metadata is incomplete or belongs to another attempt');
      return typeof metadata.exitCode === 'number' ? metadata.exitCode : attempt.exitCode;
    } catch (error) {
      throw new RetriableAgentError(
        `Codex session metadata was not finalized: ${error instanceof Error ? error.message : String(error)}`,
        'session_metadata',
      );
    }
  }

  private async projectExisting(attempt: StepAttemptRecord): Promise<AgentStepResult> {
    if (attempt.status === 'running' && (attempt.processGroupId || attempt.pid)) {
      const exited = attempt.processGroupId
        ? await this.supervisor.waitForGroup(attempt.processGroupId, this.service.config.agentTimeoutMs)
        : await this.supervisor.waitForPid(attempt.pid as number, this.service.config.agentTimeoutMs);
      if (!exited) {
        await this.supervisor.terminateGroup(attempt.processGroupId || attempt.pid);
        this.service.finishAttempt(attempt.id, 'failed', attempt.exitCode, {
          stage: 'timeout',
          message: 'Recovered agent process exceeded local timeout',
          retriable: true,
        });
        throw new RetriableAgentError('Recovered agent process exceeded local timeout', 'timeout');
      }
    }
    const refreshed = this.service.attempt(attempt.id);
    try {
      const exitCode = this.recoveredExitCode(refreshed);
      const startedAt = Date.parse(refreshed.startedAt || refreshed.createdAt);
      const result = this.readResult(refreshed.flowId, refreshed.step, refreshed, startedAt);
      this.updateMemory(refreshed.flowId, refreshed.step);
      if (refreshed.status === 'running') this.service.finishAttempt(refreshed.id, 'completed', exitCode);
      return result;
    } catch (error) {
      if (refreshed.status === 'running') {
        this.service.finishAttempt(refreshed.id, 'failed', refreshed.exitCode, {
          stage: error instanceof RetriableAgentError ? error.stage : 'reconcile',
          message: error instanceof Error ? error.message : String(error),
          retriable: true,
        });
      }
      throw error;
    }
  }

  async execute(input: {
    flowId: string;
    step: string;
    cycle: number;
    inngestRunId: string;
    inngestAttempt: number;
    runnerId: string;
  }): Promise<AgentStepResult> {
    const checkpoint = this.service.getFlow(input.flowId);
    if (checkpoint.status !== 'running') {
      throw new PermanentAgentError(`Flow is no longer runnable: ${checkpoint.status}`, 'cancelled');
    }
    const otherRunning = this.service.runningAttemptForCycle(input.flowId, input.step, input.cycle);
    if (otherRunning) return this.projectExisting(otherRunning);
    const recovered = this.service.completedAttemptForCycle(input.flowId, input.step, input.cycle);
    if (recovered) {
      try {
        return this.readResult(input.flowId, input.step, recovered);
      } catch {
        // A finalized attempt without a valid output must be retried technically.
      }
    }

    const attemptId = deterministicUuid(`${input.inngestRunId}:${input.inngestAttempt}`);
    const attempt = this.service.createAttempt({
      id: attemptId,
      flowId: input.flowId,
      step: input.step,
      cycle: input.cycle,
      technicalAttempt: input.inngestAttempt,
      inngestRunId: input.inngestRunId,
      inngestAttempt: input.inngestAttempt,
      sessionRunId: crypto.randomUUID(),
      runnerId: input.runnerId,
    });
    if (attempt.status === 'completed') return this.readResult(input.flowId, input.step, attempt);
    if (attempt.status === 'running') return this.projectExisting(attempt);

    const flow = this.service.getFlow(input.flowId);
    const agent = this.service.getAgent(input.step);
    const runtimeName = agent.runtime || 'codex';
    const runtimeScript = path.join(this.service.config.repoRoot, 'scripts', 'runtimes', `${runtimeName}.sh`);
    if (!/^[A-Za-z0-9._-]+$/.test(runtimeName) || !fs.existsSync(runtimeScript)
      || (runtimeName === 'generic' && !agent.runtimeCommand)) {
      const message = `Invalid runtime configuration for ${input.step}: ${runtimeName}`;
      this.service.finishAttempt(attempt.id, 'failed', null, { stage: 'configuration', message, retriable: false });
      throw new PermanentAgentError(message, 'configuration');
    }
    const workDirectory = this.service.artifactDirectory(flow);
    const promptDirectory = path.join(workDirectory, 'prompts');
    fs.mkdirSync(promptDirectory, { recursive: true });
    fs.mkdirSync(path.join(workDirectory, 'output'), { recursive: true });
    fs.mkdirSync(path.join(workDirectory, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(workDirectory, 'sessions', input.step), { recursive: true });
    const promptFile = path.join(promptDirectory, `${input.step}-cycle-${input.cycle}-attempt-${input.inngestAttempt}.txt`);
    this.prepareMemory(input.flowId, input.step);
    fs.writeFileSync(promptFile, `${this.buildPrompt(input.flowId, input.step)}\n`, { mode: 0o600 });
    const outputFile = this.service.outputFile(input.flowId, input.step);
    let previousMtime = 0;
    try { previousMtime = fs.statSync(outputFile).mtimeMs; } catch { /* first attempt */ }

    const wrapper = path.join(this.service.config.repoRoot, 'scripts', 'agent', 'wrapper.sh');
    const effectiveWorkspace = flow.worktreePath || flow.workspacePath;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENT_RUNTIME: runtimeName,
      DEVTEAM_ATTEMPT_ID: attempt.id,
      DEVTEAM_INNGEST_RUN_ID: input.inngestRunId,
      DEVTEAM_INNGEST_ATTEMPT: String(input.inngestAttempt),
      DEVTEAM_SESSION_RUN_ID: attempt.sessionRunId,
      DEVTEAM_OUTPUT_FILE: outputFile,
    };
    if (agent.model) env.AGENT_MODEL = agent.model;
    if (agent.thinking) env.AGENT_REASONING = agent.thinking;
    if (agent.runtimeCommand) env.AGENT_COMMAND = agent.runtimeCommand;

    let combinedOutput = '';
    let child;
    try {
      child = spawn('/usr/bin/bash', [
        wrapper, input.flowId, input.step, workDirectory, promptFile, effectiveWorkspace,
      ], {
        cwd: effectiveWorkspace,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.service.finishAttempt(attempt.id, 'failed', null, { stage: 'spawn', message, retriable: true });
      throw new RetriableAgentError(message, 'spawn');
    }
    if (!child.pid) {
      this.service.finishAttempt(attempt.id, 'failed', null, {
        stage: 'spawn', message: 'Spawn returned no PID', retriable: true,
      });
      throw new RetriableAgentError('Spawn returned no PID', 'spawn');
    }
    child.stdout?.on('data', (chunk) => { combinedOutput = tail(combinedOutput + String(chunk)); });
    child.stderr?.on('data', (chunk) => { combinedOutput = tail(combinedOutput + String(chunk)); });
    try {
      this.service.markAttemptRunning(attempt.id, child.pid, child.pid);
    } catch (error) {
      await this.supervisor.terminateGroup(child.pid);
      throw new PermanentAgentError(
        error instanceof Error ? error.message : String(error),
        'cancelled',
      );
    }

    let exitCode: number | null = null;
    try {
      const result = await this.supervisor.waitForChild(child, this.service.config.agentTimeoutMs);
      exitCode = result.exitCode;
      if (result.timedOut) throw new RetriableAgentError('Agent process exceeded local timeout', 'timeout');
      const domainResult = this.readResult(input.flowId, input.step, attempt, previousMtime);
      if (exitCode !== 0 && domainResult.status !== 'BLOCKED') {
        throw new RetriableAgentError(`Agent exited with code ${exitCode}`, 'process');
      }
      this.updateMemory(input.flowId, input.step);
      this.service.finishAttempt(attempt.id, 'completed', exitCode);
      return domainResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = isPermanentCliError(`${combinedOutput}\n${message}`);
      const stage = error instanceof RetriableAgentError ? error.stage : 'process';
      this.service.finishAttempt(attempt.id, 'failed', exitCode, { stage, message: message.slice(0, 500), retriable: !permanent });
      if (permanent) throw new PermanentAgentError(message, stage);
      if (error instanceof RetriableAgentError) throw error;
      throw new RetriableAgentError(message, stage);
    }
  }

  async reconcileRunningAttempts(): Promise<void> {
    for (const attempt of this.service.runningAttempts()) {
      if (this.supervisor.isGroupAlive(attempt.processGroupId) || this.supervisor.isAlive(attempt.pid)) {
        void this.projectExisting(attempt).catch(() => {
          // Inngest owns the technical retry; startup reconciliation only
          // follows the surviving process and projects its durable result.
        });
        continue;
      }
      try {
        const exitCode = this.recoveredExitCode(attempt);
        const startedAt = Date.parse(attempt.startedAt || attempt.createdAt);
        this.readResult(attempt.flowId, attempt.step, attempt, startedAt);
        this.updateMemory(attempt.flowId, attempt.step);
        this.service.finishAttempt(attempt.id, 'completed', exitCode);
      } catch (error) {
        this.service.finishAttempt(attempt.id, 'failed', attempt.exitCode, {
          stage: 'worker_crash',
          message: error instanceof Error ? error.message : String(error),
          retriable: true,
        });
      }
    }
  }
}

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentStepResult, StepAttemptRecord } from './types.js';
import { PermanentAgentError, RetriableAgentError } from './errors.js';
import { parseOutputStatus } from './output-parser.js';
import { ProcessSupervisor } from './process-supervisor.js';
import type { OrchestrationService } from './service.js';
import { AppServerClient, type AppServerConfig } from './appserver-client.js';
import { AppServerSessionBridge } from './appserver-session-bridge.js';

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
  private _appServerClient: AppServerClient | null = null;

  constructor(private readonly service: OrchestrationService) {
    this.supervisor = new ProcessSupervisor(service);
  }

  get appServerClient(): AppServerClient | null {
    return this._appServerClient;
  }

  initAppServerClient(config: AppServerConfig): AppServerClient {
    if (!this._appServerClient) {
      this._appServerClient = new AppServerClient(config);
    }
    return this._appServerClient;
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

  private ensureWorkspaceTrusted(workspacePath: string): void {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const configPath = path.join(codexHome, 'config.toml');
    if (!fs.existsSync(configPath)) return;

    const config = fs.readFileSync(configPath, 'utf8');
    const escapedPath = workspacePath.replace(/"/g, '\\"');
    const projectKey = `["${escapedPath}"]`;

    if (!config.includes(projectKey)) {
      const addition = `\n${projectKey}\ntrust_level = "trusted"\n`;
      fs.appendFileSync(configPath, addition);
    }
  }

  private mergeMcpJsonToWorkspaceConfig(workspacePath: string): void {
    const mcpJsonPath = path.join(workspacePath, '.mcp.json');
    if (!fs.existsSync(mcpJsonPath)) return;

    try {
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as {
        mcpServers?: Record<string, {
          type?: string;
          command?: string;
          args?: string[];
          url?: string;
          env?: Record<string, string>;
          bearer_token_env_var?: string;
        }>;
      };

      if (!mcpJson.mcpServers || Object.keys(mcpJson.mcpServers).length === 0) return;

      const codexDir = path.join(workspacePath, '.codex');
      const configPath = path.join(codexDir, 'config.toml');

      let existingConfig = '';
      if (fs.existsSync(configPath)) {
        existingConfig = fs.readFileSync(configPath, 'utf8');
      }

      const newServers: string[] = [];
      for (const [name, server] of Object.entries(mcpJson.mcpServers)) {
        if (existingConfig.includes(`[mcp_servers.${name}]`)) continue;

        if (server.type === 'http' && server.url) {
          let block = `[mcp_servers.${name}]\nurl = "${server.url}"\n`;
          if (server.bearer_token_env_var) {
            block += `bearer_token_env_var = "${server.bearer_token_env_var}"\n`;
          }
          if (server.env) {
            block += `[mcp_servers.${name}.env]\n`;
            for (const [key, value] of Object.entries(server.env)) {
              block += `${key} = "${value}"\n`;
            }
          }
          newServers.push(block);
        } else if (server.command) {
          let block = `[mcp_servers.${name}]\ncommand = "${server.command}"\n`;
          if (server.args && server.args.length > 0) {
            block += `args = [${server.args.map((a) => `"${a}"`).join(', ')}]\n`;
          }
          if (server.env) {
            block += `[mcp_servers.${name}.env]\n`;
            for (const [key, value] of Object.entries(server.env)) {
              block += `${key} = "${value}"\n`;
            }
          }
          newServers.push(block);
        }
      }

      if (newServers.length > 0) {
        fs.mkdirSync(codexDir, { recursive: true });
        const addition = `\n${newServers.join('\n')}`;
        fs.appendFileSync(configPath, addition);
      }
    } catch {
      // Ignore parse errors
    }
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
    if ((agent.runtime || 'appserver') !== 'codex') return attempt.exitCode;

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
    
    // Try to recover existing attempt, but don't fail if output doesn't exist
    const otherRunning = this.service.runningAttemptForCycle(input.flowId, input.step, input.cycle);
    if (otherRunning) {
      try {
        return await this.projectExisting(otherRunning);
      } catch (error) {
        // If recovery fails (e.g., no output file), mark as failed and continue to create new attempt
        if (error instanceof RetriableAgentError && error.stage === 'missing_output') {
          this.service.finishAttempt(otherRunning.id, 'failed', null, {
            stage: 'missing_output', message: 'Previous attempt produced no output', retriable: true,
          });
        } else {
          throw error;
        }
      }
    }
    
    const recovered = this.service.completedAttemptForCycle(input.flowId, input.step, input.cycle);
    if (recovered) {
      try {
        return this.readResult(input.flowId, input.step, recovered);
      } catch {
        // A finalized attempt without a valid output must be retried technically.
      }
    }

    // Check if we should resume an existing thread (retry with session)
    const retryCommand = this.service.latestRetryCommand(input.flowId);
    const shouldResume = retryCommand?.resumeThread === true && retryCommand?.step === input.step;

    let attempt: StepAttemptRecord;
    let isResumed = false;
    if (shouldResume) {
      const resumed = this.service.resumeAttempt(
        input.flowId, input.step, input.cycle,
        input.inngestRunId, input.inngestAttempt, input.runnerId,
      );
      if (resumed) {
        attempt = resumed;
        isResumed = true;
      } else {
        // No attempt with thread found, create new
        const attemptId = deterministicUuid(`${input.inngestRunId}:${input.inngestAttempt}`);
        attempt = this.service.createAttempt({
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
      }
    } else {
      const attemptId = deterministicUuid(`${input.inngestRunId}:${input.inngestAttempt}`);
      attempt = this.service.createAttempt({
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
    }
    if (!isResumed && attempt.status === 'completed') return this.readResult(input.flowId, input.step, attempt);
    if (!isResumed && attempt.status === 'running') return this.projectExisting(attempt);

    const flow = this.service.getFlow(input.flowId);
    const agent = this.service.getAgent(input.step);
    const runtimeName = agent.runtime || 'appserver';

    // App-server runtime uses WebSocket instead of CLI process
    if (runtimeName === 'appserver') {
      return this.executeViaAppServer(input, attempt);
    }

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
    this.ensureWorkspaceTrusted(effectiveWorkspace);
    this.mergeMcpJsonToWorkspaceConfig(effectiveWorkspace);
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

  /**
   * Execute an agent step via the app-server daemon WebSocket API.
   * Instead of spawning a CLI process, we connect to the daemon, create a
   * thread, send the prompt as a turn, and wait for completion.
   */
  private async executeViaAppServer(
    input: { flowId: string; step: string; cycle: number; inngestRunId: string; inngestAttempt: number; runnerId: string },
    attempt: StepAttemptRecord,
  ): Promise<AgentStepResult> {
    const flow = this.service.getFlow(input.flowId);
    const agent = this.service.getAgent(input.step);
    const effectiveWorkspace = flow.worktreePath || flow.workspacePath;
    this.ensureWorkspaceTrusted(effectiveWorkspace);
    this.mergeMcpJsonToWorkspaceConfig(effectiveWorkspace);
    const workDirectory = this.service.artifactDirectory(flow);
    const outputFile = this.service.outputFile(input.flowId, input.step);
    let previousMtime = 0;
    try { previousMtime = fs.statSync(outputFile).mtimeMs; } catch { /* first attempt */ }

    // Ensure app-server client is initialized
    const client = this._appServerClient;
    if (!client) {
      const message = 'AppServerClient not initialized. Call initAppServerClient() first.';
      this.service.finishAttempt(attempt.id, 'failed', null, { stage: 'configuration', message, retriable: false });
      throw new PermanentAgentError(message, 'configuration');
    }

    // Wait for connection if not connected yet
    if (!client.connected) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new RetriableAgentError('AppServer connection timeout', 'process')), 30_000);
        client.once('connected', () => { clearTimeout(timeout); resolve(); });
      });
    }

    // Create session bridge for metadata + log files
    const logFile = path.join(workDirectory, 'logs', `${input.step}.log`);
    const bridge = new AppServerSessionBridge(client, {
      workDir: workDirectory,
      flowId: input.flowId,
      step: input.step,
      attemptId: attempt.id,
      inngestRunId: input.inngestRunId,
      inngestAttempt: input.inngestAttempt,
      sessionRunId: attempt.sessionRunId,
      logFile,
    });

    // Check if we should resume an existing thread (retry with session)
    const retryCommand = this.service.latestRetryCommand(input.flowId);
    const shouldResume = retryCommand?.resumeThread === true && retryCommand?.step === input.step;

    bridge.start(!shouldResume);

    // Mark attempt as running (no PID for daemon mode, use 0)
    try {
      this.service.markAttemptRunning(attempt.id, 0, 0);
    } catch (error) {
      bridge.fail(error instanceof Error ? error.message : String(error));
      throw new PermanentAgentError(
        error instanceof Error ? error.message : String(error),
        'cancelled',
      );
    }

    try {
      let threadInfo: { threadId: string; sessionId: string; model: string; cwd: string };

      if (shouldResume) {
        const existing = this.service.latestAttemptWithThread(input.flowId, input.step);
        if (existing) {
          try {
            threadInfo = await client.resumeThread(existing.threadId, { cwd: effectiveWorkspace, model: agent.model || undefined });
            bridge.appendLog(`[resume] Resumed thread ${existing.threadId}\n`);
          } catch (err) {
            // Resume failed, fall back to creating a new thread
            bridge.appendLog(`[resume] Failed to resume thread: ${(err as Error).message}. Creating new thread.\n`);
            threadInfo = await client.createThread({
              cwd: effectiveWorkspace,
              model: agent.model || undefined,
            });
          }
        } else {
          threadInfo = await client.createThread({
            cwd: effectiveWorkspace,
            model: agent.model || undefined,
          });
        }
      } else {
        // Create new thread
        threadInfo = await client.createThread({
          cwd: effectiveWorkspace,
          model: agent.model || undefined,
        });
      }

      // Send the prompt as a turn
      // When resuming, use a simple prompt (just the custom prompt or a continue message)
      // instead of rebuilding the full prompt with all context
      let prompt: string;
      if (shouldResume && retryCommand) {
        const flow = this.service.getFlow(input.flowId);
        prompt = flow.customPrompt || 'Please continue from where you left off. Review your previous work and output file, then continue the task.';
      } else {
        prompt = this.buildPrompt(input.flowId, input.step);
      }
      const turnInfo = await client.startTurn(threadInfo.threadId, prompt, {
        model: agent.model || undefined,
      });

      // Wait for turn completion — only for the specific turn we started
      const exitCode = await new Promise<number>((resolve) => {
        const onCompleted = (tid: string, completedTurnId: string) => {
          if (tid === threadInfo.threadId && completedTurnId === turnInfo.turnId) {
            client.removeListener('turn:completed', onCompleted);
            client.removeListener('error', onError);
            resolve(0);
          }
        };
        const onError = (tid: string | null, message: string) => {
          if (tid === threadInfo.threadId || tid === null) {
            client.removeListener('turn:completed', onCompleted);
            client.removeListener('error', onError);
            bridge.fail(message);
            resolve(1);
          }
        };
        client.on('turn:completed', onCompleted);
        client.on('error', onError);

        // Timeout
        setTimeout(() => {
          client.removeListener('turn:completed', onCompleted);
          client.removeListener('error', onError);
          bridge.fail('Agent turn exceeded local timeout');
          resolve(1);
        }, this.service.config.agentTimeoutMs);
      });

      bridge.complete(exitCode);

      // If agent didn't write the output file directly (common with app-server),
      // write the captured agent message as the output.
      if (!fs.existsSync(outputFile) || fs.statSync(outputFile).mtimeMs <= previousMtime) {
        const agentOutput = bridge.finalAgentMessage;
        if (agentOutput) {
          fs.mkdirSync(path.dirname(outputFile), { recursive: true });
          fs.writeFileSync(outputFile, agentOutput + '\n', { mode: 0o600 });
        }
      }

      const domainResult = this.readResult(input.flowId, input.step, attempt, previousMtime);
      if (exitCode !== 0 && domainResult.status !== 'BLOCKED') {
        throw new RetriableAgentError(`Agent turn failed with exit code ${exitCode}`, 'process');
      }
      this.updateMemory(input.flowId, input.step);
      this.service.finishAttempt(attempt.id, 'completed', exitCode);
      return domainResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stage = error instanceof RetriableAgentError ? error.stage : 'process';
      this.service.finishAttempt(attempt.id, 'failed', 1, { stage, message: message.slice(0, 500), retriable: true });
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

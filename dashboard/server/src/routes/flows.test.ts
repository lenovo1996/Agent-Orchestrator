import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import express from 'express';
import type { DashboardConfig } from '../config.js';
import type { WorkflowState } from '@devteam-dashboard/shared';
import { flowsRouter } from './flows.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flows-test-'));
}

function createMockConfig(taskFlowsDir: string): DashboardConfig {
  return {
    port: 3001,
    host: '127.0.0.1',
    corsOrigin: '*',
    taskFlowsDir,
    scriptDir: path.join(taskFlowsDir, '..', 'scripts'),
    clientDistPath: '/tmp/client-dist',
    isProduction: false,
  };
}

function createMockWorkflow(flowId: string, overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    flowId,
    jiraKey: 'JH-001',
    status: 'running',
    currentStep: 'architect',
    startedAt: '2025-01-01T00:00:00Z',
    steps: {
      clarifier: 'done',
      architect: 'running',
      planner: 'waiting',
      implementer: 'waiting',
      verifier: 'waiting',
    },
    ...overrides,
  };
}

function writeWorkflow(taskFlowsDir: string, flowId: string, workflow: WorkflowState): void {
  const flowDir = path.join(taskFlowsDir, flowId);
  fs.mkdirSync(flowDir, { recursive: true });
  fs.writeFileSync(path.join(flowDir, 'workflow.json'), JSON.stringify(workflow));
}

function makeApp(config: DashboardConfig): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', flowsRouter(config));
  return app;
}

// Simple supertest-like helper using node fetch
async function request(app: express.Express, method: string, url: string, requestBody?: unknown) {
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: requestBody ? { 'Content-Type': 'application/json' } : undefined,
      body: requestBody ? JSON.stringify(requestBody) : undefined,
    });
    const responseBody = await res.json();
    return { status: res.status, body: responseBody };
  } finally {
    server.close();
  }
}

function createMockDashboardRoot(): { rootDir: string; taskFlowsDir: string } {
  const rootDir = createTempDir();
  const taskFlowsDir = path.join(rootDir, '.dev-team', 'task-flows');
  const scriptsDir = path.join(rootDir, '.dev-team', 'scripts');
  const libDir = path.join(scriptsDir, 'lib');
  fs.mkdirSync(taskFlowsDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true }); fs.mkdirSync(path.join(scriptsDir, 'orchestrator'), { recursive: true }); fs.mkdirSync(path.join(scriptsDir, 'api'), { recursive: true }); fs.mkdirSync(path.join(scriptsDir, 'watcher'), { recursive: true });

  fs.writeFileSync(
    path.join(scriptsDir, 'orchestrator/index.js'),
    `
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
const flowId = 'flow_test_shellless_start';
const argsPath = path.join(rootDir, 'orchestrator-args.json');
fs.writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)));

const flowDir = path.join(rootDir, '.dev-team', 'task-flows', flowId);
fs.mkdirSync(path.join(flowDir, 'logs'), { recursive: true });
fs.mkdirSync(path.join(flowDir, 'output'), { recursive: true });
console.log('Workflow started: ' + flowId);
`
  );

  fs.writeFileSync(
    path.join(scriptsDir, 'api/spawn.js'),
    `
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
fs.appendFileSync(path.join(rootDir, 'spawn-starts.log'), process.argv.slice(2).join(':') + '\\n');
`
  );

  fs.writeFileSync(
    path.join(scriptsDir, 'watcher/index.js'),
    `
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
const flowId = process.argv[2];
const mode = process.argv[3] || 'new';
fs.appendFileSync(path.join(rootDir, 'watcher-starts.log'), mode + ':' + flowId + ':' + process.pid + '\\n');
if (mode === 'existing') {
  setInterval(() => {}, 1000);
}
`
  );

  fs.writeFileSync(
    path.join(scriptsDir, 'orchestrator/retry-flow.js'),
    `
exports.prepareRetry = function prepareRetry(flowId, step) {
  const fs = require('node:fs');
  const path = require('node:path');
  const rootDir = path.resolve(__dirname, '../../..');
  fs.appendFileSync(path.join(rootDir, 'retry-calls.log'), flowId + ':' + step + '\\n');
  return { workDir: path.join(rootDir, '.dev-team', 'task-flows', flowId) };
};
`
  );

  return { rootDir, taskFlowsDir };
}

async function waitForFileContent(filePath: string, predicate: (content: string) => boolean): Promise<string> {
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (predicate(content)) {
        return content;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

describe('flowsRouter', () => {
  let tempDir: string;
  let config: DashboardConfig;

  beforeEach(() => {
    tempDir = createTempDir();
    config = createMockConfig(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('GET /api/flows', () => {
    it('returns empty list when no flows exist', async () => {
      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows');
      expect(status).toBe(200);
      expect(body.flows).toEqual([]);
    });

    it('returns FlowSummary list for valid flows', async () => {
      const workflow = createMockWorkflow('flow_001');
      writeWorkflow(tempDir, 'flow_001', workflow);

      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows');
      expect(status).toBe(200);
      expect(body.flows).toHaveLength(1);
      expect(body.flows[0]).toEqual({
        flowId: 'flow_001',
        jiraKey: 'JH-001',
        status: 'running',
        currentStep: 'architect',
        startedAt: '2025-01-01T00:00:00Z',
        completedSteps: 1,
        totalSteps: 5,
      });
    });

    it('calculates completedSteps correctly', async () => {
      const workflow = createMockWorkflow('flow_002', {
        steps: {
          clarifier: 'done',
          architect: 'done',
          planner: 'done',
          implementer: 'running',
          verifier: 'waiting',
        },
      });
      writeWorkflow(tempDir, 'flow_002', workflow);

      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows');
      expect(status).toBe(200);
      expect(body.flows[0].completedSteps).toBe(3);
    });
  });

  describe('GET /api/flows/:flowId', () => {
    it('returns 404 for non-existent flow', async () => {
      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows/nonexistent');
      expect(status).toBe(404);
      expect(body.error).toBe('Flow not found');
    });

    it('returns full WorkflowState', async () => {
      const workflow = createMockWorkflow('flow_003');
      writeWorkflow(tempDir, 'flow_003', workflow);

      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows/flow_003');
      expect(status).toBe(200);
      expect(body.workflow.flowId).toBe('flow_003');
      expect(body.workflow.status).toBe('running');
      expect(body.workflow.steps).toEqual(workflow.steps);
    });
  });

  describe('GET /api/flows/:flowId/logs/:step', () => {
    it('returns empty lines when log does not exist', async () => {
      writeWorkflow(tempDir, 'flow_004', createMockWorkflow('flow_004'));

      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows/flow_004/logs/clarifier');
      expect(status).toBe(200);
      expect(body.lines).toEqual([]);
    });

    it('returns log lines', async () => {
      writeWorkflow(tempDir, 'flow_005', createMockWorkflow('flow_005'));
      const logsDir = path.join(tempDir, 'flow_005', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, 'clarifier.log'), 'line1\nline2\nline3');

      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows/flow_005/logs/clarifier');
      expect(status).toBe(200);
      expect(body.lines).toEqual(['line1', 'line2', 'line3']);
    });

    it('returns only last 1000 lines for large logs', async () => {
      writeWorkflow(tempDir, 'flow_006', createMockWorkflow('flow_006'));
      const logsDir = path.join(tempDir, 'flow_006', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const lines = Array.from({ length: 1500 }, (_, i) => `line-${i}`);
      fs.writeFileSync(path.join(logsDir, 'architect.log'), lines.join('\n'));

      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows/flow_006/logs/architect');
      expect(status).toBe(200);
      expect(body.lines.length).toBeLessThanOrEqual(1000);
      // Should contain the last lines
      expect(body.lines[body.lines.length - 1]).toBe('line-1499');
    });
  });

  describe('GET /api/flows/:flowId/output/:step', () => {
    it('returns 400 for invalid step', async () => {
      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows/flow_007/output/invalid');
      expect(status).toBe(400);
      expect(body.error).toBe('Invalid step');
    });

    it('returns exists: false when output file does not exist', async () => {
      writeWorkflow(tempDir, 'flow_008', createMockWorkflow('flow_008'));

      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows/flow_008/output/clarifier');
      expect(status).toBe(200);
      expect(body.exists).toBe(false);
      expect(body.content).toBeNull();
    });

    it('returns markdown content and metadata', async () => {
      writeWorkflow(tempDir, 'flow_009', createMockWorkflow('flow_009'));
      const outputDir = path.join(tempDir, 'flow_009', 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'clarify.md'), '# Clarification\n\nSome content.');

      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', '/api/flows/flow_009/output/clarifier');
      expect(status).toBe(200);
      expect(body.exists).toBe(true);
      expect(body.content).toBe('# Clarification\n\nSome content.');
      expect(body.metadata).toHaveProperty('size');
      expect(body.metadata).toHaveProperty('lastModified');
      expect(body.metadata.size).toBeGreaterThan(0);
    });
  });

  describe('GET /api/flows/:flowId/tokens', () => {
    it('counts ANSI-colored Codex token entries across all step logs', async () => {
      const flowId = 'flow_tokens_ansi';
      writeWorkflow(tempDir, flowId, createMockWorkflow(flowId));
      const logsDir = path.join(tempDir, flowId, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, 'clarifier.log'), '\x1b[2mtokens used\x1b[0m\n384,024\n');
      fs.writeFileSync(
        path.join(logsDir, 'implementer.log'),
        '\x1b[2mtokens used\x1b[0m\n179,724\n...\n\x1b[2mtokens used\x1b[0m\n174,597\n'
      );

      const app = makeApp(config);
      const { status, body } = await request(app, 'GET', `/api/flows/${flowId}/tokens`);

      expect(status).toBe(200);
      expect(body.tokens.clarifier).toBe(384024);
      expect(body.tokens.implementer).toBe(354321);
      expect(body.total).toBe(738345);
    });
  });

  describe('POST /api/flows/start', () => {
    it('starts workflow without requiring node to be resolvable from PATH', async () => {
      const { rootDir, taskFlowsDir } = createMockDashboardRoot();
      const app = makeApp(createMockConfig(taskFlowsDir));
      const prompt = 'handle quotes " safely && do not run shell syntax';
      const originalPath = process.env.PATH;

      try {
        process.env.PATH = '';

        const { status, body } = await request(app, 'POST', '/api/flows/start', {
          customPrompt: prompt,
        });

        expect(status, JSON.stringify(body)).toBe(200);
        expect(body).toMatchObject({
          success: true,
          flowId: 'flow_test_shellless_start',
        });

        const args = JSON.parse(
          fs.readFileSync(path.join(rootDir, 'orchestrator-args.json'), 'utf8')
        );
        expect(args).toEqual(['start', '', prompt]);
      } finally {
        process.env.PATH = originalPath;
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe('POST /api/flows/:flowId/retry', () => {
    it('restarts watcher after retrying a step', async () => {
      const { rootDir, taskFlowsDir } = createMockDashboardRoot();
      const flowId = `flow_retry_${Date.now()}`;
      const workflow = createMockWorkflow(flowId, {
        currentStep: 'architect',
        steps: {
          clarifier: 'done',
          architect: 'failed',
          planner: 'waiting',
          implementer: 'waiting',
          verifier: 'waiting',
        },
      });
      writeWorkflow(taskFlowsDir, flowId, workflow);
      fs.mkdirSync(path.join(taskFlowsDir, flowId, 'logs'), { recursive: true });

      const app = makeApp(createMockConfig(taskFlowsDir));
      const watcherScript = path.join(rootDir, '.dev-team', 'scripts', 'watcher/index.js');
      const existingWatcher = spawn(process.execPath, [watcherScript, flowId, 'existing'], {
        stdio: 'ignore',
      });

      try {
        const watcherStartsPath = path.join(rootDir, 'watcher-starts.log');
        await waitForFileContent(watcherStartsPath, (content) => content.includes(`existing:${flowId}:`));

        const { status, body } = await request(app, 'POST', `/api/flows/${flowId}/retry`, {
          step: 'architect',
          clearOutput: true,
        });

        expect(status, JSON.stringify(body)).toBe(200);
        expect(body.watcher).toMatchObject({
          restarted: true,
        });
        expect(body.watcher.killed).toBeGreaterThanOrEqual(1);

        const watcherStarts = await waitForFileContent(
          watcherStartsPath,
          (content) => content.includes(`existing:${flowId}:`) && content.includes(`new:${flowId}:`)
        );
        expect(watcherStarts).toContain(`new:${flowId}:`);

        const retryCalls = fs.readFileSync(path.join(rootDir, 'retry-calls.log'), 'utf8');
        expect(retryCalls).toContain(`${flowId}:architect`);

        const spawnStarts = await waitForFileContent(
          path.join(rootDir, 'spawn-starts.log'),
          (content) => content.includes(`${flowId}:architect`)
        );
        expect(spawnStarts).toContain(`${flowId}:architect`);
      } finally {
        if (existingWatcher.pid) {
          try {
            process.kill(existingWatcher.pid, 'SIGTERM');
          } catch {
            // Already stopped by retry restart.
          }
        }
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });
});

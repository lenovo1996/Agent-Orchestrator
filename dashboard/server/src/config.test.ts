import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// We need to test loadConfig with controlled env and filesystem
describe('config', () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DASHBOARD_PORT;
    delete process.env.DASHBOARD_HOST;
    delete process.env.DASHBOARD_CORS_ORIGIN;
    delete process.env.DASHBOARD_CODEX_HOME;
    delete process.env.DASHBOARD_SESSION_VIEWER_ENABLED;
    delete process.env.DEVTEAM_TASK_FLOWS_DIR;
    delete process.env.CODEX_HOME;
    delete process.env.NODE_ENV;

    // Create a temporary directory structure to mock team.json
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    fs.writeFileSync(path.join(tmpDir, 'team.json'), JSON.stringify({ outputRoot: 'task-flows' }));
    fs.mkdirSync(path.join(tmpDir, 'scripts'));
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should load config with default values', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig({ repoRoot: tmpDir });
    expect(config.port).toBe(3001);
    expect(config.host).toBe('127.0.0.1');
    expect(config.corsOrigin).toBe('*');
    expect(config.isProduction).toBe(false);
    expect(config.codexHome).toBe(path.join(os.homedir(), '.codex'));
    expect(config.sessionViewerEnabled).toBe(true);
  });

  it('should respect environment variables', async () => {
    process.env.DASHBOARD_PORT = '4000';
    process.env.DASHBOARD_HOST = '0.0.0.0';
    process.env.DASHBOARD_CORS_ORIGIN = 'http://localhost:5173';
    process.env.NODE_ENV = 'production';
    process.env.DASHBOARD_CODEX_HOME = '/tmp/custom-codex-home';
    process.env.DASHBOARD_SESSION_VIEWER_ENABLED = 'false';

    const { loadConfig } = await import('./config.js');
    const config = loadConfig({ repoRoot: tmpDir });
    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.corsOrigin).toBe('http://localhost:5173');
    expect(config.isProduction).toBe(true);
    expect(config.codexHome).toBe('/tmp/custom-codex-home');
    expect(config.sessionViewerEnabled).toBe(false);
  });

  it('should resolve taskFlowsDir from team.json outputRoot', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig({ repoRoot: tmpDir });
    expect(config.taskFlowsDir).toMatch(/task-flows$/);
    expect(fs.existsSync(config.taskFlowsDir)).toBe(true);
  });

  it('should prefer DEVTEAM_TASK_FLOWS_DIR over team.json outputRoot', async () => {
    const configuredDir = path.join(tmpDir, 'host-visible-task-flows');
    process.env.DEVTEAM_TASK_FLOWS_DIR = configuredDir;

    const { loadConfig } = await import('./config.js');
    const config = loadConfig({ repoRoot: tmpDir });

    expect(config.taskFlowsDir).toBe(configuredDir);
    expect(fs.existsSync(configuredDir)).toBe(true);
  });

  it('should resolve scriptDir from root directory', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig({ repoRoot: tmpDir });
    expect(config.scriptDir).toMatch(/scripts$/);
  });

  it('should resolve clientDistPath relative to server src', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig({ repoRoot: tmpDir });
    expect(config.clientDistPath).toMatch(/client[/\\]dist$/);
  });

  it('should export DashboardConfig interface fields', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig({ repoRoot: tmpDir });
    expect(config).toHaveProperty('port');
    expect(config).toHaveProperty('host');
    expect(config).toHaveProperty('corsOrigin');
    expect(config).toHaveProperty('taskFlowsDir');
    expect(config).toHaveProperty('scriptDir');
    expect(config).toHaveProperty('clientDistPath');
    expect(config).toHaveProperty('isProduction');
    expect(config).toHaveProperty('codexHome');
    expect(config).toHaveProperty('sessionViewerEnabled');
  });
});

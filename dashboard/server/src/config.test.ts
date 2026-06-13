import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// We need to test loadConfig with controlled env and filesystem
describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env vars before each test
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.DASHBOARD_PORT;
    delete process.env.DASHBOARD_HOST;
    delete process.env.DASHBOARD_CORS_ORIGIN;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load config with default values', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.port).toBe(3001);
    expect(config.host).toBe('127.0.0.1');
    expect(config.corsOrigin).toBe('*');
    expect(config.isProduction).toBe(false);
  });

  it('should respect environment variables', async () => {
    process.env.DASHBOARD_PORT = '4000';
    process.env.DASHBOARD_HOST = '0.0.0.0';
    process.env.DASHBOARD_CORS_ORIGIN = 'http://localhost:5173';
    process.env.NODE_ENV = 'production';

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.corsOrigin).toBe('http://localhost:5173');
    expect(config.isProduction).toBe(true);
  });

  it('should resolve taskFlowsDir from team.json outputRoot', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    // team.json has outputRoot: ".dev-team/task-flows"
    expect(config.taskFlowsDir).toMatch(/\.dev-team[/\\]task-flows$/);
    expect(fs.existsSync(config.taskFlowsDir)).toBe(true);
  });

  it('should resolve parallelStatusPath relative to repo root', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.parallelStatusPath).toMatch(/\.dev-team[/\\]parallel-status\.json$/);
  });

  it('should resolve scriptDir from .dev-team directory', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.scriptDir).toMatch(/\.dev-team[/\\]scripts$/);
    expect(fs.existsSync(path.join(config.scriptDir, 'orchestrator.js'))).toBe(true);
  });

  it('should resolve clientDistPath relative to server src', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.clientDistPath).toMatch(/client[/\\]dist$/);
  });

  it('should export DashboardConfig interface fields', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    // Verify all expected fields are present
    expect(config).toHaveProperty('port');
    expect(config).toHaveProperty('host');
    expect(config).toHaveProperty('corsOrigin');
    expect(config).toHaveProperty('taskFlowsDir');
    expect(config).toHaveProperty('scriptDir');
    expect(config).toHaveProperty('parallelStatusPath');
    expect(config).toHaveProperty('clientDistPath');
    expect(config).toHaveProperty('isProduction');
  });
});

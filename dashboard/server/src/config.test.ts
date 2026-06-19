import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// We need to test loadConfig with controlled env and filesystem
describe('config', () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    fs.writeFileSync('/tmp/team.json', JSON.stringify({ outputRoot: 'task-flows' }));
    // Reset env vars before each test
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.DASHBOARD_PORT;
    delete process.env.DASHBOARD_HOST;
    delete process.env.DASHBOARD_CORS_ORIGIN;
    delete process.env.NODE_ENV;

    // Create a temporary directory structure to mock team.json
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    fs.writeFileSync(path.join(tmpDir, 'team.json'), JSON.stringify({ outputRoot: 'task-flows' }));

    // Mock findRepoRoot to return tmpDir
    vi.mock('node:url', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:url')>();
      return {
        ...actual,
        fileURLToPath: () => {
          // We can't use tmpDir here because of vi.mock hoisting.
          // So we recreate a temporary directory inside the mock.
          const t = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-mock-'));
          fs.writeFileSync(path.join(t, 'team.json'), JSON.stringify({ outputRoot: 'task-flows' }));

          const pt = path.join(t, 'dashboard/server/src/config.ts');
          fs.mkdirSync(path.dirname(pt), {recursive: true});
          return pt;
        }
      };
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    expect(config.taskFlowsDir).toMatch(/task-flows$/);
    expect(fs.existsSync(config.taskFlowsDir)).toBe(true);
  });

  it('should resolve scriptDir from root directory', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.scriptDir).toMatch(/scripts$/);
  });

  it('should resolve clientDistPath relative to server src', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.clientDistPath).toMatch(/client[/\\]dist$/);
  });

  it('should export DashboardConfig interface fields', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config).toHaveProperty('port');
    expect(config).toHaveProperty('host');
    expect(config).toHaveProperty('corsOrigin');
    expect(config).toHaveProperty('taskFlowsDir');
    expect(config).toHaveProperty('scriptDir');
    expect(config).toHaveProperty('clientDistPath');
    expect(config).toHaveProperty('isProduction');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { OrchestrationDatabase } from './database.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OrchestrationDatabase', () => {
  it('migrates a configuration-only database and enables safety pragmas', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-migration-'));
    roots.push(root);
    const filename = path.join(root, 'workflows.db');
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, steps TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, objective TEXT NOT NULL, model TEXT,
        thinking TEXT, tools TEXT NOT NULL, outputs TEXT NOT NULL, runtime TEXT,
        instructions TEXT NOT NULL
      );
      INSERT INTO workflows VALUES ('existing', 'Existing', NULL, '[]');
      INSERT INTO agents VALUES (
        'existing-agent', 'Existing agent', 'Test migration', NULL,
        NULL, '["read","exec"]', '["output/existing.md"]', 'appserver', 'Test'
      );
    `);
    legacy.close();

    const database = new OrchestrationDatabase(filename);
    expect(database.get<{ name: string }>('SELECT name FROM workflows WHERE id = ?', 'existing')?.name).toBe('Existing');
    expect(database.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(Number(database.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys)).toBe(1);
    expect(Number(database.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout)).toBe(5_000);
    expect(database.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='flows'")?.name).toBe('flows');
    expect(database.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')?.version).toBe(4);
    expect(database.get<{ tools: string }>(
      'SELECT tools FROM agents WHERE id = ?', 'existing-agent',
    )?.tools).toBe('[]');
    expect(database.get<{ name: string }>(
      "SELECT name FROM pragma_table_info('agents') WHERE name = 'runtime_command'",
    )?.name).toBe('runtime_command');
    expect(database.get<{ name: string }>(
      "SELECT name FROM pragma_table_info('workflows') WHERE name = 'needs_fix_map'",
    )?.name).toBe('needs_fix_map');
    expect(database.get<{ name: string }>(
      "SELECT name FROM pragma_table_info('flow_steps') WHERE name = 'on_needs_fix'",
    )?.name).toBe('on_needs_fix');
    database.close();
  });

  it('rolls back an immediate transaction on error', () => {
    const database = new OrchestrationDatabase(':memory:');
    expect(() => database.transaction(() => {
      database.run("INSERT INTO workspaces(id, name, path) VALUES ('rolled-back', 'X', '/tmp/x')");
      throw new Error('abort');
    })).toThrow('abort');
    expect(database.get('SELECT id FROM workspaces WHERE id = ?', 'rolled-back')).toBeUndefined();
    database.close();
  });

  it('enforces status/self-dependency constraints and cascades execution children', () => {
    const database = new OrchestrationDatabase(':memory:');
    const timestamp = new Date().toISOString();
    database.run("INSERT INTO workspaces(id, name, path) VALUES ('workspace', 'Workspace', '/tmp/workspace')");
    database.run("INSERT INTO workflows(id, name, steps) VALUES ('workflow', 'Workflow', '[\"agent\"]')");
    database.run(`
      INSERT INTO agents(id, role, objective, tools, outputs, runtime, instructions)
      VALUES ('agent', 'Agent', 'Test', '[]', '["output/agent.md"]', 'generic', 'Test')
    `);
    database.run(`
      INSERT INTO flows(
        id, workspace_id, workflow_id, step_order_json, status, created_at, updated_at
      ) VALUES ('flow', 'workspace', 'workflow', '["agent"]', 'queued', ?, ?)
    `, timestamp, timestamp);
    database.run(`
      INSERT INTO flow_steps(flow_id, step, position, status, updated_at)
      VALUES ('flow', 'agent', 0, 'waiting', ?)
    `, timestamp);
    database.run(`
      INSERT INTO step_attempts(
        id, flow_id, step, cycle, technical_attempt, inngest_run_id, inngest_attempt,
        session_run_id, runner_id, status, created_at, updated_at
      ) VALUES ('attempt', 'flow', 'agent', 1, 0, 'run', 0, 'session', 'runner', 'queued', ?, ?)
    `, timestamp, timestamp);

    expect(() => database.run("UPDATE flows SET status = 'invalid' WHERE id = 'flow'"))
      .toThrow();
    expect(() => database.run(`
      INSERT INTO flow_dependencies(flow_id, dependency_flow_id) VALUES ('flow', 'flow')
    `)).toThrow();

    database.run("DELETE FROM flows WHERE id = 'flow'");
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM flow_steps')?.count).toBe(0);
    expect(database.get<{ count: number }>('SELECT COUNT(*) AS count FROM step_attempts')?.count).toBe(0);
    database.close();
  });
});

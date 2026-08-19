import { DatabaseSync, type SQLInputValue, type StatementResultingChanges } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const FLOW_STATUS_CHECK = "'queued','pending_dependencies','running','blocked','completed','failed','stopping','stopped','expired'";
const STEP_STATUS_CHECK = "'waiting','queued','running','retrying','done','needs_fix','blocked','failed','cancelled'";

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'inngest_orchestration_cutover',
    sql: `
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        steps TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        objective TEXT NOT NULL,
        model TEXT,
        thinking TEXT,
        tools TEXT NOT NULL,
        outputs TEXT NOT NULL,
        runtime TEXT,
        instructions TEXT NOT NULL
      );

      CREATE TABLE flows (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
        jira_key TEXT,
        custom_prompt TEXT,
        step_order_json TEXT NOT NULL CHECK (json_valid(step_order_json)),
        status TEXT NOT NULL CHECK (status IN (${FLOW_STATUS_CHECK})),
        current_step TEXT,
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        use_worktree INTEGER NOT NULL DEFAULT 0 CHECK (use_worktree IN (0, 1)),
        worktree_path TEXT,
        worktree_branch TEXT,
        blocked_summary TEXT,
        error_summary TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE flow_steps (
        flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        step TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        status TEXT NOT NULL CHECK (status IN (${STEP_STATUS_CHECK})),
        cycle INTEGER NOT NULL DEFAULT 1 CHECK (cycle > 0),
        technical_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (technical_retry_count >= 0),
        needs_fix_count INTEGER NOT NULL DEFAULT 0 CHECK (needs_fix_count >= 0),
        output_path TEXT,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (flow_id, step),
        UNIQUE (flow_id, position)
      );

      CREATE TABLE flow_dependencies (
        flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        dependency_flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE RESTRICT,
        PRIMARY KEY (flow_id, dependency_flow_id),
        CHECK (flow_id <> dependency_flow_id)
      );

      CREATE TABLE flow_commands (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('start','retry','resume','stop','delete')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending','dispatched','running','completed','failed','cancelled')),
        claimed_by TEXT,
        claimed_at TEXT,
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE orchestration_runs (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation > 0),
        command_id TEXT NOT NULL REFERENCES flow_commands(id) ON DELETE RESTRICT,
        inngest_run_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','completed','failed','cancelled','expired')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (flow_id, generation),
        UNIQUE (command_id)
      );

      CREATE TABLE step_attempts (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        step TEXT NOT NULL,
        cycle INTEGER NOT NULL CHECK (cycle > 0),
        technical_attempt INTEGER NOT NULL CHECK (technical_attempt >= 0),
        inngest_run_id TEXT NOT NULL,
        inngest_attempt INTEGER NOT NULL CHECK (inngest_attempt >= 0),
        session_run_id TEXT NOT NULL UNIQUE,
        runner_id TEXT NOT NULL,
        pid INTEGER,
        process_group_id INTEGER,
        exit_code INTEGER,
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (flow_id, step) REFERENCES flow_steps(flow_id, step) ON DELETE CASCADE,
        UNIQUE (flow_id, step, cycle, technical_attempt)
      );

      CREATE TABLE event_outbox (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        flow_id TEXT NOT NULL,
        command_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        created_at TEXT NOT NULL,
        sent_at TEXT,
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE domain_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT,
        flow_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL
      );

      CREATE TABLE orchestrator_workers (
        runner_id TEXT PRIMARY KEY,
        connection_status TEXT NOT NULL CHECK (connection_status IN ('connecting','connected','disconnected','stopping')),
        capacity INTEGER NOT NULL CHECK (capacity > 0),
        active_attempts INTEGER NOT NULL DEFAULT 0 CHECK (active_attempts >= 0),
        last_heartbeat TEXT NOT NULL,
        version TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_flows_workspace_updated ON flows(workspace_id, updated_at DESC);
      CREATE INDEX idx_flow_dependencies_dependency ON flow_dependencies(dependency_flow_id);
      CREATE INDEX idx_runs_flow_status ON orchestration_runs(flow_id, status);
      CREATE INDEX idx_attempts_flow_status ON step_attempts(flow_id, status);
      CREATE INDEX idx_attempts_business_order ON step_attempts(flow_id, step, cycle, technical_attempt);
      CREATE INDEX idx_commands_flow_status ON flow_commands(flow_id, status);
      CREATE INDEX idx_outbox_pending ON event_outbox(sent_at, lease_expires_at, created_at);
      CREATE INDEX idx_domain_events_workspace_sequence ON domain_events(workspace_id, sequence);
      CREATE INDEX idx_workers_heartbeat ON orchestrator_workers(last_heartbeat);
    `,
  },
  {
    version: 2,
    name: 'agent_runtime_command',
    sql: 'ALTER TABLE agents ADD COLUMN runtime_command TEXT;',
  },
];

export type DatabaseRow = Record<string, unknown>;

export class OrchestrationDatabase {
  readonly raw: DatabaseSync;

  constructor(readonly filename: string) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.raw = new DatabaseSync(filename);
    this.raw.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      this.all<{ version: number }>('SELECT version FROM schema_migrations').map((row) => Number(row.version)),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.run(
          'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
          migration.version,
          migration.name,
          new Date().toISOString(),
        );
      });
    }
  }

  transaction<T>(operation: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.raw.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  run(sql: string, ...params: SQLInputValue[]): StatementResultingChanges {
    return this.raw.prepare(sql).run(...params);
  }

  get<T extends DatabaseRow>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends DatabaseRow>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  close(): void {
    this.raw.close();
  }
}

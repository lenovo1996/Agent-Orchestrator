#!/usr/bin/env python3
"""Seed fake flows and their artifacts into a local workflows database."""

from __future__ import annotations

import argparse
import json
import os
import random
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from create_fake_artifacts import (
    DEFAULT_TASK_FLOWS_DIR,
    DEFAULT_WORKSPACE,
    create_artifacts,
    resolve_workspace_id,
)


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = Path(os.environ.get("DEVTEAM_DB_PATH", SCRIPT_DIR / "workflows.db"))
FAKE_TASKS = [
    "Fix a synthetic authentication regression",
    "Add deterministic tests for a fake payroll calculation",
    "Design a sample audit-log retention policy",
    "Investigate a simulated WebSocket race condition",
    "Refactor a demo notification pipeline without behavior changes",
    "Review a fake pull request for tenant-isolation risks",
    "Estimate a sample employee-import feature",
    "Research a synthetic API migration strategy",
]


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stable_uuid(seed: int, *parts: object) -> str:
    value = ":".join([str(seed), *(str(part) for part in parts)])
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"devteam-fake:{value}"))


def load_catalog(
    connection: sqlite3.Connection,
    min_steps: int,
    max_steps: int,
) -> list[dict[str, object]]:
    agent_outputs = {
        row["id"]: json.loads(row["outputs"])
        for row in connection.execute("SELECT id, outputs FROM agents")
    }
    catalog: list[dict[str, object]] = []
    for row in connection.execute(
        "SELECT id, name, steps, context, needs_fix_map FROM workflows ORDER BY name, id"
    ):
        steps = json.loads(row["steps"])
        needs_fix = json.loads(row["needs_fix_map"])
        if len(steps) < min_steps:
            continue
        if any(step not in agent_outputs or not agent_outputs[step] for step in steps):
            continue
        catalog.append({
            "id": row["id"],
            "name": row["name"],
            "steps": steps,
            "context": row["context"],
            "needs_fix": needs_fix,
            "outputs": {step: agent_outputs[step][0] for step in steps},
        })
    if not catalog:
        raise RuntimeError(f"No valid workflows with at least {min_steps} steps found")
    return catalog


def clean_fake_flows(connection: sqlite3.Connection, workspace_id: str) -> int:
    flow_ids = [
        row["id"]
        for row in connection.execute(
            "SELECT id FROM flows WHERE workspace_id = ? AND id GLOB 'flow_fake_*'",
            (workspace_id,),
        )
    ]
    if flow_ids:
        placeholders = ",".join("?" for _ in flow_ids)
        connection.execute(
            f"DELETE FROM flow_dependencies WHERE flow_id IN ({placeholders}) "
            f"OR dependency_flow_id IN ({placeholders})",
            (*flow_ids, *flow_ids),
        )
        for table in ("step_attempts", "orchestration_runs", "flow_steps", "event_outbox", "domain_events"):
            connection.execute(f"DELETE FROM {table} WHERE flow_id IN ({placeholders})", flow_ids)
        connection.execute(f"DELETE FROM flow_commands WHERE flow_id IN ({placeholders})", flow_ids)
        connection.execute(f"DELETE FROM flows WHERE id IN ({placeholders})", flow_ids)
    return len(flow_ids)


def seed_flows(
    db_path: Path,
    count: int,
    workspace_selector: str,
    seed: int,
    min_steps: int,
    max_steps: int,
    jira_min: int,
    jira_max: int,
    blocked_count: int,
    stopped_count: int,
) -> tuple[str, list[str]]:
    if count < 0 or count > 200:
        raise ValueError("count must be between 0 and 200")
    if not db_path.is_file():
        raise FileNotFoundError(f"Database not found: {db_path}")
    if min_steps < 1 or max_steps < min_steps:
        raise ValueError("step range is invalid")
    if jira_min < 1 or jira_max < jira_min or jira_max - jira_min + 1 < count:
        raise ValueError("Jira range is invalid or too small for the requested count")
    if blocked_count < 0 or stopped_count < 0:
        raise ValueError("blocked and stopped counts must be non-negative")
    if blocked_count + stopped_count > count:
        raise ValueError("blocked and stopped counts cannot exceed the total count")

    rng = random.Random(seed)
    connection = sqlite3.connect(db_path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        workspace_id = resolve_workspace_id(connection, workspace_selector)
        catalog = load_catalog(connection, min_steps, max_steps)
        with connection:
            removed = clean_fake_flows(connection, workspace_id)
            existing_jira = {
                row["jira_key"]
                for row in connection.execute(
                    "SELECT jira_key FROM flows WHERE jira_key IS NOT NULL"
                )
            }
            available_jira = [
                number for number in range(jira_min, jira_max + 1)
                if f"JH-{number}" not in existing_jira
            ]
            if len(available_jira) < count:
                raise ValueError("Not enough unused Jira keys in the requested range")
            jira_numbers = rng.sample(available_jira, count)
            flow_statuses = (
                ["blocked"] * blocked_count
                + ["stopped"] * stopped_count
                + ["completed"] * (count - blocked_count - stopped_count)
            )
            rng.shuffle(flow_statuses)

            now = datetime.now(timezone.utc)
            flow_ids: list[str] = []
            workspace_token = uuid.uuid5(uuid.NAMESPACE_URL, workspace_id).hex[:8]
            for index in range(count):
                workflow = rng.choice(catalog)
                all_steps = workflow["steps"]
                step_count = rng.randint(min_steps, min(max_steps, len(all_steps)))
                steps = all_steps[:step_count]
                flow_id = f"flow_fake_{seed}_{workspace_token}_{index + 1:03d}"
                command_id = stable_uuid(seed, flow_id, "command")
                coordinator_run_id = f"fake-coordinator-{stable_uuid(seed, flow_id, 'run')}"
                jira_key = f"JH-{jira_numbers[index]}"
                prompt = FAKE_TASKS[index % len(FAKE_TASKS)]
                created_at = now - timedelta(days=index + 1, hours=2)
                started_at = created_at + timedelta(seconds=15)
                step_duration = timedelta(minutes=rng.randint(4, 18))
                flow_status = flow_statuses[index]
                active_position = (
                    None if flow_status == "completed" else rng.randrange(len(steps))
                )
                state_time = started_at + step_duration * (
                    len(steps) if active_position is None else active_position + 1
                )
                current_step = None if active_position is None else steps[active_position]
                finished_at = None if flow_status == "blocked" else state_time
                blocked_summary = (
                    f"Synthetic blocker reported by {current_step}"
                    if flow_status == "blocked"
                    else None
                )

                connection.execute(
                    """
                    INSERT INTO flows(
                        id, workspace_id, workflow_id, jira_key, custom_prompt, workflow_context,
                        step_order_json, status, current_step, generation, revision, use_worktree,
                        worktree_path, worktree_branch, blocked_summary, error_summary,
                        created_at, started_at, finished_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0,
                              NULL, NULL, ?, NULL, ?, ?, ?, ?)
                    """,
                    (
                        flow_id, workspace_id, workflow["id"], jira_key, prompt, workflow["context"],
                        json.dumps(steps), flow_status, current_step, len(steps) + 2,
                        blocked_summary, iso(created_at), iso(started_at),
                        iso(finished_at) if finished_at else None, iso(state_time),
                    ),
                )

                for position, step in enumerate(steps):
                    step_started = started_at + step_duration * position
                    step_finished = step_started + step_duration
                    if flow_status == "completed" or position < active_position:
                        step_status = "done"
                    elif position == active_position:
                        step_status = "blocked" if flow_status == "blocked" else "cancelled"
                    else:
                        step_status = "waiting"
                    recorded_started = None if step_status == "waiting" else iso(step_started)
                    recorded_finished = None if step_status == "waiting" else iso(step_finished)
                    step_updated = recorded_finished or iso(state_time)
                    configured_target = workflow["needs_fix"].get(step)
                    on_needs_fix = (
                        configured_target
                        if configured_target == "block" or configured_target in steps
                        else None
                    )
                    connection.execute(
                        """
                        INSERT INTO flow_steps(
                            flow_id, step, position, status, cycle, technical_retry_count,
                            needs_fix_count, on_needs_fix, output_path,
                            started_at, finished_at, updated_at
                        ) VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?, ?)
                        """,
                        (
                            flow_id, step, position, step_status, on_needs_fix,
                            workflow["outputs"][step], recorded_started, recorded_finished,
                            step_updated,
                        ),
                    )
                    if step_status == "waiting":
                        continue
                    attempt_id = stable_uuid(seed, flow_id, step, "attempt")
                    session_run_id = stable_uuid(seed, flow_id, step, "session")
                    child_run_id = f"fake-agent-{stable_uuid(seed, flow_id, step, 'inngest')}"
                    attempt_status = "cancelled" if step_status == "cancelled" else "completed"
                    exit_code = None if attempt_status == "cancelled" else 0
                    connection.execute(
                        """
                        INSERT INTO step_attempts(
                            id, flow_id, step, cycle, technical_attempt,
                            inngest_run_id, inngest_attempt, session_run_id, runner_id,
                            pid, process_group_id, exit_code, status, error_json,
                            created_at, started_at, finished_at, updated_at
                        ) VALUES (?, ?, ?, 1, 0, ?, 0, ?, 'fake-seeder',
                                  NULL, NULL, ?, ?, NULL, ?, ?, ?, ?)
                        """,
                        (
                            attempt_id, flow_id, step, child_run_id, session_run_id,
                            exit_code, attempt_status,
                            iso(step_started), iso(step_started), iso(step_finished), iso(step_finished),
                        ),
                    )

                start_command_status = {
                    "completed": "completed",
                    "blocked": "running",
                    "stopped": "cancelled",
                }[flow_status]
                start_finished_at = None if flow_status == "blocked" else iso(state_time)
                connection.execute(
                    """
                    INSERT INTO flow_commands(
                        id, flow_id, type, payload_json, idempotency_key, status,
                        claimed_by, claimed_at, error_json, created_at, updated_at, finished_at
                    ) VALUES (?, ?, 'start', ?, ?, ?, 'fake-seeder', ?, NULL, ?, ?, ?)
                    """,
                    (
                        command_id, flow_id, json.dumps({"flowId": flow_id, "fake": True}),
                        f"fake-seed:{seed}:{flow_id}", start_command_status, iso(started_at),
                        iso(created_at), iso(state_time), start_finished_at,
                    ),
                )
                orchestration_status = {
                    "completed": "completed",
                    "blocked": "waiting",
                    "stopped": "cancelled",
                }[flow_status]
                connection.execute(
                    """
                    INSERT INTO orchestration_runs(
                        id, flow_id, generation, command_id, inngest_run_id, status,
                        created_at, started_at, finished_at, updated_at
                    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        stable_uuid(seed, flow_id, "orchestration"), flow_id, command_id,
                        coordinator_run_id, orchestration_status, iso(created_at), iso(started_at),
                        start_finished_at, iso(state_time),
                    ),
                )
                if flow_status == "stopped":
                    stop_command_id = stable_uuid(seed, flow_id, "stop-command")
                    connection.execute(
                        """
                        INSERT INTO flow_commands(
                            id, flow_id, type, payload_json, idempotency_key, status,
                            claimed_by, claimed_at, error_json, created_at, updated_at, finished_at
                        ) VALUES (?, ?, 'stop', '{}', ?, 'completed', 'fake-seeder', ?, NULL, ?, ?, ?)
                        """,
                        (
                            stop_command_id, flow_id, f"fake-stop:{seed}:{flow_id}",
                            iso(state_time), iso(state_time), iso(state_time), iso(state_time),
                        ),
                    )
                final_event_type = {
                    "completed": "flow.completed",
                    "blocked": "flow.blocked",
                    "stopped": "flow.stopped",
                }[flow_status]
                for event_type, event_time in (
                    ("flow.started", started_at),
                    (final_event_type, state_time),
                ):
                    event_status = "running" if event_type == "flow.started" else flow_status
                    connection.execute(
                        """
                        INSERT INTO domain_events(
                            workspace_id, flow_id, event_type, payload_json, created_at
                        ) VALUES (?, ?, ?, ?, ?)
                        """,
                        (
                            workspace_id, flow_id, event_type,
                            json.dumps({"flowId": flow_id, "status": event_status, "fake": True}),
                            iso(event_time),
                        ),
                    )
                flow_ids.append(flow_id)

        print(f"Removed {removed} previous fake flows from {workspace_id}")
        return workspace_id, flow_ids
    finally:
        connection.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("count", nargs="?", type=int, default=30)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--task-flows-dir", type=Path, default=DEFAULT_TASK_FLOWS_DIR)
    parser.add_argument("--workspace", default=DEFAULT_WORKSPACE, help="Workspace ID or name")
    parser.add_argument("--min-steps", type=int, default=3)
    parser.add_argument("--max-steps", type=int, default=6)
    parser.add_argument("--jira-min", type=int, default=30000)
    parser.add_argument("--jira-max", type=int, default=45000)
    parser.add_argument("--blocked-count", type=int, default=4)
    parser.add_argument("--stopped-count", type=int, default=3)
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument("--no-artifacts", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    workspace_id, seeded = seed_flows(
        arguments.db.resolve(),
        arguments.count,
        arguments.workspace,
        arguments.seed,
        arguments.min_steps,
        arguments.max_steps,
        arguments.jira_min,
        arguments.jira_max,
        arguments.blocked_count,
        arguments.stopped_count,
    )
    completed_count = len(seeded) - arguments.blocked_count - arguments.stopped_count
    print(
        f"Seeded {len(seeded)} fake flows into workspace {workspace_id} "
        f"({completed_count} completed, {arguments.blocked_count} blocked, "
        f"{arguments.stopped_count} stopped) in {arguments.db.resolve()}"
    )
    if not arguments.no_artifacts:
        flow_count, output_count = create_artifacts(
            arguments.db.resolve(),
            arguments.task_flows_dir.resolve(),
            workspace_id,
            clean=True,
            seed=arguments.seed,
        )
        print(
            f"Created artifacts for {flow_count} fake flows "
            f"({output_count} outputs) under {arguments.task_flows_dir.resolve()}"
        )

#!/usr/bin/env python3
"""Create dashboard-compatible artifacts for fake flows in a selected workspace."""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import sqlite3
from pathlib import Path, PurePosixPath


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = Path(os.environ.get("DEVTEAM_DB_PATH", SCRIPT_DIR / "workflows.db"))
DEFAULT_TASK_FLOWS_DIR = Path(
    os.environ.get("DEVTEAM_TASK_FLOWS_DIR", SCRIPT_DIR / "task-flows")
)
DEFAULT_WORKSPACE = os.environ.get("DEVTEAM_FAKE_WORKSPACE", "jinjer")
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]+$")


def safe_relative_path(value: str, label: str) -> Path:
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or not candidate.parts or ".." in candidate.parts:
        raise ValueError(f"Unsafe {label}: {value}")
    return Path(*candidate.parts)


def workspace_artifact_root(task_flows_dir: Path, workspace_id: str) -> Path:
    if not SAFE_ID.fullmatch(workspace_id):
        raise ValueError(f"Unsafe workspace ID: {workspace_id}")
    return task_flows_dir.resolve() / workspace_id


def resolve_workspace_id(connection: sqlite3.Connection, selector: str) -> str:
    exact = connection.execute(
        "SELECT id FROM workspaces WHERE id = ?", (selector,)
    ).fetchone()
    if exact:
        return exact["id"]
    matches = connection.execute(
        "SELECT id FROM workspaces WHERE lower(name) = lower(?) ORDER BY id", (selector,)
    ).fetchall()
    if not matches:
        raise ValueError(f"Workspace not found by ID or name: {selector}")
    if len(matches) > 1:
        raise ValueError(f"Workspace name is ambiguous; use its ID: {selector}")
    return matches[0]["id"]


def output_status(step_status: str) -> str:
    if step_status == "done":
        return "DONE"
    if step_status == "blocked":
        return "BLOCKED"
    return "FAILED"


def fake_output(
    workflow_name: str,
    jira_key: str | None,
    prompt: str | None,
    step: str,
    step_status: str,
) -> str:
    status = output_status(step_status)
    return f"""## Status
{status}

# Fake {step.replace('_', ' ').title()} Artifact

- Workflow: {workflow_name}
- Ticket: {jira_key or 'N/A'}
- Task: {prompt or 'Synthetic dashboard data'}
- Step state: {step_status}

## Summary

This deterministic fake artifact is intended for local dashboard and session-viewer testing.

## Validation

Tests: 8 passed, 0 failed
"""


def fake_log(step: str, started_at: str, token_count: int) -> str:
    return "\n".join([
        f"[{started_at}] Runtime: fake-seed",
        f"[{started_at}] Starting {step}",
        f"[{started_at}] Reading synthetic workflow context",
        f"[{started_at}] Writing synthetic output",
        "tokens used",
        str(token_count),
        f"[{started_at}] Step finished",
        "",
    ])


def session_status(attempt_status: str) -> str:
    return {
        "queued": "starting",
        "running": "running",
        "completed": "completed",
        "failed": "failed",
        "cancelled": "cancelled",
    }[attempt_status]


def create_artifacts(
    db_path: Path,
    task_flows_dir: Path,
    workspace_selector: str = DEFAULT_WORKSPACE,
    *,
    clean: bool = False,
    seed: int = 20260825,
) -> tuple[int, int]:
    if not db_path.is_file():
        raise FileNotFoundError(f"Database not found: {db_path}")

    rng = random.Random(seed)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        workspace_id = resolve_workspace_id(connection, workspace_selector)
        workspace_root = workspace_artifact_root(task_flows_dir, workspace_id)
        if clean and workspace_root.exists():
            for child in workspace_root.iterdir():
                if child.is_dir() and child.name.startswith("flow_fake_") and SAFE_ID.fullmatch(child.name):
                    shutil.rmtree(child)
        workspace_root.mkdir(parents=True, exist_ok=True)

        flows = connection.execute(
            """
            SELECT flows.id, flows.workflow_id, workflows.name AS workflow_name,
                   flows.jira_key, flows.custom_prompt
            FROM flows
            JOIN workflows ON workflows.id = flows.workflow_id
            WHERE flows.workspace_id = ? AND flows.id GLOB 'flow_fake_*'
            ORDER BY flows.created_at DESC, flows.id
            """,
            (workspace_id,),
        ).fetchall()

        artifact_count = 0
        for flow in flows:
            flow_id = flow["id"]
            if not SAFE_ID.fullmatch(flow_id):
                raise ValueError(f"Unsafe flow ID: {flow_id}")
            flow_root = workspace_root / flow_id
            steps = connection.execute(
                """
                SELECT step, status, output_path, started_at, finished_at
                FROM flow_steps WHERE flow_id = ? ORDER BY position
                """,
                (flow_id,),
            ).fetchall()
            attempts = connection.execute(
                """
                SELECT id, step, inngest_run_id, inngest_attempt, session_run_id,
                       status, exit_code, error_json, created_at, started_at, finished_at
                FROM step_attempts WHERE flow_id = ?
                ORDER BY step, cycle, technical_attempt
                """,
                (flow_id,),
            ).fetchall()

            for step in steps:
                if step["output_path"] and step["status"] in {"done", "blocked", "failed"}:
                    output_path = safe_relative_path(step["output_path"], "output path")
                    output_file = flow_root / output_path
                    output_file.parent.mkdir(parents=True, exist_ok=True)
                    output_file.write_text(
                        fake_output(
                            flow["workflow_name"],
                            flow["jira_key"],
                            flow["custom_prompt"],
                            step["step"],
                            step["status"],
                        ),
                        encoding="utf-8",
                    )
                    artifact_count += 1

                step_attempts = [attempt for attempt in attempts if attempt["step"] == step["step"]]
                if step_attempts:
                    token_count = rng.randint(1_500, 18_000)
                    log_file = flow_root / "logs" / f"{step['step']}.log"
                    log_file.parent.mkdir(parents=True, exist_ok=True)
                    log_file.write_text(
                        fake_log(step["step"], step["started_at"] or step_attempts[0]["created_at"], token_count),
                        encoding="utf-8",
                    )

                session_dir = flow_root / "sessions" / step["step"]
                session_dir.mkdir(parents=True, exist_ok=True)
                for attempt in step_attempts:
                    usage = {
                        "inputTokens": rng.randint(2_000, 12_000),
                        "cachedInputTokens": rng.randint(0, 2_000),
                        "outputTokens": rng.randint(500, 4_000),
                        "reasoningOutputTokens": rng.randint(100, 1_500),
                    }
                    parsed_error = json.loads(attempt["error_json"]) if attempt["error_json"] else None
                    error_message = parsed_error.get("message") if isinstance(parsed_error, dict) else None
                    metadata = {
                        "schemaVersion": 2,
                        "runId": attempt["session_run_id"],
                        "attemptId": attempt["id"],
                        "inngestRunId": attempt["inngest_run_id"],
                        "inngestAttempt": attempt["inngest_attempt"],
                        "flowId": flow_id,
                        "step": step["step"],
                        "threadId": None,
                        "turnId": None,
                        "status": session_status(attempt["status"]),
                        "startedAt": attempt["started_at"] or attempt["created_at"],
                        "finishedAt": attempt["finished_at"],
                        "exitCode": attempt["exit_code"],
                        "usage": usage,
                        "errorSummary": (
                            {"stage": "process", "message": error_message or "Synthetic failure"}
                            if attempt["status"] == "failed" else None
                        ),
                    }
                    metadata_file = session_dir / f"{attempt['session_run_id']}.json"
                    metadata_file.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

        return len(flows), artifact_count
    finally:
        connection.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--task-flows-dir", type=Path, default=DEFAULT_TASK_FLOWS_DIR)
    parser.add_argument("--workspace", default=DEFAULT_WORKSPACE, help="Workspace ID or name")
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument("--clean", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    flow_count, output_count = create_artifacts(
        arguments.db.resolve(),
        arguments.task_flows_dir.resolve(),
        arguments.workspace,
        clean=arguments.clean,
        seed=arguments.seed,
    )
    print(
        f"Created artifacts for {flow_count} fake flows "
        f"({output_count} outputs) under "
        f"workspace {arguments.workspace}"
    )

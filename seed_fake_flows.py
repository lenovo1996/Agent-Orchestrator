#!/usr/bin/env python3
"""
Seed fake completed task flows into workflows.db
Prefix: JH-{random 30000~42000}
Status: completed (all steps done)
"""

import sqlite3
import random
import uuid
import json
import os
import subprocess
from datetime import datetime, timedelta, timezone

DB_PATH = "/Users/phi/Workplace/phi/Agent-Orchestrator/workflows.db"

# ─── helpers ──────────────────────────────────────────────────────────────────

def now_iso(offset_seconds=0):
    dt = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

def rand_id(prefix=""):
    ts = int(datetime.now(timezone.utc).timestamp() * 1000) + random.randint(0, 9999)
    return f"{prefix}{ts}" if prefix else str(ts)

def new_uuid():
    return str(uuid.uuid4())

# ─── workflow definitions (mapped to existing workflows in DB) ─────────────────

WORKFLOW_TEMPLATES = [
    {
        "id": "wf_1781774515782",
        "name": "Bug Fixer Process",
        "steps": ["investigator", "fix_planner", "fix_implementer", "bug_verifier"],
    },
    {
        "id": "wf_1782727041696",
        "name": "Fast Implement",
        "steps": ["planner", "implementer", "verifier"],
    },
    {
        "id": "wf_1781492568626",
        "name": "Code Refactor Process",
        "steps": ["analyzer", "refactor-planner", "refactor-implementer", "verifier"],
    },
    {
        "id": "wf_1781505332912",
        "name": "Unit Test Process",
        "steps": ["analyzer", "implementer", "verifier"],
    },
    {
        "id": "wf_1782724953459",
        "name": "Solution Design",
        "steps": ["architect"],
    },
    {
        "id": "wf_1783391501862",
        "name": "Task planner",
        "steps": ["planner"],
    },
    {
        "id": "wf_1781682101812",
        "name": "Spec Clarify Process",
        "steps": ["clarifier"],
    },
    {
        "id": "wf_1783417106136",
        "name": "PR Verifier",
        "steps": ["verifier"],
    },
]

FAKE_TASKS = [
    "Fix null pointer exception in auth middleware",
    "Refactor payment service to use repository pattern",
    "Add unit tests for user registration flow",
    "Implement JWT refresh token rotation",
    "Fix race condition in WebSocket handler",
    "Refactor legacy config loader module",
    "Add integration tests for checkout API",
    "Implement rate limiting middleware",
    "Fix memory leak in file upload handler",
    "Refactor database connection pooling",
    "Add unit tests for order calculation engine",
    "Implement webhook signature verification",
    "Fix SQL injection vulnerability in search endpoint",
    "Refactor notification service to async queue",
    "Add unit tests for email template renderer",
    "Implement CORS configuration for production",
    "Fix broken pagination in admin dashboard",
    "Refactor logging to structured JSON format",
    "Add unit tests for discount code validator",
    "Implement health check endpoint with DB ping",
    "Fix timezone handling in scheduled jobs",
    "Refactor cache invalidation strategy",
    "Add unit tests for CSV export service",
    "Implement two-factor authentication",
    "Fix session expiry not propagating to frontend",
    "Refactor microservice communication to gRPC",
    "Add unit tests for address validation logic",
    "Implement audit trail for admin actions",
    "Fix floating point rounding in invoice totals",
    "Refactor S3 upload to use presigned URLs",
]

WORKSPACE_ID = "ws_fake_demo_001"
WORKSPACE_NAME = "JINJER"
# Must be a real directory that exists inside DEVTEAM_WORKSPACE_ROOT (/Users/phi/Workplace/phi)
WORKSPACE_PATH = "/Users/phi/Workplace/jinjer/PHP8"


# ─── main seeder ──────────────────────────────────────────────────────────────

def seed(n=10):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    cur = conn.cursor()

    # ── cleanup old fake data first ──
    print("[~] Cleaning up old fake data...")
    # Get all flow_ids belonging to our fake workspace
    old_flows = [r[0] for r in cur.execute(
        "SELECT id FROM flows WHERE workspace_id = ?", (WORKSPACE_ID,)
    ).fetchall()]
    if old_flows:
        for fid in old_flows:
            cur.execute("DELETE FROM step_attempts WHERE flow_id = ?", (fid,))
            cur.execute("DELETE FROM orchestration_runs WHERE flow_id = ?", (fid,))
            cur.execute("DELETE FROM flow_steps WHERE flow_id = ?", (fid,))
            cur.execute("DELETE FROM flow_commands WHERE flow_id = ?", (fid,))
            cur.execute("DELETE FROM event_outbox WHERE flow_id = ?", (fid,))
            cur.execute("DELETE FROM domain_events WHERE flow_id = ?", (fid,))
        cur.execute("DELETE FROM flows WHERE workspace_id = ?", (WORKSPACE_ID,))
        print(f"  Removed {len(old_flows)} old flows")
    cur.execute("DELETE FROM workspaces WHERE id = ?", (WORKSPACE_ID,))

    # ── ensure workspace exists ──
    cur.execute(
        "INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)",
        (WORKSPACE_ID, WORKSPACE_NAME, WORKSPACE_PATH),
    )
    print(f"[+] Created workspace: {WORKSPACE_NAME} → {WORKSPACE_PATH}")

    used_jh = set()
    inserted = 0

    for i in range(n):
        # ── pick random JH ticket ──
        jh_num = random.randint(30000, 42000)
        while jh_num in used_jh:
            jh_num = random.randint(30000, 42000)
        used_jh.add(jh_num)
        jira_key = f"JH-{jh_num}"

        # ── pick random workflow ──
        wf = random.choice(WORKFLOW_TEMPLATES)
        steps = wf["steps"]

        # ── timeline: flow completed between 1~30 days ago ──
        days_ago = random.randint(1, 30)
        flow_created_offset = -(days_ago * 86400) - random.randint(3600, 7200)
        flow_started_offset = flow_created_offset + random.randint(5, 30)
        flow_finished_offset = flow_started_offset + random.randint(600, 3600 * len(steps))

        created_at  = now_iso(flow_created_offset)
        started_at  = now_iso(flow_started_offset)
        finished_at = now_iso(flow_finished_offset)
        updated_at  = finished_at

        # ── build step_order_json ──
        step_order_json = json.dumps(steps)

        # ── flow id ──
        flow_id = f"flow_{rand_id()}_{i}"

        custom_prompt = random.choice(FAKE_TASKS)

        # ── insert flow ──
        cur.execute("""
            INSERT INTO flows (
                id, workspace_id, workflow_id, jira_key, custom_prompt,
                step_order_json, status, current_step,
                generation, revision, use_worktree,
                worktree_path, worktree_branch,
                blocked_summary, error_summary,
                created_at, started_at, finished_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?,
                ?, ?,
                ?, ?, ?, ?
            )
        """, (
            flow_id, WORKSPACE_ID, wf["id"], jira_key, custom_prompt,
            step_order_json, "completed", steps[-1],
            1, 0, 0,
            None, None,
            None, None,
            created_at, started_at, finished_at, updated_at,
        ))

        # ── insert flow_steps (all done) ──
        step_start = flow_started_offset
        step_duration = (flow_finished_offset - flow_started_offset) // len(steps)

        for pos, step_name in enumerate(steps):
            s_started  = now_iso(step_start)
            s_finished = now_iso(step_start + step_duration)
            s_updated  = s_finished
            step_start += step_duration + random.randint(0, 60)

            # output path for this step
            output_path = f"output/{step_name}.md"

            cur.execute("""
                INSERT INTO flow_steps (
                    flow_id, step, position, status, cycle,
                    technical_retry_count, needs_fix_count,
                    output_path, started_at, finished_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?
                )
            """, (
                flow_id, step_name, pos, "done", 1,
                0, 0,
                output_path, s_started, s_finished, s_updated,
            ))

        # ── insert flow_command (start → completed) ──
        cmd_id = f"cmd_{new_uuid()}"
        idempotency_key = f"start_{flow_id}_gen1"
        cur.execute("""
            INSERT INTO flow_commands (
                id, flow_id, type, payload_json, idempotency_key,
                status, claimed_by, claimed_at, error_json,
                created_at, updated_at, finished_at
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?
            )
        """, (
            cmd_id, flow_id, "start",
            json.dumps({"flow_id": flow_id, "generation": 1}),
            idempotency_key,
            "completed", "orchestrator-1", started_at, None,
            created_at, finished_at, finished_at,
        ))

        # ── insert orchestration_run ──
        run_id = f"run_{new_uuid()}"
        inngest_run_id = f"inngest_{new_uuid().replace('-', '')[:16]}"
        cur.execute("""
            INSERT INTO orchestration_runs (
                id, flow_id, generation, command_id, inngest_run_id,
                status, created_at, started_at, finished_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?
            )
        """, (
            run_id, flow_id, 1, cmd_id, inngest_run_id,
            "completed", created_at, started_at, finished_at, finished_at,
        ))

        # ── insert step_attempts ──
        attempt_start = flow_started_offset
        attempt_duration = (flow_finished_offset - flow_started_offset) // len(steps)

        for step_name in steps:
            attempt_id = f"att_{new_uuid()}"
            session_run_id = f"sess_{new_uuid()}"
            a_started  = now_iso(attempt_start)
            a_finished = now_iso(attempt_start + attempt_duration)
            attempt_start += attempt_duration + random.randint(0, 60)

            cur.execute("""
                INSERT INTO step_attempts (
                    id, flow_id, step, cycle, technical_attempt,
                    inngest_run_id, inngest_attempt,
                    session_run_id, runner_id, pid, process_group_id,
                    exit_code, status, error_json,
                    created_at, started_at, finished_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, ?
                )
            """, (
                attempt_id, flow_id, step_name, 1, 0,
                inngest_run_id, 0,
                session_run_id, "orchestrator-1",
                random.randint(10000, 60000),
                random.randint(10000, 60000),
                0, "completed", None,
                a_started, a_started, a_finished, a_finished,
            ))

        # ── domain events ──
        for evt_type, evt_offset in [
            ("flow.started",   flow_started_offset),
            ("flow.completed", flow_finished_offset),
        ]:
            cur.execute("""
                INSERT INTO domain_events (
                    workspace_id, flow_id, event_type, payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?)
            """, (
                WORKSPACE_ID, flow_id, evt_type,
                json.dumps({"flow_id": flow_id, "jira_key": jira_key, "workflow": wf["name"]}),
                now_iso(evt_offset),
            ))

        inserted += 1
        print(f"  ✅ {jira_key}  [{wf['name']}]  steps={len(steps)}  created={created_at[:10]}")

    conn.commit()
    conn.close()
    print(f"\n✅ Inserted {inserted} fake completed flows into {DB_PATH}")

    # Auto-create filesystem artifacts
    artifacts_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "create_fake_artifacts.py")
    if os.path.exists(artifacts_script):
        print("\n📁 Creating filesystem artifacts...")
        subprocess.run(["python3", artifacts_script], check=True)


if __name__ == "__main__":
    import sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 15
    print(f"🌱 Seeding {n} fake completed flows (JH-30000~42000)...\n")
    seed(n)

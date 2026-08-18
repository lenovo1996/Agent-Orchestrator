# Agent Orchestrator — implementation details

## Persistence contract

`workflows`, `agents`, and `workspaces` remain configuration tables. Migration 1 adds
`flows`, `flow_steps`, `flow_dependencies`, `orchestration_runs`, `step_attempts`,
`flow_commands`, `event_outbox`, `domain_events`, and `orchestrator_workers`.

SQLite starts with WAL, foreign keys, a five-second busy timeout, and migration/state
transactions use `BEGIN IMMEDIATE`. A flow revision is incremented by state-changing
commands and stale optimistic updates return a conflict.

Each command and the event that dispatches it are committed together. The worker
leases outbox rows and uses the command UUID as the Inngest event ID. Coordinator
claiming in SQLite makes duplicate delivery a no-op after Inngest's deduplication
window as well.

## Durable execution

`devteam-flow-coordinator` has no retries. It claims one command, records the Inngest
run, waits for dependencies in parallel, prepares a worktree if requested, and walks
the immutable step order. Stable durable IDs include the step name and business
cycle. The coordinator invokes `run-agent-step` with an eight-hour boundary.

`run-agent-step` has three technical retries. Host concurrency defaults to three;
attempts sharing a workspace key are serialized. Each attempt is recorded before a
foreground detached process group is launched. The local timeout defaults to six
hours, followed by SIGTERM, a ten-second grace period, and SIGKILL.

An explicit `## Status` marker in output is authoritative. `NEEDS_FIX` rewinds the
fix target and downstream steps with a new cycle, with a limit of five. `BLOCKED`
waits durably for resume for 30 days, then expires. Resume of an expired flow starts
a new coordinator generation from its SQLite checkpoint. Merge conflicts use the
same durable blocked wait but do not rerun completed agents.

Cancellation combines an Inngest cancel event with local process-group termination,
because a running foreground attempt must be preempted on the host. Worker startup
reconciles attempts by PID and finalized session metadata before any retry is allowed.

## External interfaces

REST endpoints:

```text
POST   /api/flows
GET    /api/flows
GET    /api/flows/:flowId
POST   /api/flows/:flowId/actions/retry
POST   /api/flows/:flowId/actions/resume
POST   /api/flows/:flowId/actions/stop
DELETE /api/flows/:flowId
GET    /api/orchestration/health
```

Flow reads come only from SQLite and include revisions and attempt summaries.
Artifact/session endpoints first resolve the flow and workspace from SQLite. The
server polls monotonic `domain_events`, broadcasts by workspace room, and clients
resync a full snapshot on reconnect.

The CLI and MCP server expose the same validated operations. No interface can patch
an arbitrary status or mutate execution state files.

## Operations

Self-hosted Inngest runs from `docker-compose.inngest.yml`, binds only to localhost,
and stores its embedded SQLite/queue snapshots on the `inngest-data` volume. The
Connect worker must run on the host that owns the workspaces and Codex home.

Required production environment:

```text
INNGEST_EVENT_KEY
INNGEST_SIGNING_KEY
INNGEST_DEV=0
INNGEST_BASE_URL=http://127.0.0.1:8288
INNGEST_GATEWAY_URL=ws://127.0.0.1:8289/v0/connect
```

No prompt, output body, token data, rollout, or absolute path is sent in Inngest
events or durable step results. Events contain command and flow IDs; functions load
all sensitive/business context from SQLite on the worker host.

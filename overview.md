# Agent Orchestrator — Inngest architecture

## Overview

The orchestrator runs each development flow as an Inngest durable function. SQLite
`workflows.db` is the business source of truth; Inngest owns durable execution
checkpoints. Flow artifact directories contain prompts, outputs, logs, native Codex
session metadata, and rollouts only.

There is no legacy watcher or file-backed state machine. Existing artifact-only flows
are intentionally not imported.

## Runtime components

```text
React dashboard ── REST / Socket.IO ── Express server
                                          │
                                          ├── workflows.db (business state + outbox)
                                          └── task-flows (artifacts only)

CLI / MCP ───────── shared command service ───────┘
                                                   │
Inngest start :8288/:8289 ◀── Connect worker ─────┤
                               │                   │
                               └── foreground agent wrapper / process groups
```

- `dashboard/orchestration`: migrations, repositories, state transitions, Inngest
  functions, worker, process supervisor, outbox, CLI, and worktree coordination.
- `dashboard/server`: query/action API, monotonic domain-event broadcasting, artifact
  tailing, and native Codex Session Viewer APIs. It never launches agents.
- `mcp`: seven flow tools backed by the same command/query service as REST and CLI.
- `scripts/agent` and `scripts/runtimes`: execute one foreground attempt, capture the
  native session, and return an exit code. They never project flow state.

## Start locally

```bash
cp .env.example .env
# Replace both Inngest keys with values from: openssl rand -hex 32
set -a; source .env; set +a

cd dashboard
npm install
npm run build
npm run dev:inngest
```

In separate terminals using the same environment:

```bash
cd dashboard && npm run dev:worker
cd dashboard && npm run dev
```

Production uses `npm start` for the dashboard and `npm run start:worker` for the
Connect worker. Readiness is exposed at `GET /api/orchestration/health` and requires
both Inngest and a fresh connected worker heartbeat.

## Flow commands

```bash
cd dashboard
npm run flow -- start --workflow default --workspace main --prompt "Fix the issue"
npm run flow -- list --workspace main
npm run flow -- get <flow-id>
npm run flow -- retry <flow-id> --step implementer
npm run flow -- resume <flow-id>
npm run flow -- stop <flow-id>
npm run flow -- delete <flow-id>
```

Start, retry, resume, stop, and delete are durable commands. Clients receive an
accepted/queued response and observe state changes through SQLite-backed snapshots
and monotonic Socket.IO events.

# Agent-Orchestrator — Project Overview

## Tổng quan

Agent-Orchestrator là hệ thống **multi-agent AI orchestration** tự động hóa quy trình phát triển phần mềm bằng cách phối hợp nhiều AI agent (Codex, Claude, Kiro) làm việc theo pipeline.

**Repo:** `git@github.com:lenovo1996/Agent-Orchestrator.git`

## Kiến trúc

```
┌─────────────────────────────────────────────────────────────┐
│                    Dashboard Frontend                        │
│          React + Vite + Zustand + TailwindCSS               │
│                   (port 5173 dev)                            │
└──────────────────────┬──────────────────────────────────────┘
                       │ Socket.IO + REST API
┌──────────────────────▼──────────────────────────────────────┐
│                    Dashboard Backend                         │
│              Express.js + Socket.IO + SQLite                 │
│                   (port 3001)                                │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│  Flows API  │ Workflows   │  Agents API │  Workspaces API   │
│   /api/flows│  /api/wf    │ /api/agents │ /api/workspaces   │
└──────┬──────┴──────┬──────┴──────┬──────┴───────────────────┘
       │             │             │
       ▼             ▼             ▼
┌──────────┐  ┌───────────┐  ┌──────────────┐   ┌────────────┐
│ task-flows│  │workflows.db│  │  team.json   │   │  prompts/  │
│  (files)  │  │  (SQLite) │  │  (agents)    │   │  (*.md)    │
└─────┬─────┘  └───────────┘  └──────────────┘   └────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│                    Scripts Engine                             │
│  orchestrator/ │ watcher/ │ worktree/ │ api/ │ utils/ │ agent│
└──────────────────────┬──────────────────────────────────────┘
                       │
      ┌────────────────┼────────────────┐
      ▼                ▼                ▼
┌──────────┐   ┌──────────┐   ┌──────────────┐
│  Codex   │   │  Claude  │   │  Kiro CLI    │
│  CLI     │   │  Code    │   │              │
└──────────┘   └──────────┘   └──────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    MCP Server                                │
│         Model Context Protocol (stdio) — 12 tools           │
│    Dùng cho tích hợp AI IDE (Cursor, Claude Desktop)        │
└─────────────────────────────────────────────────────────────┘
```

## Components chính

| Component | Path | Tech | Mô tả |
|-----------|------|------|-------|
| **Dashboard Frontend** | `dashboard/client/` | React, Vite, Zustand, TailwindCSS, shadcn/ui | Web UI quản lý & monitor |
| **Dashboard Backend** | `dashboard/server/` | Express.js, Socket.IO, SQLite, Chokidar | REST API + real-time events |
| **Shared Types** | `dashboard/shared/` | TypeScript | Type definitions chung |
| **MCP Server** | `mcp/` | TypeScript, MCP SDK | 12 tools cho AI IDE integration |
| **Scripts Engine** | `scripts/` | Node.js (CommonJS) | Core orchestration logic |
| **Prompts** | `prompts/` | Markdown | Agent instruction files |
| **Team Config** | `team.json` | JSON | Agent definitions + output config |

## Default Agent Pipeline (5 bước)

```
Clarifier → Architect → Planner → Implementer → Verifier
  (Phân tích)  (Thiết kế)  (Kế hoạch)  (Triển khai)  (Kiểm tra)
```

Mỗi agent chạy như một process riêng, đọc output của agent trước, viết output của mình, và watcher tự động spawn agent tiếp theo khi hoàn thành.

## Tech Stack

- **Runtime:** Node.js v24.16.0 (arm64)
- **Frontend:** React 19, Vite, TypeScript, Zustand, TailwindCSS, Socket.IO Client
- **Backend:** Express.js, Socket.IO, SQLite3, Chokidar (fs watcher)
- **MCP:** @modelcontextprotocol/sdk (stdio transport)
- **Agent Runtimes:** Codex CLI, Claude Code, Kiro CLI, generic shell
- **Database:** SQLite (`workflows.db`) cho workflows, agents, workspaces
- **Process Management:** PID-based spawn guards, process group signaling

## Quick Start

```bash
# Build MCP server
cd mcp && npm run build

# Build & run Dashboard (production)
cd dashboard && npm run build && NODE_ENV=production node server/dist/index.js

# Dev mode
cd dashboard && npm run dev  # Frontend:5173 + Backend:3001

# Start a workflow via CLI
node scripts/orchestrator/index.js start "Fix header color" --prompt "Change bg to blue"

# Start with Jira key
node scripts/orchestrator/index.js start JH-12345
```

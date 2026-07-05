# Agent-Orchestrator — Detailed Features

## Mục lục

1. [Orchestrator Engine](#1-orchestrator-engine)
2. [Watcher System](#2-watcher-system)
3. [Agent Wrapper & Multi-Runtime](#3-agent-wrapper--multi-runtime)
4. [Dashboard Backend (REST API + WebSocket)](#4-dashboard-backend)
5. [Dashboard Frontend (React UI)](#5-dashboard-frontend-react-ui)
6. [MCP Server (AI IDE Integration)](#6-mcp-server)
7. [Custom Workflows & Agent CRUD](#7-custom-workflows--agent-crud)
8. [Worktree Parallel Execution](#8-worktree-parallel-execution)
9. [Memory Tree System](#9-memory-tree-system)
10. [Token Tracking](#10-token-tracking)
11. [Process Management & PID Guards](#11-process-management--pid-guards)
12. [Retry & Recovery System](#12-retry--recovery-system)
13. [Workspace Support](#13-workspace-support)
14. [Dependency Management](#14-dependency-management)
15. [File Structure](#15-file-structure)

---

## 1. Orchestrator Engine

**Path:** `scripts/orchestrator/index.js`

Core engine điều khiển toàn bộ lifecycle của workflow.

### 1.1 Start Workflow

```bash
node scripts/orchestrator/index.js start [options] <jira-key> [custom-prompt]
node scripts/orchestrator/index.js start --prompt <custom-prompt>
```

**Options:**
- `--workflow <id>` — Sử dụng custom workflow definition (thay vì default 5 steps)
- `--workspace-name <name>` — Gán flow vào workspace cụ thể
- `--workspace-dir <path>` — Chỉ định workspace directory
- `--depends-on <flow1,flow2>` — Flow dependencies (comma-separated)

**Quy trình:**
1. Tạo flow ID theo format: `flow_YYYYMMDDHHmmss_<jira-key>`
2. Tạo thư mục work directory với cấu trúc:
   ```
   task-flows/[workspace/]<flowId>/
   ├── workflow.json        ← state machine
   ├── output/              ← agent output files (*.md)
   ├── logs/                ← agent log files (*.log)
   ├── prompts/             ← generated prompts
   └── scripts/             ← flow-specific scripts
   ```
3. Ghi `workflow.json` với initial state
4. Khởi tạo Memory Tree (`initTree`)
5. Auto-spawn agent đầu tiên (clarifier) qua `api/spawn.js`

### 1.2 Workflow State Machine

`workflow.json` quản lý state của toàn bộ flow:

```json
{
  "flowId": "flow_20260624140000_JH-123",
  "jiraKey": "JH-123",
  "customPrompt": "...",
  "workflowId": "",
  "stepOrder": ["clarifier", "architect", "planner", "implementer", "verifier"],
  "status": "running",
  "currentStep": "clarifier",
  "startedAt": "2026-06-24T07:00:00Z",
  "steps": {
    "clarifier": "done",
    "architect": "running",
    "planner": "waiting",
    "implementer": "waiting",
    "verifier": "waiting"
  },
  "retries": {},
  "needsFixCount": {},
  "blockedStep": null,
  "blockedReason": null,
  "lastRetryAt": null
}
```

**Status values cho flow:** `running`, `completed`, `failed`, `blocked`, `stopped`, `pending_dependencies`

**Status values cho step:** `waiting`, `pending`, `running`, `done`, `failed`, `blocked`, `retrying`, `cancelled`, `unknown`

### 1.3 Workflow Manager

**Path:** `scripts/orchestrator/workflow-manager.js`

Module quản lý workflow state:
- `loadWorkflow(flowId)` — Đọc workflow.json
- `saveWorkflow(flowId, workflow)` — Ghi workflow.json
- `getWorkflowState(flowId)` — Lấy full state bao gồm outputs, statuses
- `updateWorkflowState(flowId, updates)` — Patch state với dot-notation keys (`steps.implementer`, `retries.clarifier`, etc.)
- `getSteps(workflow)` — Lấy step order (custom hoặc default)
- `resolveWorkDir(flowId)` — Resolve work directory (hỗ trợ flat + workspace structure)
- `parseOutputStatus(filePath)` — Parse `## Status` marker từ output file

### 1.4 CLI Commands

```bash
# Start workflow
orchestrator.js start <jira-key> [prompt]
orchestrator.js start --prompt <prompt>

# Resume từ step cụ thể
orchestrator.js resume <flow-id> <step>

# Retry step
orchestrator.js retry <flow-id> <step> [--clear-output]

# Stop workflow
orchestrator.js stop <flow-id>

# Check status
orchestrator.js status <flow-id>

# Parallel scheduling
orchestrator.js parallel schedule <flow-id> <repo>
orchestrator.js parallel auto <flow-id>
orchestrator.js parallel status
```

---

## 2. Watcher System

**Path:** `scripts/watcher/index.js`

Watcher chạy như process riêng cho mỗi flow, polling `workflow.json` mỗi 5 giây để phát hiện thay đổi trạng thái.

### 2.1 Single Flow Watcher

```bash
watcher.js <flow-id> [interval-ms]
```

**Vòng lặp chính:**
1. Đọc `workflow.json` + parse output status từ mỗi step
2. So sánh với `lastStatuses` (cache) để phát hiện thay đổi
3. Xử lý theo status mới:

| Status | Hành động |
|--------|-----------|
| `DONE` | Mark step done → spawn next step (sau 2s delay) → nếu là step cuối → mark flow completed |
| `NEEDS_FIX` | Lưu feedback → clear implementer output → re-spawn implementer (sau 3s) |
| `FAILED` | Auto-retry nếu retryCount < MAX_RETRIES (1 lần) |
| `BLOCKED` | Dừng workflow, chờ human intervention |
| `UNKNOWN` | Dừng workflow, yêu cầu Status marker rõ ràng |

### 2.2 NEEDS_FIX Loop

Khi verifier đánh giá `NEEDS_FIX`:
1. Lưu verifier output → `feedback-from-verifier.md`
2. Clear `implementation.md`
3. Reset các bước downstream
4. Re-spawn implementer với feedback context
5. Giới hạn tối đa 5 iterations (`MAX_NEEDS_FIX`), sau đó block workflow
6. Dùng SHA-256 signature để tránh duplicate handling cùng một output

### 2.3 Parallel Watcher

```bash
watcher.js --parallel [interval-ms]
```

Giám sát nhiều flow cùng lúc qua `parallel-status.json`. Xử lý NEEDS_FIX flow-isolated (mỗi flow xử lý riêng). Khi tất cả flow hoàn thành → emit summary với pass/fail counts, elapsed time, và total tokens.

### 2.4 Cache Invalidation

Watcher phát hiện external retry bằng cách theo dõi `lastRetryAt` timestamp. Khi timestamp thay đổi → invalidate status cache → skip tick hiện tại → re-read ở tick tiếp theo.

---

## 3. Agent Wrapper & Multi-Runtime

### 3.1 Universal Wrapper

**Path:** `scripts/agent/wrapper.sh`

Wrapper bash script dispatching đến runtime-specific scripts:

```bash
wrapper.sh <flow-id> <step> <work-dir> <prompt-file> [worktree-path]
```

**Features:**
- Tự động resolve runtime script từ `$AGENT_RUNTIME` env (default: `codex`)
- Log header với metadata (flow, step, model, reasoning, worktree)
- **Crash Sentinel:** Nếu runtime exit non-zero mà không có output → tự động ghi `## Status FAILED`
- **Signal Propagation:** SIGTERM/SIGINT → kill toàn bộ process group
- **PID Cleanup:** Xóa `.pid.<step>` file khi kết thúc
- **Auto-update workflow.json:** Parse exit code + output status → update state → auto-spawn next step

### 3.2 Runtimes

**Path:** `scripts/runtimes/`

| Runtime | Script | CLI Tool | Notes |
|---------|--------|----------|-------|
| **codex** | `codex.sh` | Codex CLI | Default, sandbox mode |
| **claude** | `claude.sh` | Claude Code | Anthropic's CLI |
| **kiro** | `kiro.sh` | Kiro CLI | Credits-based |
| **generic** | `generic.sh` | Any command | Custom `$AGENT_COMMAND` |

**Env vars truyền từ spawn.js → wrapper → runtime:**
- `AGENT_RUNTIME` — Runtime name
- `AGENT_MODEL` — Model override
- `AGENT_REASONING` — Reasoning effort level
- `AGENT_COMMAND` — Custom command (generic runtime)
- `AGENT_PERMISSION` — Permission mode
- `AGENT_MAX_TURNS` — Max conversation turns

### 3.3 Spawn via Gateway

**Path:** `scripts/api/spawn.js`

Entry point để spawn agents:

1. Đọc `workflow.json` + `team.json` để lấy agent config
2. Xây dựng task prompt bao gồm:
   - Instructions reference (`prompts/<step>.md`)
   - Jira key, repo root, work dir context
   - Active context reference (Memory Tree)
   - Previous outputs (chỉ reference, ưu tiên active-context)
   - Verifier feedback (khi re-run implementer)
   - Custom prompt
3. Ghi prompt vào `prompts/<step>-prompt.txt`
4. Spawn `wrapper.sh` như detached process
5. Ghi PID file cho duplicate prevention

---

## 4. Dashboard Backend

**Path:** `dashboard/server/`

### 4.1 Architecture

```
Express.js App
├── REST API (/api/*)
│   ├── /api/flows          — Flow CRUD + start/stop/retry
│   ├── /api/workflows      — Custom workflow definitions
│   ├── /api/agents         — Agent CRUD
│   ├── /api/workspaces     — Workspace CRUD
│   └── /api/git/status     — Git status cho repos
├── Socket.IO Server
│   ├── state:init          — Initial state on connect
│   ├── state:resync        — Full state on reconnect
│   ├── flow:updated        — Workflow state change
│   ├── log:append          — New log lines (room-based)
│   ├── output:created      — New output file
│   ├── output:updated      — Output file modified
│   ├── workspace:select    — Switch workspace context
│   ├── log:subscribe       — Join log room
│   └── log:unsubscribe     — Leave log room
└── Filesystem Watcher (Chokidar)
    ├── workflow.json → workflow-changed event
    ├── logs/*.log → log-appended event
    └── output/*.md → output-created/updated events
```

### 4.2 REST API Endpoints

**Flows:**
| Method | Endpoint | Mô tả |
|--------|----------|--------|
| GET | `/api/flows` | List flows (optional `?workspaceId=`) |
| GET | `/api/flows/:flowId` | Get flow detail |
| GET | `/api/flows/:flowId/logs/:step` | Get log lines (last 3000) |
| GET | `/api/flows/:flowId/output/:step` | Get output content + metadata |
| GET | `/api/flows/:flowId/tokens` | Get token counts per step |
| POST | `/api/flows/start` | Start new workflow |
| POST | `/api/flows/:flowId/retry` | Retry step (with optional prompt) |
| POST | `/api/flows/:flowId/stop` | Stop workflow |
| DELETE | `/api/flows/:flowId` | Delete flow (optional deleteMemory) |

**Workflows:**
| Method | Endpoint | Mô tả |
|--------|----------|--------|
| GET | `/api/workflows` | List custom workflows |
| POST | `/api/workflows` | Create workflow |
| PUT | `/api/workflows/:id` | Update workflow |
| DELETE | `/api/workflows/:id` | Delete workflow |

**Agents:**
| Method | Endpoint | Mô tả |
|--------|----------|--------|
| GET | `/api/agents` | List agents |
| POST | `/api/agents` | Create agent |
| PUT | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent |

**Workspaces:**
| Method | Endpoint | Mô tả |
|--------|----------|--------|
| GET | `/api/workspaces` | List workspaces |
| POST | `/api/workspaces` | Create workspace |
| PUT | `/api/workspaces/:id` | Update workspace |
| DELETE | `/api/workspaces/:id` | Delete workspace |

**Git:**
| Method | Endpoint | Mô tả |
|--------|----------|--------|
| GET | `/api/git/status` | Git status cho tất cả jinjer_* repos |

### 4.3 Filesystem Watcher

**Path:** `dashboard/server/src/watcher.ts`

Sử dụng Chokidar để monitor `task-flows/` directory:
- Detect thay đổi `workflow.json` → emit `workflow-changed`
- Detect log appended → incremental read (track byte offset) → emit `log-appended`
- Detect output file created/modified → emit `output-created` / `output-updated`
- Hỗ trợ cả flat structure (`flowId/`) và workspace structure (`workspace/flowId/`)

### 4.4 Configuration

**Path:** `dashboard/server/src/config.ts`

- Auto-detect repo root bằng cách walk up từ server dir, tìm `team.json` + `scripts/`
- Env vars: `DASHBOARD_PORT` (3001), `DASHBOARD_HOST` (127.0.0.1), `DASHBOARD_CORS_ORIGIN` (*)
- Tự động tạo `task-flows/` directory nếu chưa tồn tại

### 4.5 Database

**Path:** `dashboard/server/src/db.ts` + `workflows.db` (SQLite)

3 tables:
- `workflows` — Custom workflow definitions (id, name, description, steps)
- `agents` — Agent definitions (id, role, objective, model, thinking, tools, outputs, runtime, instructions)
- `workspaces` — Workspace definitions (id, name, path)

Auto-initialize agents từ `team.json` nếu table trống.

---

## 5. Dashboard Frontend (React UI)

**Path:** `dashboard/client/`

### 5.1 Tech Stack

- React 19 + TypeScript
- Vite (dev server + build)
- Zustand (state management)
- TailwindCSS + shadcn/ui components
- Socket.IO Client (real-time)
- Lucide React (icons)

### 5.2 Pages & Components

**Layout:**
- `Header` — Top bar với theme toggle, menu button
- `Sidebar` — Left panel với navigation tabs (Tasks/Workflows/Agents), flow list, "Start New Task" button
- `PanelFrame` — Resizable panel container với collapse/expand controls

**Tasks View (Default):**
- `FlowList` — Danh sách flow cards trong sidebar
- `FlowCard` — Compact flow summary (status, progress, jira key)
- `AgentPanel` — Pipeline visualization (5 step indicators)
- `StepIndicator` — Trạng thái từng agent step (icon, status badge)
- `FlowActions` — Action buttons (retry, stop, start)
- `LogViewer` — Real-time log streaming với auto-scroll
- `LogBlockView` — Parsed log blocks (structured view)
- `LogLine` — Single log line renderer
- `OutputPreview` — Markdown output preview với metadata

**Dialogs:**
- `NewTaskDialog` — Form tạo workflow mới (workflow selector, jira key, custom prompt, depends-on)
- `DeleteFlowDialog` — Confirm dialog xóa flow (with delete memory option)
- `NewWorkspaceDialog` — Form tạo workspace mới

**Pages:**
- `WorkflowsPage` — CRUD quản lý custom workflows
- `AgentsPage` — CRUD quản lý agent definitions

### 5.3 State Management

**Store:** `use-dashboard-store.ts` (Zustand)

State slices:
- **Connection:** `connected` flag
- **Workspaces:** `workspaces[]`, `selectedWorkspaceId`
- **Flows:** `flows{}`, `selectedFlowId`
- **Agents:** `agents{}`
- **Selection:** `selectedStep`
- **Logs:** `logBuffers{}` (per flow+step, max 2000 lines, auto-scroll toggle)

### 5.4 Real-time Events

**Hook:** `use-socket-events.ts`

Socket.IO events handled:
- `state:init` — Initial state load on connect
- `flow:updated` — Update single flow in store
- `log:append` — Append lines to log buffer
- `output:created` / `output:updated` — Refresh output preview

### 5.5 UI Features

- **Dark/Light theme** — Persisted in localStorage
- **Responsive design** — Mobile sidebar overlay, desktop persistent
- **Resizable panels** — Drag to resize pipeline height, log/output width ratio
- **Panel collapse/expand** — Collapse any panel, expand to fullscreen
- **Workspace switching** — Switch between workspaces, state persisted in localStorage

---

## 6. MCP Server

**Path:** `mcp/`

### 6.1 Overview

Model Context Protocol server chạy qua stdio, expose 12 tools cho AI IDE integration (Cursor, Claude Desktop, etc.).

### 6.2 Tools

| Tool | Mô tả |
|------|--------|
| `get_task_list` | List tất cả tracked tasks (flows), filter theo workspace |
| `get_task_status` | Chi tiết JSON status cho một flow |
| `update_task_status` | Patch workflow.json trực tiếp |
| `create_task` | Bootstrap workflow mới (jiraKey hoặc customPrompt) |
| `delete_task` | Stop và xóa flow + history |
| `retry_step_with_prompt_update` | Retry step cụ thể với optional new prompt |
| `get_workflows` | List hoặc get custom workflow definitions |
| `create_workflow` | Tạo custom workflow definition |
| `update_workflow` | Update custom workflow definition |
| `get_agents` | List hoặc get agent definitions |
| `create_agent` | Tạo agent mới (sync DB + team.json + prompts) |
| `update_agent` | Update agent (sync DB + team.json + prompts) |
| `get_help` | Help guide cho tất cả tools |

### 6.3 Agent Lifecycle trong MCP

Khi tạo/cập nhật agent qua MCP:
1. Ghi vào `workflows.db` (SQLite)
2. Sync sang `team.json` (file-based config)
3. Sync prompts sang `prompts/<agent-id>.md`
4. Tự động inject thêm markers vào prompt:
   - `## MANDATORY: Read Project Context First` — Hướng dẫn đọc context files
   - `## IMPORTANT: Status Marker` — Yêu cầu `## Status DONE|BLOCKED|FAILED`
   - `## Input` — Reference outputs từ steps trước
   - `## Output Format` — Format output file

---

## 7. Custom Workflows & Agent CRUD

### 7.1 Custom Workflows

Thay vì chạy default 5 steps (clarifier→architect→planner→implementer→verifier), user có thể tạo custom workflow với bất kỳ combination agents nào.

**Storage:** SQLite `workflows` table

**Example:**
```json
{
  "id": "analysis-only",
  "name": "Analysis Only",
  "description": "Run analyzer and planner only",
  "steps": ["clarifier", "architect", "planner"]
}
```

**Usage:** `orchestrator.js start --workflow analysis-only JH-123`

### 7.2 Agent CRUD

**9 Agents hiện tại:**

| Agent | Role | Objective |
|-------|------|-----------|
| `clarifier` | Spec Clarifier | Clarify spec, tìm open questions |
| `architect` | Game Architect | Thiết kế hệ thống |
| `planner` | Task Planner | Break feature thành task nhỏ |
| `implementer` | Godot Developer | Implement feature với GDScript |
| `verifier` | Verifier (Legacy) | Legacy verification |
| `pm` | PM | Phân tích requirement, tạo task |
| `reviewer` | Code Reviewer | Review code quality |
| `qa` | QA Tester | Test feature, tạo test cases |
| `test` | test | Test agent |

**Sync mechanism:** Khi update agent qua Dashboard/MCP → SQLite → sync `team.json` + `prompts/<id>.md`

---

## 8. Worktree Parallel Execution

### 8.1 Parallel Scheduler

**Path:** `scripts/worktree/parallel-scheduler.js`

Quản lý task scheduling với configurable concurrency:
- FIFO queue ordering
- Dependency resolution (task chỉ chạy khi dependencies hoàn thành)
- State persistence qua `parallel-status.json`
- Auto-recover state trên startup

**Config trong `team.json`:**
```json
{
  "worktree": {
    "enabled": true,
    "maxConcurrency": 3,
    "repos": {
      "jinjer_hr_core": "/path/to/repo",
      "jinjer_hr_auth": "/path/to/repo"
    },
    "defaultRepos": ["jinjer_hr_core"]
  }
}
```

### 8.2 Worktree Manager

**Path:** `scripts/worktree/worktree-manager.js`

Git worktree lifecycle management:
- `create(flowId, step, repoPath, baseBranch)` — Tạo worktree mới (check dirty repo trước)
- `remove(flowId)` — Xóa worktree
- `merge(flowId, targetBranch, dryRun)` — Merge branch vào target (--no-ff, conflict detection)
- `cleanup()` — Cleanup completed/failed worktrees, delete merged branches

**Branch naming:** `worktree/{flowId}/{step}`

### 8.3 Repo Detector

**Path:** `scripts/worktree/repo-detector.js`

Tự động detect impacted repos từ `architecture.md` output:
- Parse section "## Impacted Repos"
- Extract repo names từ file paths
- Validate against known repos
- Fallback to `defaultRepos` config

### 8.4 Branch Resolver

**Path:** `scripts/worktree/branch-resolver.js`

Simple resolver: `worktree/{flowId}/{step}`

---

## 9. Memory Tree System

**Path:** `scripts/utils/memory-tree.js`

### 9.1 Overview

Hierarchical task memory system giúp agents chia sẻ context giữa các steps. Mỗi flow có một tree structure lưu compact state.

### 9.2 File Structure

```
.tasks/<TASK_ID>/
├── meta.json                    ← List of flows, latest flow pointer
├── active-context.md            ← Generated compact context
└── flows/
    └── <flow_id>/
        ├── tree.json            ← Per-flow tree (nodes per step)
        └── archive/
            ├── clarifier.json   ← Full parsed data
            ├── architect.json
            └── ...
```

### 9.3 Core Functions

- `initTree(flowId)` — Khởi tạo tree + meta.json, migrate legacy structure nếu cần
- `updateTree(flowId, step)` — Parse output file → extract status/summary/key_facts/decisions → update node
- `generateActiveContext(flowId, targetStep)` — Generate `active-context.md` cho agent tiếp theo
- `parseOutputFile(filePath)` — Parse markdown output: extract sections, key facts, decisions

### 9.4 Active Context Generation

`active-context.md` được generate trước mỗi step spawn, chứa:
- **Prior Flows context** — Key decisions/facts từ flows trước (cùng task)
- **Problem** — Từ clarifier output
- **Architecture** — Từ architect output
- **Plan** — Từ planner output
- **Implementation** — Từ implementer output
- **Verification** — Từ verifier output
- **Pipeline Progress** — Status icon cho mỗi step
- **Token Usage** — Total tokens consumed

### 9.5 Legacy Migration

Tự động migrate từ flat structure (`.tasks/<TASK_ID>/tree.json`) sang multi-flow structure (`.tasks/<TASK_ID>/flows/<flow_id>/tree.json`).

---

## 10. Token Tracking

**Path:** `scripts/utils/token-tracker.js`

### 10.1 Supported Formats

| Runtime | Format | Example |
|---------|--------|---------|
| Codex | `tokens used\n<number>` | `tokens used\n250,964` |
| Claude Code (JSON) | `{"usage":{"input_tokens":N,"output_tokens":N}}` | JSON line |
| Claude Code (stream) | `{"type":"result","usage":{...}}` | Stream JSON |
| Generic | `Total tokens: <number>` | `Total tokens: 5000` |
| Kiro | `▸ Credits: <number>` | `▸ Credits: 25.5` (×10000 ≈ tokens) |
| Kiro alt | `Token usage: <number>` | `Token usage: 100000` |

### 10.2 Number Parsing

Hỗ trợ cả comma-separated (`250,964`) và dot-separated (`139.109`) thousands separators. Auto-detect dựa trên pattern `\d{1,3}(\.\d{3})+`.

### 10.3 CLI

```bash
token-tracker.js flow <flow-id>    # Token usage per step
token-tracker.js step <flow-id> <step>  # Token cho step cụ thể
token-tracker.js all               # Grand total cho tất cả flows
```

---

## 11. Process Management & PID Guards

**Path:** `scripts/utils/process-manager.js` + inline trong watcher/spawn

### 11.1 PID File System

Mỗi step đang chạy có file `.pid.<step>` trong work directory:

```json
{"pid": 12345, "startedAt": "2026-06-24T07:00:00Z"}
```

### 11.2 Guards

- **Duplicate Spawn Guard** — Kiểm tra PID file trước khi spawn; nếu PID alive → skip
- **Sequential Guard** — Đảm bảo step trước đã hoàn thành trước khi spawn step sau
- **Stale PID Cleanup** — Nếu PID dead → xóa file → cho phép spawn mới
- **Process Group Kill** — Kill entire process group (negative PID) để cleanup child processes

### 11.3 Kill Hierarchy

Khi stop workflow:
1. Kill agent PIDs (process group) từ `.pid.<step>` files
2. Kill orphan processes (`pgrep -f "codex|claude|kiro.*flowId"`)
3. Kill watcher process
4. Kill dashboard process
5. Update workflow status → `stopped`

---

## 12. Retry & Recovery System

**Path:** `scripts/orchestrator/retry-flow.js`

### 12.1 Auto-Retry

Watcher tự động retry 1 lần khi step FAILED:
1. Increment retry count
2. Clear failed output
3. Re-spawn step sau 3s delay

### 12.2 Manual Retry

```bash
orchestrator.js retry <flow-id> <step> [--clear-output]
# Hoặc qua Dashboard UI / MCP tool
```

`prepareRetry()` thực hiện:
1. Validate step exists
2. Update prompt nếu được cung cấp
3. Reset step → `running`
4. Reset downstream steps → `waiting`
5. Reset retry counter + needsFixCount
6. Clear blocked state
7. Backup + clear output files (optional)
8. Atomic write (tmp → rename)

### 12.3 Staleness Detection

`markStaleAfterRetry()` — Kiểm tra `lastRetryAt` timestamp để invalidate watcher cache. Threshold: 3 năm (generous window).

---

## 13. Workspace Support

### 13.1 Workspace Organization

Workspaces cho phép tổ chức flows theo project/context:

```
task-flows/
├── workspace-a/
│   ├── flow_001/
│   └── flow_002/
├── workspace-b/
│   └── flow_003/
└── flow_004/  (no workspace)
```

### 13.2 Workspace Management

- CRUD qua Dashboard UI hoặc REST API
- Workspace selection persisted trong localStorage
- Socket.IO `workspace:select` event để filter flows
- Flow resolution tự động search trong workspace directories

---

## 14. Dependency Management

### 14.1 Workflow Dependencies

Flow có thể declare dependencies qua `--depends-on`:

```bash
orchestrator.js start --depends-on flow_001,flow_002 "Implement feature X"
```

### 14.2 Behavior

- Flow bắt đầu với status `pending_dependencies`
- Watcher monitor dependencies
- Khi tất cả dependencies completed → auto-resume flow
- `checkAndResumeDependentWorkflows()` được gọi khi flow hoàn thành

---

## 15. File Structure

```
Agent-Orchestrator/
├── team.json                           ← Agent definitions + output config
├── workflows.db                        ← SQLite: workflows, agents, workspaces
├── overview.md                         ← Project overview
├── detailed.md                         ← This file
│
├── dashboard/                          ← Web Dashboard
│   ├── package.json                    ← Build: npm run build
│   ├── client/                         ← React Frontend
│   │   ├── src/
│   │   │   ├── App.tsx                 ← Main app layout
│   │   │   ├── components/
│   │   │   │   ├── agent/              ← AgentPanel, FlowActions
│   │   │   │   ├── agents/             ← AgentsPage (CRUD)
│   │   │   │   ├── flow/               ← FlowCard, FlowList, NewTaskDialog, DeleteFlowDialog, StepIndicator
│   │   │   │   ├── layout/             ← Header, Sidebar, PanelFrame, NewWorkspaceDialog
│   │   │   │   ├── log/                ← LogViewer, LogBlockView, LogLine
│   │   │   │   ├── output/             ← OutputPreview
│   │   │   │   ├── ui/                 ← shadcn/ui components
│   │   │   │   └── workflows/          ← WorkflowsPage (CRUD)
│   │   │   ├── hooks/                  ← use-auto-scroll, use-panel-resize, use-socket-events
│   │   │   ├── lib/                    ← constants, format, log-parser, socket, utils
│   │   │   └── store/                  ← use-dashboard-store (Zustand)
│   │   └── package.json
│   ├── server/                         ← Express Backend
│   │   └── src/
│   │       ├── index.ts                ← Server entry point
│   │       ├── config.ts               ← Configuration
│   │       ├── db.ts                   ← SQLite connection
│   │       ├── events.ts               ← Socket.IO event handlers
│   │       ├── flow-reader.ts          ← Read workflow.json + outputs
│   │       ├── log-tailer.ts           ← Incremental log reading
│   │       ├── watcher.ts              ← Chokidar filesystem watcher
│   │       ├── routes/                 ← REST API routes
│   │       │   ├── flows.ts            ← Flow endpoints
│   │       │   ├── workflows.ts        ← Workflow CRUD
│   │       │   ├── agents.ts           ← Agent CRUD
│   │       │   └── workspaces.ts       ← Workspace CRUD
│   │       └── services/
│   │           ├── flow-service.ts     ← Flow start logic
│   │           └── agent-service.ts    ← Agent sync to filesystem
│   └── shared/                         ← Shared TypeScript types
│       └── src/
│           ├── index.ts                ← Core types (WorkflowState, AgentConfig, etc.)
│           └── workspaces.ts           ← Workspace types
│
├── mcp/                                ← MCP Server
│   ├── src/index.ts                    ← 12 MCP tools
│   └── package.json
│
├── scripts/                            ← Core Orchestration Engine
│   ├── orchestrator/
│   │   ├── index.js                    ← Main orchestrator CLI
│   │   ├── workflow-manager.js         ← Workflow state management
│   │   └── retry-flow.js              ← Retry logic
│   ├── watcher/
│   │   └── index.js                    ← Watcher (single + parallel)
│   ├── agent/
│   │   └── wrapper.sh                  ← Universal agent wrapper
│   ├── runtimes/
│   │   ├── codex.sh                    ← Codex CLI runtime
│   │   ├── claude.sh                   ← Claude Code runtime
│   │   ├── kiro.sh                     ← Kiro CLI runtime
│   │   └── generic.sh                  ← Generic command runtime
│   ├── api/
│   │   └── spawn.js                    ← Agent spawn entry point
│   ├── worktree/
│   │   ├── parallel-scheduler.js       ← Parallel task scheduler
│   │   ├── worktree-manager.js         ← Git worktree lifecycle
│   │   ├── branch-resolver.js          ← Branch naming
│   │   └── repo-detector.js            ← Detect impacted repos
│   └── utils/
│       ├── memory-tree.js              ← Hierarchical task memory
│       ├── token-tracker.js            ← Token usage parsing
│       └── process-manager.js          ← PID management
│
├── prompts/                            ← Agent Instructions
│   ├── clarifier.md
│   ├── architect.md
│   ├── planner.md
│   ├── implementer.md
│   ├── verifier.md
│   ├── pm.md
│   ├── reviewer.md
│   ├── qa.md
│   └── test.md
│
├── task-flows/                         ← Runtime output (generated)
│   └── [workspace/]<flowId>/
│       ├── workflow.json
│       ├── output/*.md
│       ├── logs/*.log
│       ├── prompts/*-prompt.txt
│       └── .pid.<step>
│
└── .tasks/                             ← Memory tree (generated)
    └── <TASK_ID>/
        ├── meta.json
        ├── active-context.md
        └── flows/<flowId>/
            ├── tree.json
            └── archive/*.json
```

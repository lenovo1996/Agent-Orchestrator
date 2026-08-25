# DevTeam Dashboard

Dashboard React/Express cho Agent Orchestrator sử dụng SQLite và Inngest self-hosted.
`workflows.db` là nguồn dữ liệu chính cho flow, step, attempt, command và business state;
Inngest lưu durable execution state trong Docker volume riêng.

## Kiến trúc khi chạy local

Development cần ba nhóm process độc lập:

| Process | Lệnh | Chức năng | Địa chỉ mặc định |
| --- | --- | --- | --- |
| Inngest server | `npm run dev:inngest` | Durable workflow engine chạy trong Docker | HTTP `127.0.0.1:8288`, Connect `127.0.0.1:8289` |
| Orchestration worker | `npm run dev:worker` | Kết nối Inngest, dispatch outbox và chạy agent | Health `127.0.0.1:3011` |
| Dashboard | `npm run dev` | Express API, Socket.IO và Vite frontend | API `127.0.0.1:3001`, UI `127.0.0.1:5173` |

`dev:inngest` là convenience script chạy:

```bash
docker compose -f ../docker-compose.inngest.yml up
```

Tên script có chữ `dev`, nhưng container thực tế chạy `inngest start` với
`INNGEST_DEV=0`, không chạy `inngest dev`. Image hiện được pin tại
`inngest/inngest:v1.39.0`.

Dashboard server không spawn agent. Chỉ worker được phép chạy agent runtime và cập
nhật orchestration state qua shared domain service.

## Yêu cầu hệ thống

- Linux hoặc macOS với `bash`, Git và OpenSSL.
- Node.js `>=22.15.0`. Phiên bản này cần cho native SQLite và đọc Codex rollout
  `.jsonl.zst` đã hoàn tất.
- npm đi cùng Node.js.
- Docker Engine hoặc Docker Desktop đang chạy.
- Docker Compose v2, sử dụng được bằng subcommand `docker compose`.
- CLI của agent runtime được khai báo trong database/team configuration và đã được
  authenticate. Runtime mặc định là Codex CLI; các runtime khác được mô tả tại
  `../scripts/runtimes/README.md`.
- Workspace được cấu hình phải tồn tại trên cùng host với worker. Worker cần quyền
  đọc/ghi workspace, `.dev-team/task-flows`, `workflows.db` và Codex home.

Kiểm tra nhanh:

```bash
node --version
npm --version
docker --version
docker compose version
git --version
openssl version
```

## Cài đặt lần đầu

Các lệnh dưới đây giả sử terminal đang đứng tại thư mục `.dev-team`.

### 1. Tạo cấu hình môi trường

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Copy hai giá trị ngẫu nhiên vừa tạo vào `.env`:

```dotenv
INNGEST_EVENT_KEY=<random-value-thu-nhat>
INNGEST_SIGNING_KEY=<random-value-thu-hai>
INNGEST_DEV=0
INNGEST_BASE_URL=http://127.0.0.1:8288
INNGEST_GATEWAY_URL=ws://127.0.0.1:8289/v0/connect

DEVTEAM_AGENT_CONCURRENCY=3
DEVTEAM_AGENT_TIMEOUT=6h
DEVTEAM_BLOCKED_TTL=30d
HOST_UID=<output-cua-id-u>
HOST_GID=<output-cua-id-g>
```

Lấy đúng UID/GID của user đang chạy Codex app-server bằng `id -u` và `id -g`.
Docker Compose dùng hai giá trị này cho `server` và `worker` để file trong
`task-flows`/`.worktrees` không bị tạo dưới quyền `root`.

Không commit `.env`. Inngest container, worker, dashboard server và CLI phải dùng
cùng `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY`.

Các biến tùy chọn thường dùng:

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `DEVTEAM_RUNNER_ID` | hostname | ID duy nhất của worker host |
| `DEVTEAM_DB_PATH` | `.dev-team/workflows.db` | SQLite business database; nên dùng absolute path khi override |
| `DEVTEAM_WORKSPACE_ROOT` | thư mục cha của `.dev-team` | Shared root chứa các workspace hợp lệ |
| `DEVTEAM_TASK_FLOWS_DIR` | `.dev-team/task-flows` | Nơi lưu prompt, output, logs và session metadata |
| `DEVTEAM_WORKTREES_DIR` | `.dev-team/.worktrees` | Nơi lưu Git worktree với absolute path dùng chung giữa host/container |
| `DEVTEAM_AGENT_CONCURRENCY` | `3` | Số agent tối đa trên worker host; isolated worktree có thể dùng capacity song song |
| `DEVTEAM_AGENT_TIMEOUT` | `6h` | Timeout local cho một agent process |
| `DEVTEAM_BLOCKED_TTL` | `30d` | Thời gian chờ resume trước khi flow thành `expired` |
| `DEVTEAM_WORKER_HEALTH_PORT` | `3011` | Health port của Connect worker |
| `DEVTEAM_WORKER_HEALTH_URL` | `http://127.0.0.1:3011` | URL dashboard server dùng để kiểm tra trực tiếp Connect worker |
| `DASHBOARD_PORT` | `3001` | API/Socket.IO port |
| `DASHBOARD_HOST` | `127.0.0.1` | Interface của dashboard server |
| `DASHBOARD_CORS_ORIGIN` | `*` | CORS origin trong development |
| `DASHBOARD_CODEX_HOME` | `$CODEX_HOME` hoặc `~/.codex` | Native Codex session/rollout directory |
| `DASHBOARD_SESSION_VIEWER_ENABLED` | `true` | Bật Session Viewer |
| `HOST_UID` | Bắt buộc với Docker Compose | UID của user host chạy Codex app-server |
| `HOST_GID` | Bắt buộc với Docker Compose | GID của user host chạy Codex app-server |

### 2. Cài Node dependencies và build lần đầu

```bash
cd dashboard
npm ci
npm run build
```

`npm ci` cài toàn bộ npm workspaces từ `package-lock.json`, bao gồm Inngest SDK và
`@inngest/test`. Nó không cài Inngest server; server được pull dưới dạng Docker image
khi chạy `npm run dev:inngest` lần đầu.

Build lần đầu tạo `dist` cho các workspace được import qua package exports. Sau khi
đổi code trong `shared` hoặc orchestration package, chạy lại `npm run build` nếu
process development chưa thấy thay đổi.

### 3. SQLite và dữ liệu cấu hình

Migration chạy tự động khi dashboard, worker hoặc CLI mở `workflows.db`. Database bật
WAL, foreign keys và busy timeout; không cần chạy migration command riêng.

`workflows.db` là database runtime local và không được Git theo dõi. Khi chạy
`./setup.sh` mà file này chưa tồn tại, setup sao chép `workflows.db.example` để lấy
schema cùng cấu hình agent/workflow mặc định. Nếu khởi động dashboard, worker hoặc CLI
trực tiếp mà chưa chạy setup, hệ thống vẫn tạo một database trống. Hệ thống không
import execution state từ `workflow.json` hoặc các flow directory cũ.

Catalog agent/workflow có nguồn chuẩn dạng text tại `team.json`, `prompts/*.md` và
`workflow-catalog.json`. Sau khi review các file này, reset database runtime bằng:

```bash
cd dashboard
npm run build
npm run catalog:reset
```

Lệnh reset xóa toàn bộ flow, attempt, command, event và cấu hình catalog cũ trong
database, sau đó seed catalog mới. Workspace local được giữ mặc định; thêm
`-- --clear-workspaces` nếu cần tạo template không chứa đường dẫn máy cá nhân.

### Dữ liệu demo local

Tạo 15 flow `completed` trong workspace riêng `Fake Demo`, kèm output, log, token và
session metadata hợp lệ:

```bash
python3 seed_fake_flows.py 15
```

Seeder đọc workflow/agent catalog hiện tại từ `workflows.db`; không hardcode workflow
ID. Mỗi lần chạy, nó chỉ thay thế workspace có ID bắt đầu bằng `ws_fake_` và không sửa
flow/workspace thật. Có thể chỉ tạo lại artifact từ dữ liệu fake đang có:

```bash
python3 create_fake_artifacts.py --clean
```

Dùng `--db`, `--task-flows-dir`, `--workspace-path` hoặc các biến
`DEVTEAM_DB_PATH`/`DEVTEAM_TASK_FLOWS_DIR` khi file runtime nằm ở đường dẫn khác.

Mỗi workflow snapshot `context` và `NEEDS_FIX` routing khi tạo flow. Quality gate của
workflow delivery quay lại `implementer`; workflow audit dùng target `block` để không
tự sửa code.

## Start development

Nên khởi động theo thứ tự Inngest, worker, sau đó dashboard. Dùng ba terminal riêng.
Mỗi terminal Node phải export cùng file `.env` vì worker và Express server không tự
load `.dev-team/.env`.

### Terminal 1 — Inngest server

```bash
cd /path/to/project/.dev-team
set -a
source .env
set +a
cd dashboard
npm run dev:inngest
```

Lần đầu Docker sẽ pull `inngest/inngest:v1.39.0`. Chờ container chuyển sang healthy
trước khi chạy worker. Lệnh chạy foreground để hiển thị log; giữ terminal này mở.

Muốn chạy Inngest ở background thay vì giữ terminal:

```bash
cd /path/to/project/.dev-team
docker compose -f docker-compose.inngest.yml up -d
docker compose -f docker-compose.inngest.yml logs -f inngest
```

Docker Compose tự đọc `.dev-team/.env` cho container.

### Terminal 2 — Connect worker

```bash
cd /path/to/project/.dev-team
set -a
source .env
set +a
cd dashboard
npm run dev:worker
```

Worker chạy TypeScript watch mode, kết nối tới
`ws://127.0.0.1:8289/v0/connect`, dispatch durable outbox, cung cấp HTTP health và
chạy tối đa `DEVTEAM_AGENT_CONCURRENCY` agent. Log thành công có dạng:

```text
[worker] <runner-id> connected to ws://127.0.0.1:8289/v0/connect
```

Concurrency được phân bổ theo loại checkout:

- Flow chạy trực tiếp dùng chung một key theo workspace, nên chỉ một agent được chạy
  trong base checkout tại một thời điểm.
- Flow bật `Run in an isolated git worktree` dùng key riêng theo flow, nên nhiều flow
  cùng workspace có thể chạy song song tới giới hạn `DEVTEAM_AGENT_CONCURRENCY`.
- Bước finalize/merge của các worktree vẫn được khóa theo workspace và chạy tuần tự,
  tránh nhiều lệnh Git merge cùng sửa base checkout.

### Terminal 3 — Dashboard API và frontend

```bash
cd /path/to/project/.dev-team
set -a
source .env
set +a
cd dashboard
npm run dev
```

Mở:

- Dashboard UI: <http://127.0.0.1:5173>
- Express API và Socket.IO: <http://127.0.0.1:3001>
- Inngest UI/API: <http://127.0.0.1:8288>

## Kiểm tra hệ thống đã sẵn sàng

Từ terminal thứ tư:

```bash
cd /path/to/project/.dev-team
docker compose -f docker-compose.inngest.yml ps
curl -i http://127.0.0.1:3011
curl -i http://127.0.0.1:3001/api/orchestration/health
```

Kết quả mong đợi:

- Container `inngest` có trạng thái `healthy`.
- Worker health trả HTTP `200` và `"ready":true`.
- `/api/orchestration/health` trả HTTP `200`, với cả `inngest.ready` và
  `worker.ready` bằng `true`.

Trong vài giây đầu endpoint có thể trả `503` khi Connect worker chưa sẵn sàng. Nếu
tiếp tục trả `503`, xem phần troubleshooting bên dưới.

## Dừng và khởi động lại development

Nhấn `Ctrl+C` trong terminal dashboard và worker để shutdown sạch. Nếu Inngest chạy
foreground bằng npm script, nhấn `Ctrl+C` trong terminal đó. Nếu chạy background:

```bash
cd /path/to/project/.dev-team
docker compose -f docker-compose.inngest.yml down
```

`docker compose down` xóa container/network nhưng giữ named volume `inngest-data`,
do đó durable Inngest state vẫn còn khi start lại.

Chỉ dùng lệnh sau khi chủ động muốn xóa toàn bộ internal state của Inngest:

```bash
docker compose -f docker-compose.inngest.yml down -v
```

Lệnh `down -v` không xóa `workflows.db`, nhưng làm mất Inngest checkpoints/queue đang
có. Không dùng nó để restart thông thường.

Quy trình start lại hằng ngày vẫn là:

```text
npm run dev:inngest  ->  npm run dev:worker  ->  npm run dev
```

## Troubleshooting

### `INNGEST_EVENT_KEY` hoặc `INNGEST_SIGNING_KEY` chưa được set

Nếu Docker Compose báo `set INNGEST_* in .env`, kiểm tra `.dev-team/.env` tồn tại và
không còn placeholder. Với worker/dashboard, nhớ `source .env` trong chính terminal
đang chạy process.

### Worker báo connection refused hoặc không connected

Kiểm tra Inngest trước:

```bash
docker compose -f docker-compose.inngest.yml ps
docker compose -f docker-compose.inngest.yml logs --tail=200 inngest
```

Xác nhận `INNGEST_GATEWAY_URL=ws://127.0.0.1:8289/v0/connect`, chờ container healthy,
sau đó restart `npm run dev:worker`.

### Health endpoint trả `503`

- `inngest.ready=false`: kiểm tra container và port `8288`.
- `worker.ready=false`: kiểm tra worker log, `curl http://127.0.0.1:3011` và chắc chắn
  `DEVTEAM_WORKER_HEALTH_URL` trỏ đúng health endpoint của worker.

### Port đã được sử dụng

```bash
lsof -i :5173
lsof -i :3001
lsof -i :3011
lsof -i :8288
lsof -i :8289
```

Có thể đổi dashboard/worker port bằng biến môi trường. Hai port Inngest hiện được
bind cố định trong `../docker-compose.inngest.yml`; nếu đổi port Compose, phải đổi cả
`INNGEST_BASE_URL` và `INNGEST_GATEWAY_URL`.

### Dashboard không có flow/workspace

Dashboard chỉ đọc flow execution state từ `workflows.db`; nó không scan
`task-flows/**/workflow.json`. Kiểm tra `DEVTEAM_DB_PATH`, sau đó tạo workspace,
workflow và agent configuration nếu đây là database mới.

### Agent không start hoặc không có session

Kiểm tra CLI runtime tương ứng có trong `PATH` của terminal worker, đã authenticate,
và worker có quyền truy cập workspace cùng `DASHBOARD_CODEX_HOME`. Agent CLI chạy
trên host của worker, không chạy bên trong container Inngest.

Nếu agent báo `Permission denied` khi ghi `task-flows`, xác nhận `HOST_UID` và
`HOST_GID` trong `.env` khớp `id -u`/`id -g`. Worker và server sẽ fail startup nếu
UID/GID hoặc các shared path không hợp lệ; không dùng `chmod 777` để bỏ qua lỗi này.

### Quyền filesystem của agent

Agent app-server chạy với `danger-full-access`. Chế độ này không khởi tạo Bubblewrap,
vì vậy không phụ thuộc user namespace/AppArmor của máy host và không gặp lỗi
`bwrap: setting up uid map`. `cwd`, thread, turn, log và artifact vẫn được gắn đúng
flow/workspace ở tầng orchestration, nhưng agent có thể đọc/ghi ngoài workspace.
Chỉ chạy orchestrator trên máy và với repository mà bạn tin cậy.

## Packages

- `shared`: REST, Socket.IO, flow, step, attempt và session types.
- `orchestration`: SQLite migrations/domain service, outbox, Inngest functions,
  Connect worker, agent supervisor, worktree coordination và CLI.
- `server`: REST, Socket.IO domain-event projection, artifact APIs và Session Viewer.
- `client`: React dashboard với các trạng thái queued/blocked/stopping/expired.

## REST API

```text
POST   /api/flows
GET    /api/flows?workspaceId=<id>
GET    /api/flows/:flowId
POST   /api/flows/:flowId/actions/retry
POST   /api/flows/:flowId/actions/resume
POST   /api/flows/:flowId/actions/stop
DELETE /api/flows/:flowId
GET    /api/orchestration/health
```

Action endpoints trả `202 Accepted` với
`{ flowId, commandId, status: "queued" }`. Dùng `Idempotency-Key` khi cần retry HTTP
request an toàn. Active flow phải được stop trước khi delete.

Log, output, token và native session routes nằm dưới `/api/flows/:flowId`; ownership
được resolve qua SQLite. Socket.IO snapshot được filter theo workspace và domain
event sử dụng monotonic sequence để reconnect/resync không tạo duplicate state.

## CLI

Chạy từ `dashboard` sau khi đã export `.env`:

```bash
npm run flow -- start --workflow <id> --workspace <id> --prompt "..."
npm run flow -- list [--workspace <id>]
npm run flow -- get <flow-id>
npm run flow -- retry <flow-id> --step <step> [--clear-output] [--prompt "..."]
npm run flow -- resume <flow-id>
npm run flow -- stop <flow-id>
npm run flow -- delete <flow-id>
```

## Production processes

Inngest production vẫn chạy bằng `docker-compose.inngest.yml` với persistent volume.
Dashboard server và worker là hai process Node độc lập:

```bash
cd dashboard
npm run build
npm start
npm run start:worker
```

Không chạy `npm start` và `npm run start:worker` nối tiếp trong cùng foreground
terminal; dùng process supervisor hoặc hai service riêng. Production readiness là
`GET /api/orchestration/health` và chỉ trả `200` khi cả Inngest lẫn worker sẵn sàng.

## Verification

```bash
npm run build
npm run typecheck --workspace=orchestration
npm test --workspace=orchestration
npm test --workspace=server
npm test --workspace=client
```

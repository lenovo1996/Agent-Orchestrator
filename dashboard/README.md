# DevTeam Dashboard

Real-time web dashboard để monitoring và quản lý dev-team workflows.

## Features

- 📊 **Real-time monitoring**: Xem status của tất cả workflows, agents, và tasks
- 🔄 **Live updates**: WebSocket-based real-time updates
- 🧭 **Session Viewer**: Xem transcript Codex có cấu trúc, attempts, commands, patches, plans, tools và token stats
- 📄 **Output preview**: Preview markdown output files với syntax highlighting
- 🎯 **Task management**: Start, stop, retry workflows từ UI
- 🔀 **Git integration**: Xem git status của các repositories
- ➕ **Start new tasks**: Tạo workflow mới ngay từ dashboard
- 📱 **Mobile responsive**: Tối ưu cho cả desktop và mobile
- 🌙 **Dark theme**: Modern dark UI với shadcn/ui

## Quick Start

Requires Node.js `>=22.15.0` so completed `.jsonl.zst` rollouts can be read with the built-in zstd stream.

### 1. Development Mode (Local)

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Dashboard will be available at:
# - Frontend: http://localhost:5173
# - Backend: http://localhost:3001
```

### 2. Production Build

```bash
# Build all packages
npm run build

# Start production server
npm start

# Dashboard at: http://localhost:3001
```

### 3. With Cloudflare Tunnel (Public Access)

Expose dashboard ra public Internet:

```bash
# Quick start (1 command)
./start-with-tunnel.sh

# Hoặc manual
./cloudflare-tunnel-setup.sh  # Setup cloudflared
./cloudflare-tunnel-quick.sh  # Start tunnel
```

📖 **Chi tiết**: Xem [CLOUDFLARE-TUNNEL.md](./CLOUDFLARE-TUNNEL.md)

## Project Structure

```
dashboard/
├── client/          # React frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── components/  # UI components
│   │   ├── hooks/       # React hooks
│   │   ├── store/       # Zustand state management
│   │   └── lib/         # Utilities
│   └── dist/        # Built frontend (served by server)
├── server/          # Express backend
│   ├── src/
│   │   ├── routes/      # API routes
│   │   ├── socket.ts    # WebSocket server
│   │   └── index.ts     # Server entry
│   └── dist/        # Built backend
├── shared/          # Shared TypeScript types
│   └── src/types.ts
└── scripts/         # Helper scripts
```

## Architecture

### Frontend Stack
- **React 19** + **TypeScript**
- **Vite** (dev server & build tool)
- **shadcn/ui** (UI components)
- **TailwindCSS** (styling)
- **Zustand** (state management)
- **Socket.io Client** (real-time updates)

### Backend Stack
- **Node.js** + **Express**
- **TypeScript**
- **Socket.io** (WebSocket server)
- **Chokidar** (file watching)

### Communication
- **REST API**: HTTP endpoints cho actions (start, stop, retry)
- **WebSocket**: Real-time updates cho flow status và structured Codex sessions
- **File watching**: Server watch workflow.json files và emit events

## API Endpoints

### Flows
- `GET /api/flows` - List all workflows
- `GET /api/flows/:flowId` - Get workflow details
- `GET /api/flows/:flowId/logs/:step` - Get step logs
- `GET /api/flows/:flowId/sessions/:step` - List structured session attempts
- `GET /api/flows/:flowId/sessions/:step/:runId` - Get sanitized session snapshot
- `GET /api/flows/:flowId/sessions/:step/:runId/items/:itemId` - Get lazy item detail
- `GET /api/flows/:flowId/output/:step` - Get step output
- `GET /api/flows/:flowId/tokens` - Get token usage
- `POST /api/flows/start` - Start new workflow
- `POST /api/flows/:flowId/retry` - Retry a step
- `POST /api/flows/:flowId/stop` - Stop workflow

### Git
- `GET /api/git/status` - Git status của các jinjer_* repos

## WebSocket Events

### Client → Server
- `request_state` - Request initial state

### Server → Client
- `state_init` - Initial state (flows)
- `flow_update` - Workflow state updated
- `log_lines` - New log lines for a step

## Configuration

### Environment Variables

```bash
# Server port (default: 3001)
DASHBOARD_PORT=3001

# Native Codex home (default: CODEX_HOME, then ~/.codex)
DASHBOARD_CODEX_HOME=/path/to/.codex

# Disable the viewer without restoring the legacy Logs panel
DASHBOARD_SESSION_VIEWER_ENABLED=true
```

### .env.example

```bash
cp .env.example .env
# Edit .env with your configuration
```

## Development

### Watch Mode

```bash
# Terminal 1: Build and watch TypeScript
npm run build --workspace=shared -- --watch
npm run build --workspace=server -- --watch

# Terminal 2: Run dev servers
npm run dev
```

### Type Checking

```bash
# Check all packages
npm run build

# Check specific package
npm run build --workspace=client
npm run build --workspace=server
npm run build --workspace=shared
```

## Deployment

### Option 1: PM2 (Process Manager)

```bash
# Install PM2 globally
npm install -g pm2

# Build project
npm run build

# Start with PM2
pm2 start npm --name "devteam-dashboard" -- start

# View logs
pm2 logs devteam-dashboard

# Stop
pm2 stop devteam-dashboard
```

### Option 2: systemd Service

Create `/etc/systemd/system/devteam-dashboard.service`:

```ini
[Unit]
Description=DevTeam Dashboard
After=network.target

[Service]
Type=simple
User=phi
WorkingDirectory=/home/phi/Projects/jinjer/PHP8/.dev-team/dashboard
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5s
Environment=NODE_ENV=production
Environment=PORT=3001

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable devteam-dashboard
sudo systemctl start devteam-dashboard
sudo systemctl status devteam-dashboard
```

### Option 3: Docker (TODO)

```dockerfile
# Dockerfile coming soon
```

## Public Access với Cloudflare Tunnel

Dashboard mặc định chỉ chạy trên localhost. Để expose ra Internet:

### Quick Tunnel (Dễ nhất)
```bash
./cloudflare-tunnel-quick.sh
# → Tạo URL tạm thời: https://xyz-abc.trycloudflare.com
```

### Named Tunnel (URL cố định)
```bash
# 1. Setup
./cloudflare-tunnel-setup.sh

# 2. Authenticate
cloudflared tunnel login

# 3. Create tunnel
cloudflared tunnel create devteam-dashboard

# 4. Configure (edit cloudflare-tunnel-config.yml)

# 5. Start
./cloudflare-tunnel-start.sh
```

📖 **Chi tiết**: [CLOUDFLARE-TUNNEL.md](./CLOUDFLARE-TUNNEL.md)

## Troubleshooting

### Port already in use
```bash
# Find process using port 3001
lsof -i :3001
kill -9 <PID>

# Or change port
PORT=3002 npm run dev
```

### WebSocket connection failed
- Check server is running: `curl http://localhost:3001`
- Check firewall settings
- Check CORS configuration in server

### Flows not showing
- Verify task-flows directory exists
- Check workflow.json files are valid
- Check server logs for errors

### Build errors
```bash
# Clean and rebuild
rm -rf node_modules client/node_modules server/node_modules shared/node_modules
rm -rf client/dist server/dist shared/dist
npm install
npm run build
```

## Contributing

1. Tạo feature branch
2. Make changes
3. Test locally
4. Build để check lỗi TypeScript
5. Submit PR

## License

Internal project - Not for public distribution

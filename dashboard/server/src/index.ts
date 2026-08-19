import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createOrchestrationRuntime } from '@devteam-dashboard/orchestration';
import { loadConfig } from './config.js';
import { createArtifactWatcher } from './watcher.js';
import { setupSocketEvents } from './events.js';
import { flowsRouter } from './routes/flows.js';
import { workflowsRouter } from './routes/workflows.js';
import { agentsRouter } from './routes/agents.js';
import { workspacesRouter } from './routes/workspaces.js';
import { sessionsRouter } from './routes/sessions.js';
import { improvePromptRouter } from './routes/improve-prompt.js';
import { agentInteractionRouter } from './routes/agent-interaction.js';
import { SessionService } from './session/service.js';
import type { ClientToServerEvents, ServerToClientEvents } from '@devteam-dashboard/shared';

// 1. Load configuration
const config = loadConfig();
const orchestration = createOrchestrationRuntime({ repoRoot: config.repoRoot, taskFlowsDir: config.taskFlowsDir, codexHome: config.codexHome });
const sessionService = new SessionService(config, orchestration.service);

// 1b. Initialize app-server client
const appServerPort = process.env.CODEX_APP_SERVER_PORT || '9876';
const appServerUrl = process.env.CODEX_APP_SERVER_URL || `ws://127.0.0.1:${appServerPort}`;
const appServerAutoApprove = process.env.DASHBOARD_APP_SERVER_AUTO_APPROVE !== 'false';
const appServerClient = orchestration.runner.initAppServerClient({
  url: appServerUrl,
  autoApprove: appServerAutoApprove,
});
orchestration.runner.supervisor.setAppServerClient(appServerClient);

// Connect with retry — app-server may start after the dashboard server
function connectAppServer(attempt = 1): void {
  appServerClient.connect().then(() => {
    console.log(`[dashboard] Connected to app-server at ${appServerUrl}`);
  }).catch((err) => {
    if (attempt < 12) {
      setTimeout(() => connectAppServer(attempt + 1), 5_000);
    } else {
      console.warn(`[dashboard] App-server unreachable after ${attempt} attempts: ${(err as Error).message}`);
    }
  });
}
connectAppServer();

// 2. Express app with CORS middleware
const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

// 3. Mount REST routes on /api
app.use('/api', flowsRouter(config, orchestration));
app.use('/api', workflowsRouter(orchestration.database));
app.use('/api', agentsRouter(orchestration.database));
app.use('/api', workspacesRouter(orchestration.database));
app.use('/api', sessionsRouter(config, sessionService));
app.use('/api', improvePromptRouter());
app.use('/api', agentInteractionRouter(orchestration.service, orchestration.runner));

// 4. Create HTTP server, then Socket.IO server on top
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: config.corsOrigin,
    methods: ['GET', 'POST'],
  },
});

// 5. Watch output/log artifacts only. Flow state is projected from SQLite domain events.
const watcher = createArtifactWatcher(orchestration.service);

// 6. Setup Socket.IO event handlers, wiring watcher events
const closeEvents = setupSocketEvents(io, orchestration.service, watcher, sessionService);

// 7. In production: serve static files from client dist
if (config.isProduction) {
  app.use(express.static(config.clientDistPath));

  // SPA fallback: serve index.html for non-API routes
  app.get('*', (_req, res) => {
    res.sendFile('index.html', { root: config.clientDistPath });
  });
}

// 8. Listen on configured host:port
httpServer.listen(config.port, config.host, () => {
  console.log(`[dashboard] Server running at http://${config.host}:${config.port}`);
  console.log(`[dashboard] SQLite state: ${orchestration.config.dbPath}`);
  console.log(`[dashboard] Mode: ${config.isProduction ? 'production' : 'development'}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    closeEvents();
    void watcher.close().finally(() => {
      httpServer.close(() => {
        orchestration.close();
        process.exit(0);
      });
    });
  });
}

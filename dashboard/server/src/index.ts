import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { loadConfig } from './config.js';
import { createWatcher } from './watcher.js';
import { setupSocketEvents } from './events.js';
import { flowsRouter } from './routes/flows.js';
import type { ClientToServerEvents, ServerToClientEvents } from '@devteam-dashboard/shared';

// 1. Load configuration
const config = loadConfig();

// 2. Express app with CORS middleware
const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

// 3. Mount REST routes on /api
app.use('/api', flowsRouter(config));

// 4. Create HTTP server, then Socket.IO server on top
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: config.corsOrigin,
    methods: ['GET', 'POST'],
  },
});

// 5. Create filesystem watcher
const watcher = createWatcher(config.taskFlowsDir, config.parallelStatusPath);

// 6. Setup Socket.IO event handlers, wiring watcher events
setupSocketEvents(io, config, watcher);

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
  console.log(`[dashboard] Watching: ${config.taskFlowsDir}`);
  console.log(`[dashboard] Mode: ${config.isProduction ? 'production' : 'development'}`);
});

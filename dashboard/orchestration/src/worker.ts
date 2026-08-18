import { createServer } from 'node:http';
import { connect, ConnectionState, type WorkerConnection } from 'inngest/connect';
import { createOrchestrationRuntime } from './runtime.js';

const runtime = createOrchestrationRuntime();
let connection: WorkerConnection | null = null;
let shuttingDown = false;

function connectionStatus(): 'connecting' | 'connected' | 'disconnected' | 'stopping' {
  if (shuttingDown) return 'stopping';
  if (!connection) return 'connecting';
  if (connection.state === ConnectionState.ACTIVE) return 'connected';
  if (connection.state === ConnectionState.CLOSED || connection.state === ConnectionState.CLOSING) return 'disconnected';
  return 'connecting';
}

runtime.service.heartbeat('connecting');
await runtime.runner.reconcileRunningAttempts();
await runtime.reconcileStoppingFlows();
runtime.outbox.start();

const healthPort = Number(process.env.DEVTEAM_WORKER_HEALTH_PORT || 3011);
const healthServer = createServer((_request, response) => {
  const status = connectionStatus();
  response.statusCode = status === 'connected' ? 200 : 503;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ ready: status === 'connected', runnerId: runtime.config.runnerId, status }));
});
healthServer.listen(healthPort, '127.0.0.1');

const heartbeat = setInterval(() => runtime.service.heartbeat(connectionStatus()), runtime.config.workerHeartbeatMs);
heartbeat.unref();
let reconcilingStops = false;
const stopReconciler = setInterval(() => {
  if (reconcilingStops) return;
  reconcilingStops = true;
  void runtime.reconcileStoppingFlows()
    .catch((error) => console.error('[worker] stop reconciliation failed:', error))
    .finally(() => { reconcilingStops = false; });
}, 1_000);
stopReconciler.unref();

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime.service.heartbeat('stopping');
  runtime.outbox.stop();
  clearInterval(heartbeat);
  clearInterval(stopReconciler);
  const flowIds = [...new Set(runtime.service.runningAttempts().map((attempt) => attempt.flowId))];
  await Promise.all(flowIds.map((flowId) => runtime.runner.supervisor.terminateFlow(flowId)));
  if (connection) await connection.close();
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  runtime.service.heartbeat('disconnected');
  runtime.close();
  console.log(`[worker] stopped after ${signal}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void shutdown(signal).finally(() => process.exit(0)); });
}

try {
  connection = await connect({
    apps: [{ client: runtime.inngest.client, functions: runtime.inngest.functions }],
    gatewayUrl: runtime.config.inngestGatewayUrl,
    instanceId: runtime.config.runnerId,
    maxWorkerConcurrency: runtime.config.agentConcurrency,
    handleShutdownSignals: [],
  });
  runtime.service.heartbeat(connectionStatus());
  console.log(`[worker] ${runtime.config.runnerId} connected to ${runtime.config.inngestGatewayUrl}`);
  await connection.closed;
  if (!shuttingDown) {
    runtime.service.heartbeat('disconnected');
    throw new Error('Inngest Connect connection closed');
  }
} catch (error) {
  runtime.service.heartbeat('disconnected');
  console.error('[worker] fatal:', error);
  await shutdown('fatal');
  process.exitCode = 1;
}

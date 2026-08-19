#!/usr/bin/env node
'use strict';

/**
 * start-appserver.js — Start codex app-server for dev environment.
 *
 * If CODEX_APP_SERVER_URL is already set and reachable, skip starting.
 * Otherwise, start `codex app-server --listen ws://127.0.0.1:PORT` in foreground.
 */

const { spawn } = require('node:child_process');
const net = require('node:net');

const APP_SERVER_PORT = process.env.CODEX_APP_SERVER_PORT || '9876';
const APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL || `ws://127.0.0.1:${APP_SERVER_PORT}`;

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.connect(Number(port), '127.0.0.1');
  });
}

async function main() {
  // Check if already reachable
  const reachable = await checkPort(APP_SERVER_PORT);
  if (reachable) {
    console.log(`[appserver] Already running at ${APP_SERVER_URL}`);
    console.log(`[appserver] CODEX_APP_SERVER_URL=${APP_SERVER_URL}`);
    // Keep alive — just sleep forever so concurrently keeps this process
    await new Promise(() => {});
    return;
  }

  console.log(`[appserver] Starting codex app-server on ws://127.0.0.1:${APP_SERVER_PORT}...`);
  console.log(`[appserver] CODEX_APP_SERVER_URL=${APP_SERVER_URL}`);

  // Export URL for child processes (server)
  process.env.CODEX_APP_SERVER_URL = APP_SERVER_URL;

  const child = spawn('codex', [
    'app-server',
    '--listen', `ws://127.0.0.1:${APP_SERVER_PORT}`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_APP_SERVER_URL: APP_SERVER_URL },
  });

  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[appserver] ${text}`);
  });

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    process.stderr.write(`[appserver] ${text}`);
  });

  child.on('exit', (code, signal) => {
    console.log(`[appserver] Exited (code=${code}, signal=${signal})`);
    process.exit(code ?? 1);
  });

  child.on('error', (err) => {
    console.error(`[appserver] Failed to start: ${err.message}`);
    console.error('[appserver] Make sure codex CLI is installed: npm i -g @openai/codex');
    process.exit(1);
  });

  // Forward signals to child
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      child.kill(sig);
    });
  }
}

main().catch((err) => {
  console.error(`[appserver] ${err.message}`);
  process.exit(1);
});

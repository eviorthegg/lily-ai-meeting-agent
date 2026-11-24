#!/usr/bin/env node
/**
 * Boots the whole local stack: HTTP API + WebSocket shim.
 *
 * Fails loudly and specifically rather than half-starting. A stack that comes up
 * with a dead database and only tells you on the first request wastes far more
 * time than one that refuses to start and names the command to fix it.
 *
 * Run: npm run dev:local   (needs `npm run db:up` first)
 */
import net from 'node:net';
import { buildConfig, createProviders, resolveStage } from '../packages/shared/dist/index.js';
import { startLocalApi } from '../api/dist/local/server.js';
import { startWsShim } from '../api/dist/local/ws-shim.js';
import { DeviceTokenAuthenticator } from '../api/dist/ws/daemon-auth.js';
import { ensureIndexes } from '../api/dist/db/indexes.js';
import { getDb, closeClient } from '../api/dist/db/client.js';

function probe(host, port, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const stage = resolveStage();
if (stage !== 'local') {
  die(`dev:local refuses to run with LILY_STAGE=${stage}. It is for the local stage only.`);
}

const config = buildConfig(stage);

// --- dependencies --------------------------------------------------------
if (!(await probe('127.0.0.1', 27017))) {
  die('MongoDB is not reachable on 127.0.0.1:27017.\nStart it with:  npm run db:up');
}

let db;
try {
  db = await getDb();
  await ensureIndexes(db);
} catch (error) {
  die(`Could not reach the database.\n  ${error.message}\n\nTry:  npm run db:up`);
}

// --- services ------------------------------------------------------------
// The real device-token authenticator, backed by `daemon_tokens`. Enrolment goes
// through POST /daemon/enroll like it does in every other stage, so a daemon
// enrolled here survives a restart and the local stack exercises the production
// authentication path rather than an in-memory stand-in.
const auth = new DeviceTokenAuthenticator();
const providers = createProviders(config);

let api;
let shim;

try {
  api = await startLocalApi({ config, providers });
} catch (error) {
  die(`Could not start the HTTP API.\n  ${error.message}`);
}

try {
  // The shim reproduces the API Gateway WebSocket contract, so the same
  // handlers run here as in a deployed stage. Routes beyond the built-in
  // presence/hello handling are registered as the product needs them.
  shim = await startWsShim({ deps: { auth, pusher: providers.ws }, router: {} });
} catch (error) {
  await api.close();
  die(`Could not start the WebSocket shim.\n  ${error.message}`);
}

console.log(`
  Lily is running locally.

    API          ${api.url}
    WebSocket    ws://127.0.0.1:${shim.socketPort}
    WS control   http://127.0.0.1:${shim.controlPort}
    Mongo        ${config.mongo.dbName}
    Mail         written to tmp/mail/ as .eml — nothing is sent

  Next:
    npm run dev -w web          the dashboard, on ${config.webBaseUrl}
    node daemon/dist/index.js enroll --token <token from the invite email>
    node daemon/dist/index.js run    your own coding agent

  Ctrl-C to stop.
`);

// --- shutdown ------------------------------------------------------------
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} — shutting down.`);
  await Promise.allSettled([api.close(), shim.close(), closeClient()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

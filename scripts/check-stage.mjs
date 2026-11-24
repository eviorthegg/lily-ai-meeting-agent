#!/usr/bin/env node
/**
 * Reports what the current environment resolves to, and which local-stage
 * dependencies are actually reachable.
 *
 * Run this first when something local misbehaves — it distinguishes "the code is
 * wrong" from "mongod isn't running", which are the two failure modes that look
 * identical from a stack trace.
 */
import net from 'node:net';
import { buildConfig, resolveStage } from '../packages/shared/dist/index.js';

function probe(host, port, timeoutMs = 1_000) {
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

const stage = resolveStage();
const config = buildConfig(stage);

console.log(`\nstage: ${stage}\n`);
console.log('  web              ', config.webBaseUrl);
console.log('  api              ', config.apiBaseUrl);
console.log('  websocket        ', config.wsBaseUrl);
console.log('  mongo db         ', config.mongo.dbName);
console.log('  realtime model   ', config.realtime.model);
console.log('  max concurrent   ', config.meeting.maxConcurrentMeetings, 'meetings');
console.log('  ga4              ', config.analytics.ga4.measurementId ?? 'disabled');

if (stage !== 'local') {
  console.log('\nDependency probing is only meaningful for the local stage.\n');
  process.exit(0);
}

console.log('\nlocal dependencies');

// NOT-YET-BUILT is distinct from DOWN. Reporting an unbuilt layer as "down"
// would send someone hunting for a crashed process that never existed.
const NOT_BUILT = 'not built yet — layer 2';

const checks = [
  { label: 'mongod        :27017', host: '127.0.0.1', port: 27017, fix: 'npm run db:up' },
  { label: 'api           :3000', host: '127.0.0.1', port: 3000, fix: NOT_BUILT },
  { label: 'ws shim       :3001', host: '127.0.0.1', port: 3001, fix: NOT_BUILT },
  { label: 'ws control    :3002', host: '127.0.0.1', port: 3002, fix: NOT_BUILT },
];

let down = 0;
let pending = 0;

for (const check of checks) {
  const up = await probe(check.host, check.port);
  const unbuilt = check.fix === NOT_BUILT;

  if (up) {
    console.log(`  up    ${check.label}`);
  } else if (unbuilt) {
    pending += 1;
    console.log(`  --    ${check.label}   ${check.fix}`);
  } else {
    down += 1;
    console.log(`  DOWN  ${check.label}   → ${check.fix}`);
  }
}

const summary =
  down > 0
    ? `${down} dependency down`
    : pending > 0
      ? `dependencies ok; ${pending} service(s) not built yet`
      : 'all local dependencies reachable';
console.log(`\n${summary}\n`);

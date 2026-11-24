#!/usr/bin/env node
/**
 * Local-stage smoke test.
 *
 * Verifies that config resolves, that the local providers are real enough to do
 * actual work (the mail provider writes a genuine .eml), and that a deployed
 * stage refuses to construct without its wiring instead of degrading quietly.
 *
 * Run: node scripts/smoke-local.mjs
 */
import { buildConfig, createProviders, resolveStage } from '../packages/shared/dist/index.js';

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(28)} ${String(actual)}`);
}

const stage = resolveStage({ LILY_STAGE: 'local' });
const cfg = buildConfig(stage);

console.log('\nconfig');
check('stage', cfg.stage, 'local');
check('realtime model', cfg.realtime.model, 'gpt-realtime-2.1');
check('mongo db', cfg.mongo.dbName, 'lily_local');
check('access token ttl (s)', cfg.auth.accessTokenTtlSec, 900);
check('permission timeout (s)', cfg.permissions.voiceApprovalTimeoutSec, 45);
check('retention default (days)', cfg.retention.defaultDays, 90);
// GA4 must be structurally incapable of firing outside prod.
check('ga4 id outside prod', cfg.analytics.ga4.measurementId, null);

console.log('\nlocal providers');
const providers = createProviders(cfg);
const { messageId } = await providers.mail.send({
  to: ['sarah@example.com'],
  subject: 'Lily local smoke test — café ☕',
  html: '<h1>hello</h1>',
  text: 'hello',
});
check('mail send returns id', typeof messageId, 'string');

console.log('\nstage guards');
try {
  resolveStage({ LILY_STAGE: 'staging' });
  check('unknown stage rejected', 'no throw', 'throw');
} catch {
  check('unknown stage rejected', 'throw', 'throw');
}
try {
  // No LILY_MAIL_FROM_ADDRESS etc. in this environment, so prod must refuse.
  createProviders(buildConfig('prod'));
  check('prod refuses w/o wiring', 'no throw', 'throw');
} catch {
  check('prod refuses w/o wiring', 'throw', 'throw');
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);

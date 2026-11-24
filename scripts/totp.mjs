#!/usr/bin/env node
/**
 * Prints the current TOTP code for a secret.
 *
 * For local testing only — it exists so you can drive MFA enrolment and step-up
 * without reaching for a phone every time a code expires. Step-up re-prompts
 * after a five-minute grace, so during a testing session you will want this a
 * lot.
 *
 * Never use this against a real account: a TOTP secret typed into a shell is a
 * secret in your shell history.
 *
 * Usage:
 *   node scripts/totp.mjs "HWUJ NP5S OPHF ..."     one code
 *   node scripts/totp.mjs "HWUJ ..." --watch        reprint as it rotates
 */
// otplib v13 is CommonJS and exposes `generate`/`verify` rather than the v12
// `authenticator` object, so it is required rather than imported. Both
// `import { authenticator }` and `import otplib` fail at runtime, not at parse
// time, which is why this needs more ceremony than it looks like it should.
import { createRequire } from 'node:module';

const { generateSync } = createRequire(import.meta.url)('otplib');

/** Must match api/src/auth/mfa/totp.ts, or the code will be rejected. */
const PERIOD_SEC = 30;

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const secret = args
  .filter((a) => !a.startsWith('--'))
  .join('')
  // Authenticator apps show the key in spaced groups for legibility; strip that
  // and normalise, so pasting it exactly as displayed works.
  .replace(/\s+/g, '')
  .toUpperCase();

if (secret === '') {
  console.error(
    '\nUsage: node scripts/totp.mjs "<base32 secret>" [--watch]\n\n' +
      'The secret is shown on the "Set up two-factor" screen.\n',
  );
  process.exit(1);
}

function emit() {
  const code = generateSync({ strategy: 'totp', secret, period: PERIOD_SEC });
  const remaining = PERIOD_SEC - (Math.floor(Date.now() / 1000) % PERIOD_SEC);
  process.stdout.write(
    `\r  ${code}   valid for ${String(remaining).padStart(2)}s${watch ? '' : '\n'}`,
  );
}

emit();

if (watch) {
  setInterval(emit, 1_000);
  process.on('SIGINT', () => {
    process.stdout.write('\n');
    process.exit(0);
  });
}

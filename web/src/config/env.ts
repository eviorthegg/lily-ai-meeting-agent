/**
 * Environment reader.
 *
 * Mirrors the stage system in packages/shared: local | dev | prod, defaulting to
 * `local` when unset because that is the direction that cannot cause harm. The
 * defaults for base URLs match `buildConfig()` so a developer running
 * `npm run dev -w web` against a local API needs no .env file at all.
 *
 * Nothing here is committed. See web/.env.example for the shape.
 */

export type Stage = 'local' | 'dev' | 'prod';

const STAGES: readonly Stage[] = ['local', 'dev', 'prod'];

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

function resolveStage(): Stage {
  const raw = import.meta.env.VITE_LILY_STAGE;
  if (raw === undefined || raw === '') return 'local';
  if (!isStage(raw)) {
    // Same rule as resolveStage() in packages/shared: an unrecognised stage is a
    // hard failure, never a fallback, so a typo in a pipeline cannot quietly
    // ship dev behaviour to production.
    throw new Error(`VITE_LILY_STAGE is "${raw}". Expected one of: ${STAGES.join(', ')}.`);
  }
  return raw;
}

function pick<T>(stage: Stage, choices: { local: T; dev: T; prod: T }): T {
  return choices[stage];
}

/** Empty string and undefined both mean "not set" — a blank env var is not a value. */
function orNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

export const stage: Stage = resolveStage();

export const apiBaseUrl: string =
  orNull(import.meta.env.VITE_LILY_API_BASE_URL) ??
  pick(stage, {
    local: 'http://localhost:3000',
    dev: 'https://api-dev.lily.example.com',
    prod: 'https://api.lily.example.com',
  });

/**
 * WebSocket API. Mirrors LILY_WS_BASE_URL in packages/shared, whose local
 * default is the port the ws shim in api/src/local listens on.
 *
 * The dashboard's live channel is additive to the daemon protocol and does not
 * have a deployed route yet; the provider in lib/live degrades to last-known
 * values with a timestamp when the connection fails, which is what happens
 * today against a real stage.
 */
export const wsBaseUrl: string =
  orNull(import.meta.env.VITE_LILY_WS_BASE_URL) ??
  pick(stage, {
    local: 'ws://localhost:3001',
    dev: 'wss://ws-dev.lily.example.com',
    prod: 'wss://ws.lily.example.com',
  });

/**
 * The REST API now exists, so `http` is the default in every stage.
 *
 * The mock adapter is still here and still complete — it is the fastest way to
 * demo the UI with no database, and it is a working specification of the intended
 * behaviour. It is opt-in now rather than the default: set
 * VITE_LILY_API_MODE=mock. Nothing but this function reads the difference; the UI
 * depends on the `LilyApi` interface only.
 */
function resolveApiMode(): 'mock' | 'http' {
  const raw = orNull(import.meta.env.VITE_LILY_API_MODE);
  if (raw === 'http' || raw === 'mock') return raw;
  return 'http';
}

export const apiMode: 'mock' | 'http' = resolveApiMode();

/**
 * GA4 is prod-only by construction, matching the server-side rule in
 * packages/shared/src/config. A developer machine or the dev environment cannot
 * pollute production analytics even if someone sets the measurement id.
 */
export const ga4MeasurementId: string | null =
  stage === 'prod' ? orNull(import.meta.env.VITE_LILY_GA4_MEASUREMENT_ID) : null;

export const posthog = {
  key: orNull(import.meta.env.VITE_LILY_POSTHOG_KEY),
  // EU region. Customers are European and Israeli; ingest stays in the EU.
  host: orNull(import.meta.env.VITE_LILY_POSTHOG_HOST) ?? 'https://eu.i.posthog.com',
  enabled: stage !== 'local',
} as const;

export const googleClientId: string | null = orNull(import.meta.env.VITE_LILY_GOOGLE_CLIENT_ID);

/**
 * Bumping this invalidates every stored consent choice and re-prompts. Kept in
 * lockstep with `analytics.consentPolicyVersion` in packages/shared.
 */
export const CONSENT_POLICY_VERSION = '2026-07-25';

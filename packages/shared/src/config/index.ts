import { resolveStage, type Stage } from '../stage.js';
import type { LilyConfig } from './types.js';

export * from './types.js';

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envOrNull(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

function pick<T>(stage: Stage, choices: { local: T; dev: T; prod: T }): T {
  return choices[stage];
}

/**
 * Build the config for a stage.
 *
 * Everything tunable lives here rather than at a call site, so plan allowances,
 * timeouts and the pinned model can be changed without hunting through handlers.
 * Values that differ per deployment (URLs, GA4 id) come from the environment;
 * values that are policy (token lifetimes, permission timeout) do not, so a
 * misconfigured environment cannot quietly weaken them.
 */
export function buildConfig(stage: Stage = resolveStage()): LilyConfig {
  return {
    stage,
    serviceName: 'lily',
    region: env('AWS_REGION', 'eu-central-1'),

    webBaseUrl: env(
      'LILY_WEB_BASE_URL',
      pick(stage, {
        local: 'http://localhost:5173',
        dev: 'https://dev.lilybot.dev',
        prod: 'https://lilybot.dev',
      }),
    ),
    apiBaseUrl: env(
      'LILY_API_BASE_URL',
      pick(stage, {
        local: 'http://localhost:3000',
        dev: 'https://api-dev.lilybot.dev',
        prod: 'https://api.lilybot.dev',
      }),
    ),
    wsBaseUrl: env(
      'LILY_WS_BASE_URL',
      pick(stage, {
        local: 'ws://localhost:3001',
        dev: 'wss://ws-dev.lilybot.dev',
        prod: 'wss://ws.lilybot.dev',
      }),
    ),

    mongo: {
      uri: { secretName: `lily/${stage}/mongo-uri` },
      dbName: pick(stage, { local: 'lily_local', dev: 'lily_dev', prod: 'lily' }),
      // Lambda reuses one client per warm container; a small pool is correct here.
      // A large pool multiplied by concurrent containers is how Atlas connection
      // limits get exhausted.
      maxPoolSize: pick(stage, { local: 5, dev: 5, prod: 10 }),
      minPoolSize: 0,
      serverSelectionTimeoutMs: 5_000,
    },

    auth: {
      accessTokenTtlSec: 15 * 60,
      refreshTokenTtlSec: 30 * 24 * 3600,
      deviceTokenRotationSec: 24 * 3600,
      installTokenTtlSec: 24 * 3600,
      emailVerificationTtlSec: 24 * 3600,

      // OWASP Argon2id baseline: m=19 MiB, t=2, p=1.
      // Lambda memory must exceed memoryCostKib with headroom or hashing will OOM —
      // the auth function is sized accordingly in template.yaml.
      argon2: {
        memoryCostKib: 19_456,
        timeCost: 2,
        parallelism: 1,
      },

      mfa: {
        // Server-side enforced. Not a toggle these roles can turn off.
        mandatoryForRoles: ['owner', 'admin', 'manager'],
        backupCodeCount: 10,
        totpWindowSteps: 1,
        stepUpGraceSec: 5 * 60,
      },

      lockout: {
        maxFailedAttempts: 10,
        baseDelayMs: 500,
        maxDelayMs: 5 * 60 * 1000,
        captchaAfterAttempts: 3,
      },

      session: {
        // Relaxed locally so development isn't an endless re-login loop. Deployed
        // stages share one value: dev should feel like prod for anything security-shaped.
        idleTimeoutSec: pick(stage, { local: 24 * 3600, dev: 3600, prod: 3600 }),
        absoluteLifetimeSec: pick(stage, { local: 7 * 24 * 3600, dev: 12 * 3600, prod: 12 * 3600 }),
      },
    },

    realtime: {
      // Verified against OpenAI's published model list on 2026-07-25.
      // gpt-realtime-2.1 is the current generation and supports tool use, which Lily
      // needs for dispatch. gpt-realtime-1.5 is stronger at pure audio but cannot
      // call tools, so it is not a candidate. Re-check before each release.
      model: env('LILY_REALTIME_MODEL', 'gpt-realtime-2.1'),
      miniModel: env('LILY_REALTIME_MINI_MODEL', 'gpt-realtime-2.1-mini'),
      // Audition before launch — voice availability varies by model generation.
      voice: env('LILY_REALTIME_VOICE', 'coral'),
      inputAudioFormat: 'pcm16',
      outputAudioFormat: 'pcm16',
      turnDetection: {
        type: 'server_vad',
        // Meeting audio carries more background noise than a headset, so this sits
        // above the API default to stop Lily triggering on keyboard and room tone.
        threshold: 0.6,
        silenceDurationMs: 700,
        prefixPaddingMs: 300,
      },
      bargeInCutoffMs: 1_500,
    },

    meeting: {
      // Must be unmistakably an AI in the participant list. Consent depends on it.
      botDisplayName: env('LILY_BOT_DISPLAY_NAME', 'Lily (AI assistant)'),
      maxDurationSec: 4 * 3600,
      silenceTimeoutSec: 5 * 60,
      emptyRoomGraceSec: 60,
      usageFlushIntervalSec: 60,
      defaultListeningMode: 'always',
      instanceType: env('LILY_INSTANCE_TYPE', 't3.medium'),
      // v1 target. Raising this needs an EC2 vCPU quota increase and a warm pool
      // to keep join latency acceptable — see docs/scaling.md before changing.
      maxConcurrentMeetings: Number(env('LILY_MAX_CONCURRENT_MEETINGS', '5')),
    },

    permissions: {
      voiceApprovalTimeoutSec: 45,
      maxQueuedRequests: 10,
      selfRequestImpliesApproval: true,
    },

    retention: {
      defaultDays: 90,
      minDays: 1,
      maxDays: 730,
    },

    analytics: {
      posthog: {
        // EU region — customers are European and Israeli.
        host: env('LILY_POSTHOG_HOST', 'https://eu.i.posthog.com'),
        enabled: stage !== 'local',
      },
      ga4: {
        // Null in local and dev so the tag cannot fire off a developer machine.
        measurementId: stage === 'prod' ? envOrNull('LILY_GA4_MEASUREMENT_ID') : null,
      },
      consentPolicyVersion: '2026-07-25',
    },
  };
}

let cached: LilyConfig | undefined;

/** Process-wide config, built once. Lambda containers reuse it across invocations. */
export function getConfig(): LilyConfig {
  cached ??= buildConfig();
  return cached;
}

/** Test seam — drops the memoised config so a test can switch stages. */
export function resetConfigCache(): void {
  cached = undefined;
}

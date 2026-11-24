import type { Stage } from '../stage.js';

/** Where a value comes from at runtime. Secret names resolve through the SecretsProvider. */
export interface SecretRef {
  /** Logical name, e.g. "lily/mongo-uri". The provider maps this to a real backing store. */
  readonly secretName: string;
}

export interface MongoConfig {
  readonly uri: SecretRef;
  readonly dbName: string;
  /** Serverless-friendly pooling: Lambda containers reuse one client across invocations. */
  readonly maxPoolSize: number;
  readonly minPoolSize: number;
  readonly serverSelectionTimeoutMs: number;
}

export interface AuthConfig {
  /** Short-lived. The brief fixes this at 15 minutes. */
  readonly accessTokenTtlSec: number;
  /** Refresh tokens rotate on every use; this is the outer bound on a family's life. */
  readonly refreshTokenTtlSec: number;
  /** Daemon device tokens rotate on this schedule and on every reconnect. */
  readonly deviceTokenRotationSec: number;
  /** One-time install tokens from the invite email. */
  readonly installTokenTtlSec: number;
  readonly emailVerificationTtlSec: number;

  readonly argon2: {
    readonly memoryCostKib: number;
    readonly timeCost: number;
    readonly parallelism: number;
  };

  readonly mfa: {
    /** Roles that cannot reach the dashboard without enrolling. Not a user-facing setting. */
    readonly mandatoryForRoles: readonly string[];
    readonly backupCodeCount: number;
    readonly totpWindowSteps: number;
    /** Step-up re-verification is valid this long before it must be repeated. */
    readonly stepUpGraceSec: number;
  };

  readonly lockout: {
    readonly maxFailedAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    /** CAPTCHA only appears after repeated failures, never on a first attempt. */
    readonly captchaAfterAttempts: number;
  };

  readonly session: {
    readonly idleTimeoutSec: number;
    readonly absoluteLifetimeSec: number;
  };
}

export interface RealtimeConfig {
  /**
   * Pinned deliberately. Verified against OpenAI's live model list at build time —
   * see docs/metering.md for the check date. Never resolve "latest" at runtime:
   * a silent model change would move both behaviour and COGS underneath us.
   */
  readonly model: string;
  /** Cost-optimised variant. Selectable per plan to hold margin on the cheaper tier. */
  readonly miniModel: string;
  readonly voice: string;
  readonly inputAudioFormat: 'pcm16';
  readonly outputAudioFormat: 'pcm16';
  readonly turnDetection: {
    readonly type: 'server_vad';
    /** Server VAD activation threshold, 0..1. Higher = less sensitive to background noise. */
    readonly threshold: number;
    readonly silenceDurationMs: number;
    readonly prefixPaddingMs: number;
  };
  /** Lily stops talking this fast when someone speaks over her. */
  readonly bargeInCutoffMs: number;
}

export interface MeetingConfig {
  /** Shown in the participant list. Must read unmistakably as an AI. */
  readonly botDisplayName: string;
  /** Hard cap regardless of what happens in the room. */
  readonly maxDurationSec: number;
  /** No audio at all from anyone for this long → wind down. */
  readonly silenceTimeoutSec: number;
  /** Everyone else left → wind down. */
  readonly emptyRoomGraceSec: number;
  /** How often the orchestrator flushes usage so a crash can't lose the whole meeting. */
  readonly usageFlushIntervalSec: number;
  /** Default listening posture; overridable per org. */
  readonly defaultListeningMode: 'always' | 'name_only';
  readonly instanceType: string;
  readonly maxConcurrentMeetings: number;
}

export interface PermissionConfig {
  /** Ambiguous or absent answers deny at this deadline. */
  readonly voiceApprovalTimeoutSec: number;
  /** Only one request is voiced at a time; the rest queue. */
  readonly maxQueuedRequests: number;
  /**
   * When an employee asks Lily out loud to do something on their own agent, that
   * spoken request is the approval for the action they named — no second prompt.
   * Anything the agent attempts beyond the named action still gates normally.
   */
  readonly selfRequestImpliesApproval: boolean;
}

export interface RetentionConfig {
  /** Task text and meeting summaries only. Configurable per org; this is the default. */
  readonly defaultDays: number;
  readonly minDays: number;
  readonly maxDays: number;
}

export interface AnalyticsConfig {
  readonly posthog: {
    readonly host: string;
    readonly enabled: boolean;
  };
  readonly ga4: {
    /** Never fires before consent. The tag is not even loaded until then. */
    readonly measurementId: string | null;
  };
  readonly consentPolicyVersion: string;
}

export interface LilyConfig {
  readonly stage: Stage;
  readonly serviceName: string;
  readonly region: string;
  readonly webBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly mongo: MongoConfig;
  readonly auth: AuthConfig;
  readonly realtime: RealtimeConfig;
  readonly meeting: MeetingConfig;
  readonly permissions: PermissionConfig;
  readonly retention: RetentionConfig;
  readonly analytics: AnalyticsConfig;
}

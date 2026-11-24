/**
 * Provider contracts.
 *
 * Each of these has exactly two implementations: one that runs entirely on a
 * developer machine (`local`) and one that talks to AWS (`dev` and `prod`).
 * Handlers depend on the interface only, so the same handler code path runs in
 * all three stages and `local` exercises real logic rather than mocks.
 */

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export interface SecretsProvider {
  /**
   * Resolve a secret by logical name. Implementations cache: Secrets Manager
   * calls are billed per request and Lambda containers are reused.
   *
   * Throws if the secret is absent. There is deliberately no default-value
   * overload — a missing credential must fail loudly at startup rather than
   * degrade into an unauthenticated call at request time.
   */
  get(secretName: string): Promise<string>;
  /** Drop cached values. Used after a rotation event. */
  invalidate(secretName?: string): void;
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export interface OutboundMail {
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string;
  /** Required, not optional. Every template ships a plain-text alternative. */
  readonly text: string;
  readonly replyTo?: string;
  /** Non-PII tags for deliverability analytics. Never carries meeting content. */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface MailProvider {
  send(mail: OutboundMail): Promise<{ messageId: string }>;
}

// ---------------------------------------------------------------------------
// WebSocket push
// ---------------------------------------------------------------------------

/**
 * `gone` means the connection no longer exists (API Gateway 410). Callers must
 * treat it as authoritative and delete the connectionId ↔ employee mapping;
 * leaving stale rows breaks presence and misroutes dispatches.
 */
export type PushResult = 'delivered' | 'gone';

export interface WsPusher {
  push(connectionId: string, payload: unknown): Promise<PushResult>;
  /** Force-close a live connection. Used on employee removal and token revocation. */
  disconnect(connectionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Orchestrator lifecycle
// ---------------------------------------------------------------------------

export interface MeetingLaunchSpec {
  readonly meetingId: string;
  readonly orgId: string;
  /**
   * `local` is the simulated room and needs no browser; `jitsi` is the
   * conflict-free real platform used for development. Both were added after the
   * original SDK-oriented list, when joining moved to a real browser.
   */
  readonly platform: 'local' | 'jitsi' | 'zoom' | 'meet' | 'teams';
  readonly meetingUrl: string;
  /**
   * Signed, single-use, short-TTL. The instance exchanges this for its real
   * runtime credentials — the meeting URL and participant roster are never
   * baked into the AMI or passed as plaintext user-data.
   */
  readonly bootstrapToken: string;
  readonly maxDurationSec: number;
}

export interface LaunchedOrchestrator {
  /** EC2 instance id in deployed stages; a pid-bearing handle locally. */
  readonly handle: string;
  readonly launchedAt: Date;
}

export interface OrchestratorLauncher {
  launch(spec: MeetingLaunchSpec): Promise<LaunchedOrchestrator>;
  /** Idempotent: terminating an already-gone orchestrator is not an error. */
  terminate(handle: string): Promise<void>;
  isRunning(handle: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export interface Providers {
  readonly secrets: SecretsProvider;
  readonly mail: MailProvider;
  readonly ws: WsPusher;
  readonly orchestrator: OrchestratorLauncher;
}

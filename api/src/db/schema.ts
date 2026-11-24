/**
 * MongoDB document shapes.
 *
 * ============================================================================
 * DATA POLICY
 * ============================================================================
 * This database stores only what is needed to route work and to bill. It never
 * stores company content.
 *
 * Persisted:  org/user records, hashed tokens, meeting *metadata*, short task
 *             text, audit entries, billing state, promotions, consent records.
 * Never:      meeting audio or video, full transcripts, source code, file
 *             contents, raw agent output, repo contents, or credentials to any
 *             employee system.
 *
 * Task text and the end-of-meeting summary are the only derived content here,
 * and only because the summary email and dashboard cannot exist without them.
 * Both are subject to per-org retention (default 90 days) and hard deletion.
 *
 * Two mechanisms defend this beyond convention:
 *   1. An ESLint rule rejects field names like `transcript` / `sourceCode`
 *      (see eslint.config.js).
 *   2. `assertNoForbiddenContent()` scans documents at write time
 *      (see ./data-policy.ts).
 * Neither is a substitute for reading this header before adding a field.
 * ============================================================================
 */

import type { ObjectId } from 'mongodb';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type Role = 'owner' | 'admin' | 'manager' | 'employee';

/** Roles that can act on the org rather than merely participate in meetings. */
export const PRIVILEGED_ROLES: readonly Role[] = ['owner', 'admin', 'manager'];

export type UserStatus = 'invited' | 'active' | 'suspended' | 'removed';

export type Platform = 'zoom' | 'meet' | 'teams';

export type PlanId = 'test' | 'team' | 'scale';

export interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Marks a document that is subject to per-org retention. A TTL-driven sweeper
 * and the hard-delete endpoint both key off this field, so anything carrying
 * derived meeting content must declare it.
 */
export interface Retainable {
  /** Set from org.retention.days at write time. Null means "keep until deleted". */
  purgeAfter: Date | null;
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export interface UtmAttribution {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  gclid: string | null;
  fbclid: string | null;
  referrer: string | null;
  landingPath: string | null;
  capturedAt: Date;
}

export interface OrgBilling {
  plan: PlanId;
  /** Lily tokens granted for the current cycle. Sourced from plan config, copied
   *  here so a plan config change never retroactively alters a live cycle. */
  tokenAllowance: number;
  tokensUsedCycle: number;
  /** Purchased packs. Never expire; consumed only after the allowance runs out. */
  topupBalance: number;
  cycleResetsAt: Date | null;
  status: 'active' | 'past_due' | 'cancelled' | 'grace';
  lemonSqueezyCustomerId: string | null;
  lemonSqueezySubscriptionId: string | null;
  /** Off by default, per the brief. Ceiling is the customer's own limit. */
  autoTopup: { enabled: boolean; packSize: number; monthlyCeilingCents: number } | null;
  gracePeriodEndsAt: Date | null;
}

export interface OrgSettings {
  /** 'always' listening vs 'name_only'. */
  listeningMode: 'always' | 'name_only';
  /** Device token rotation interval, seconds. */
  deviceTokenRotationSec: number;
  /** Per-role overrides of the default permission tiers. */
  permissionPolicyByRole: Record<string, { gatedAllowed: boolean }>;
  /** Whether admins may see task text, or only the owning employee and managers. */
  taskVisibility: 'org' | 'owner_and_managers';
}

export interface OrgConsentNotice {
  /** Acknowledged in the dashboard when scheduling a meeting. Jurisdictions
   *  differ on AI participation and recording, so acknowledgement is logged. */
  acknowledgedByUserId: ObjectId;
  acknowledgedAt: Date;
  policyVersion: string;
}

export interface OrgDoc extends Timestamps {
  _id: ObjectId;
  name: string;
  /** Free-text size bucket captured at signup, e.g. "2-10". Not headcount truth. */
  sizeBucket: string | null;
  ownerUserId: ObjectId;
  adminUserIds: ObjectId[];
  billing: OrgBilling;
  settings: OrgSettings;
  retention: { days: number };
  /** First touch is immutable once written; last touch is overwritten each visit. */
  attribution: { firstTouch: UtmAttribution | null; lastTouch: UtmAttribution | null };
  consentNotice: OrgConsentNotice | null;
  /** Enterprise SSO. Present so password-only assumptions don't calcify. */
  sso: { enforced: boolean; provider: 'saml' | 'oidc' | null; domain: string | null } | null;
  deletedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface UserMfa {
  /** Server-enforced. Privileged roles cannot reach the dashboard without this. */
  enrolled: boolean;
  totpSecretEncrypted: string | null;
  /** Hashed, single-use. Shown once at enrollment and never again. */
  backupCodeHashes: string[];
  enrolledAt: Date | null;
  lastVerifiedAt: Date | null;
}

export interface UserDoc extends Timestamps {
  _id: ObjectId;
  orgId: ObjectId;
  /** Stable public identifier used for routing. Distinct from _id so it can
   *  appear in logs and Lily's context without exposing a database key. */
  employeeId: string;
  email: string;
  emailNormalized: string;
  emailVerifiedAt: Date | null;
  name: string;
  role: Role;
  /**
   * "What they do at the company", free text from the invite modal.
   * Fed into Lily's system context so she can route a question to the right
   * person without being told. This is org-authored description, not meeting
   * content, and is therefore in policy.
   */
  jobDescription: string;
  status: UserStatus;

  /** Argon2id. Null for SSO-only or invite-pending users. */
  passwordHash: string | null;
  mfa: UserMfa;

  /**
   * Email verification challenge. Hashed with the same peppered SHA-256 as every
   * other opaque token here — the raw code exists only in the message that was
   * sent. Cleared on success, so a verified account carries no live challenge.
   *
   * Named `emailVerificationHash` rather than anything containing `code`: that
   * word is on the forbidden-field list in ./data-policy.ts, and rightly so.
   */
  emailVerificationHash: string | null;
  emailVerificationExpiresAt: Date | null;

  /** Employee chose to enroll a daemon. Enrollment is opt-in per the product
   *  decision; an admin cannot force this to true. */
  daemonEnrolled: boolean;
  /**
   * Names only — agent kind plus the MCP servers/tools their agent exposes,
   * e.g. ['google-calendar', 'github']. Lily uses this to know what she can
   * ask of whom. Never the contents of anything those tools can reach.
   */
  agentKind: string | null;
  agentCapabilities: string[];

  /** Optional voice profile for diarization, stored as an embedding, not audio. */
  voiceProfileVector: number[] | null;

  lastSeenAt: Date | null;
  removedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Tokens & sessions
// ---------------------------------------------------------------------------

/**
 * Daemon device tokens. Only the hash is stored — the raw token exists exactly
 * once, in the response that issues it, and never touches a log or this database.
 */
export interface DaemonTokenDoc extends Timestamps {
  _id: ObjectId;
  orgId: ObjectId;
  userId: ObjectId;
  employeeId: string;
  /** SHA-256 over (token || KMS-managed pepper). */
  tokenHash: string;
  /** Rotation chain, so a superseded token can be recognised rather than merely absent. */
  previousTokenHash: string | null;
  rotatesAt: Date;
  revokedAt: Date | null;
  revokedReason: 'rotation' | 'employee_removed' | 'admin_revoke' | 'reuse_detected' | null;
  lastUsedAt: Date | null;
  deviceFingerprint: string | null;
}

/**
 * Refresh tokens, tracked as families for reuse detection.
 *
 * A replayed token means the family is compromised — a legitimate client never
 * presents a rotated-away token twice. The whole family is revoked rather than
 * just the replayed member, because the attacker and the victim are
 * indistinguishable at that point.
 */
export interface RefreshTokenDoc extends Timestamps {
  _id: ObjectId;
  userId: ObjectId;
  orgId: ObjectId;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  /** Set when this token is exchanged. A second use of a consumed token
   *  triggers family revocation. */
  consumedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: 'rotated' | 'reuse_detected' | 'logout' | 'admin_revoke' | null;
  deviceFingerprint: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionDoc extends Timestamps {
  _id: ObjectId;
  userId: ObjectId;
  orgId: ObjectId;
  familyId: string;
  deviceFingerprint: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Approximate, for "new location" alerting only. Never street-level. */
  geoCountry: string | null;
  lastActiveAt: Date;
  absoluteExpiresAt: Date;
  /** Most recent successful MFA challenge, for step-up grace. */
  mfaVerifiedAt: Date | null;
  revokedAt: Date | null;
}

export interface WebAuthnCredentialDoc extends Timestamps {
  _id: ObjectId;
  userId: ObjectId;
  credentialId: string;
  publicKey: string;
  /** Replay defence: must be strictly increasing for authenticators that report it. */
  counter: number;
  transports: string[];
  deviceLabel: string | null;
  lastUsedAt: Date | null;
}

/** Single-use, token-bound install links from the invite email. */
export interface InstallTokenDoc extends Timestamps {
  _id: ObjectId;
  orgId: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  /** Campaign params so activation can be attributed to the channel that produced it. */
  utm: Pick<UtmAttribution, 'source' | 'medium' | 'campaign'> | null;
}

// ---------------------------------------------------------------------------
// Live connections
// ---------------------------------------------------------------------------

/**
 * connectionId ↔ employee mapping for the WebSocket API.
 *
 * Deleted on `$disconnect`, on a 410 from a push, and on employee removal —
 * the last of which must land within seconds, since a stale row is exactly how
 * a removed employee would keep receiving dispatches.
 */
export interface ConnectionDoc {
  _id: string; // connectionId
  orgId: ObjectId;
  userId: ObjectId;
  employeeId: string;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  /** Employee-controlled Do Not Disturb. Admins cannot override it. */
  dnd: boolean;
  agentKind: string | null;
  agentCapabilities: string[];
  /** TTL index target — a container that dies without $disconnect still expires. */
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Meetings & tasks
// ---------------------------------------------------------------------------

export type MeetingStatus =
  | 'launching'
  | 'joining'
  | 'live'
  | 'ending'
  | 'completed'
  | 'failed';

export interface MeetingDoc extends Timestamps, Retainable {
  _id: ObjectId;
  orgId: ObjectId;
  platform: Platform;
  /**
   * Deliberately absent: meetingUrl. The join URL is a credential — anyone
   * holding it can enter the call. It is passed to the orchestrator through a
   * signed single-use payload and never persisted.
   */
  title: string | null;
  status: MeetingStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSec: number | null;
  /** Participant user ids. Names are resolved by join, not duplicated here. */
  participantUserIds: ObjectId[];
  /** Non-employee attendees, counted but not identified. */
  externalParticipantCount: number;
  orchestratorHandle: string | null;
  /** Lily tokens consumed. Only her own runtime — never employee agent usage. */
  tokensConsumed: number;
  costCents: number | null;
  /**
   * The narrative end-of-meeting summary. One of only two pieces of derived
   * content in this database, retained because the summary email and the
   * meeting detail view both depend on it.
   */
  summary: string | null;
  decisions: string[];
  startedByUserId: ObjectId;
  failureReason: string | null;
}

export type TaskType = 'lily_action' | 'human_assignment';
export type TaskStatus = 'unconfirmed' | 'confirmed' | 'in_progress' | 'done' | 'cancelled';

export interface TaskDoc extends Timestamps, Retainable {
  _id: ObjectId;
  orgId: ObjectId;
  meetingId: ObjectId | null;
  /** Short task text. The second and last piece of derived content stored. */
  text: string;
  ownerEmployeeId: string;
  ownerUserId: ObjectId | null;
  assignedByUserId: ObjectId | null;
  due: Date | null;
  status: TaskStatus;
  type: TaskType;
  /**
   * Deliberately absent: the agent's output. A dispatched task's result passes
   * through Lily transiently and is spoken in the meeting; it is never written
   * here. Only whether it succeeded is recorded.
   */
  dispatchOutcome: 'not_dispatched' | 'succeeded' | 'failed' | 'timed_out';
  confirmedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'permission.granted'
  | 'permission.denied'
  | 'permission.timed_out'
  | 'task.dispatched'
  | 'employee.invited'
  | 'employee.removed'
  | 'token.rotated'
  | 'token.reuse_detected'
  | 'policy.changed'
  | 'billing.changed'
  | 'audit.exported'
  | 'install_token.issued'
  | 'meeting.started'
  | 'meeting.ended'
  | 'data.hard_deleted';

export interface AuditLogDoc {
  _id: ObjectId;
  orgId: ObjectId;
  action: AuditAction;
  /** Who did it. Null only for system-initiated actions such as a timeout. */
  actorUserId: ObjectId | null;
  subjectUserId: ObjectId | null;
  meetingId: ObjectId | null;
  /** Human-readable description of exactly what was approved or changed —
   *  e.g. "run `npm test`". Deliberately the command, never its output. */
  detail: string;
  ip: string | null;
  at: Date;
  /** Audit entries outlive task/meeting retention: they are the compliance
   *  record of who authorised what, and are excluded from the retention sweep. */
}

// ---------------------------------------------------------------------------
// Billing, promotions, consent, usage
// ---------------------------------------------------------------------------

export interface UsageEventDoc {
  _id: ObjectId;
  orgId: ObjectId;
  meetingId: ObjectId;
  at: Date;
  /** Normalised Lily tokens for this slice. */
  tokens: number;
  /** Kept for margin analysis — which meter drove the cost. */
  breakdown: {
    realtimeAudioSec: number;
    ec2Sec: number;
    ttsChars: number;
    searchCalls: number;
    reasoningTokens: number;
  };
  /** Periodic flush during long meetings, so a crash loses at most one interval. */
  final: boolean;
}

export type PromotionType = 'percent' | 'fixed' | 'extra_tokens' | 'extended_trial';

export interface PromotionDoc extends Timestamps {
  _id: ObjectId;
  code: string;
  type: PromotionType;
  value: number;
  applicablePlans: PlanId[];
  maxRedemptions: number | null;
  perCustomerLimit: number;
  validFrom: Date;
  validUntil: Date;
  stackable: boolean;
  /** Which staged trigger surfaces this offer. */
  trigger:
    | 'exit_intent'
    | 'no_team_24h'
    | 'no_meeting_48h'
    | 'first_meeting_done'
    | 'trial_ending'
    | 'cancelled'
    | 'manual';
  lemonSqueezyDiscountId: string | null;
  active: boolean;
  redemptionCount: number;
}

export interface RedemptionDoc {
  _id: ObjectId;
  promotionId: ObjectId;
  orgId: ObjectId;
  redeemedAt: Date;
  /** Cents of discount actually applied, for revenue-impact reporting. */
  valueAppliedCents: number;
}

export interface ConsentDoc {
  _id: ObjectId;
  /** Null before signup — consent is captured on first visit, pre-account. */
  orgId: ObjectId | null;
  anonymousId: string;
  categories: { necessary: true; analytics: boolean; marketing: boolean };
  policyVersion: string;
  at: Date;
  ip: string | null;
}

/** One active offer per customer at a time; declines are counted so we stop asking. */
export interface OfferStateDoc extends Timestamps {
  _id: ObjectId;
  orgId: ObjectId;
  activePromotionId: ObjectId | null;
  activeUntil: Date | null;
  declineCount: number;
  lastOfferedAt: Date | null;
  suppressed: boolean;
}

/**
 * Wire types for the Lily REST API.
 *
 * These mirror api/src/db/schema.ts with two systematic substitutions: ObjectId
 * becomes string and Date becomes an ISO 8601 string, because that is what
 * survives JSON. They are declared here rather than imported from @lily/shared
 * on purpose — see the note in web/README.md — but the field names are kept
 * identical so a mismatch is a rename, not a silent semantic drift.
 *
 * The API does not exist yet. Everything below is written against the
 * documented endpoint list and served by the mock adapter until it does.
 *
 * `| null` is used throughout instead of optional properties. The repo enables
 * `exactOptionalPropertyTypes`, under which an absent key and an explicitly
 * undefined key are different types; a nullable required field sidesteps that
 * whole class of mistake at every call site.
 */

export type Role = 'owner' | 'admin' | 'manager' | 'employee';
export type UserStatus = 'invited' | 'active' | 'suspended' | 'removed';
/**
 * `jitsi` is open source and permits guests, so it is the platform to develop
 * against; `local` is the simulated room, which runs the full pipeline with no
 * browser and no real call. Both were added when joining moved from vendor SDKs
 * to driving the web client in a real browser.
 */
export type Platform = 'jitsi' | 'meet' | 'zoom' | 'teams' | 'local';
export type PlanId = 'test' | 'team' | 'scale';
export type MeetingStatus = 'launching' | 'joining' | 'live' | 'ending' | 'completed' | 'failed';
export type TaskStatus = 'unconfirmed' | 'confirmed' | 'in_progress' | 'done' | 'cancelled';
export type TaskType = 'lily_action' | 'human_assignment';
export type DispatchOutcome = 'not_dispatched' | 'succeeded' | 'failed' | 'timed_out';

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  orgId: string | null;
  employeeId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  role: Role;
  jobDescription: string;
  status: UserStatus;
  mfaEnrolled: boolean;
  daemonEnrolled: boolean;
  agentKind: string | null;
  agentCapabilities: string[];
}

export interface Org {
  id: string;
  name: string;
  sizeBucket: string | null;
  plan: PlanId;
  tokenAllowance: number;
  tokensUsedCycle: number;
  topupBalance: number;
  retentionDays: number;
  memberCount: number;
}

export interface Meeting {
  id: string;
  orgId: string;
  platform: Platform;
  title: string | null;
  status: MeetingStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  participantUserIds: string[];
  externalParticipantCount: number;
  /** Lily's own runtime only. An employee's agent usage is never counted here. */
  tokensConsumed: number;
  summary: string | null;
  decisions: string[];
}

export interface Task {
  id: string;
  orgId: string;
  meetingId: string | null;
  text: string;
  ownerEmployeeId: string;
  ownerUserId: string | null;
  due: string | null;
  status: TaskStatus;
  type: TaskType;
  dispatchOutcome: DispatchOutcome;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthTokens {
  accessToken: string;
  /** Seconds. The API pins this at 15 minutes; the client re-reads it anyway. */
  expiresInSec: number;
  refreshToken: string;
}

export interface AuthSession {
  tokens: AuthTokens;
  user: User;
  /** Null until the user has created or joined an org. */
  org: Org | null;
}

export interface SignupRequest {
  email: string;
  password: string;
  name: string;
  /** 'google' arrives with an OAuth authorization code instead of a password. */
  provider: 'password' | 'google';
  googleAuthCode: string | null;
  attribution: AttributionPayload | null;
}

/**
 * Structurally identical to `Attribution` in lib/attribution/utm.ts, declared
 * here so the API surface owns its own contract. `capturedAt` is an ISO string;
 * the server turns it into the Date that UtmAttribution expects.
 */
export interface AttributionTouch {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  gclid: string | null;
  fbclid: string | null;
  referrer: string | null;
  landingPath: string | null;
  capturedAt: string;
}

export interface AttributionPayload {
  firstTouch: AttributionTouch | null;
  lastTouch: AttributionTouch | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

/**
 * Not in the documented endpoint list, but the signup flow specified for the web
 * app cannot exist without it. Implemented in the mock and left here so the
 * contract is visible to whoever builds /auth for real.
 */
export interface VerifyEmailRequest {
  email: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Orgs
// ---------------------------------------------------------------------------

export interface CreateOrgRequest {
  name: string;
  sizeBucket: string;
  attribution: AttributionPayload | null;
}

export interface InviteRequest {
  email: string;
  name: string;
  role: Role;
  /** Fed to Lily so she can route a question without being told who owns what. */
  jobDescription: string;
}

export interface Invite {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  invitedAt: string;
}

// ---------------------------------------------------------------------------
// Meetings & tasks
// ---------------------------------------------------------------------------

export interface CreateMeetingRequest {
  platform: Platform;
  /**
   * The join URL is a credential — anyone holding it can enter the call. It is
   * sent once, exchanged for a signed single-use payload server-side, and never
   * persisted (see the comment on MeetingDoc). It must not be logged here either.
   */
  joinUrl: string;
  title: string | null;
}

export interface ListTasksQuery {
  meetingId: string | null;
  status: TaskStatus | null;
  limit: number | null;
}

// ---------------------------------------------------------------------------
// Dashboard: team
// ---------------------------------------------------------------------------

/**
 * A row in the team table.
 *
 * `daemonOnline` / `lastSeenAt` are the REST view of presence — what the server
 * knew when the request was served. The WebSocket refines it live; this is what
 * the table falls back to when the socket is down, and why the UI always renders
 * presence with the timestamp it was true at rather than as a bare badge.
 */
export interface TeamMember {
  id: string;
  employeeId: string;
  name: string;
  email: string;
  role: Role;
  jobDescription: string;
  status: UserStatus;
  daemonEnrolled: boolean;
  mfaEnrolled: boolean;
  agentKind: string | null;
  agentCapabilities: string[];
  daemonOnline: boolean;
  lastSeenAt: string | null;
  invitedAt: string | null;
}

export interface BulkInviteRow extends InviteRequest {
  /** 1-based line in the uploaded file, so an error points at a row a human can find. */
  line: number;
}

export interface BulkInviteFailure {
  line: number;
  email: string;
  message: string;
}

export interface BulkInviteResult {
  invited: Invite[];
  failed: BulkInviteFailure[];
}

// ---------------------------------------------------------------------------
// Dashboard: meetings
// ---------------------------------------------------------------------------

export interface ListMeetingsQuery {
  /** 'upcoming' is everything not yet completed or failed. */
  window: 'upcoming' | 'past' | 'all';
  limit: number | null;
}

export interface MeetingParticipant {
  userId: string;
  employeeId: string;
  name: string;
  role: Role;
  daemonEnrolled: boolean;
}

/**
 * Mirrors `ActionKind` in packages/shared/src/protocol. Declared here for the
 * same reason the entity types are — the browser bundle does not take a
 * dependency on a NodeNext package that pulls in the AWS SDK.
 */
export type ActionKind =
  | 'read'
  | 'search'
  | 'vcs_read'
  | 'write'
  | 'shell'
  | 'test'
  | 'install'
  | 'network'
  | 'vcs_push_protected'
  | 'delete'
  | 'deploy'
  | 'credential_access';

export type PermissionDecision = 'granted' | 'denied' | 'timed_out' | 'hard_blocked';

/**
 * One permission decision inside a meeting.
 *
 * `detail` is the command that was asked for — "run `npm test`" — and never its
 * output. That distinction is the data policy, not a presentation choice.
 *
 * `kind` is nullable because the API stores these as `audit_log` rows, which have
 * a `detail` column and no `kind` column. The API writes and parses a
 * `"<kind>: <command>"` convention so the category usually survives; an entry
 * that predates the convention reports null rather than a guessed category, and
 * the table renders that as an em dash.
 */
export interface PermissionEvent {
  id: string;
  meetingId: string;
  taskId: string | null;
  employeeId: string;
  kind: ActionKind | null;
  detail: string;
  decision: PermissionDecision;
  at: string;
}

export interface MeetingDetail {
  meeting: Meeting;
  participants: MeetingParticipant[];
  tasks: Task[];
  permissions: PermissionEvent[];
}

// ---------------------------------------------------------------------------
// Dashboard: tasks
// ---------------------------------------------------------------------------

export interface OrgTasksQuery {
  ownerEmployeeId: string | null;
  status: TaskStatus | null;
  /** Inclusive ISO dates bounding `due`. */
  dueFrom: string | null;
  dueTo: string | null;
  limit: number | null;
}

// ---------------------------------------------------------------------------
// Dashboard: settings
// ---------------------------------------------------------------------------

export interface RolePermissionPolicy {
  role: Role;
  /** Whether this role's agents may be asked for gated actions at all. */
  gatedAllowed: boolean;
}

export interface ConnectedPlatform {
  platform: Platform;
  label: string;
  connected: boolean;
  connectedAt: string | null;
}

export interface ConsentNoticeState {
  policyVersion: string;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
}

export interface OrgSettings {
  listeningMode: 'always' | 'name_only';
  /** Device token rotation interval, seconds. */
  deviceTokenRotationSec: number;
  /** An array rather than a Record so `noUncheckedIndexedAccess` does not turn
   *  every read into a null check at the call site. */
  permissionPolicyByRole: RolePermissionPolicy[];
  taskVisibility: 'org' | 'owner_and_managers';
  retentionDays: number;
  consentNotice: ConsentNoticeState;
  connectedPlatforms: ConnectedPlatform[];
}

export interface UpdateOrgSettingsRequest {
  listeningMode: 'always' | 'name_only';
  deviceTokenRotationSec: number;
  permissionPolicyByRole: RolePermissionPolicy[];
  taskVisibility: 'org' | 'owner_and_managers';
  retentionDays: number;
}

// ---------------------------------------------------------------------------
// Dashboard: audit
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

export interface AuditEntry {
  id: string;
  action: AuditAction;
  /** Null for system-initiated actions such as a permission timeout. */
  actorName: string | null;
  subjectName: string | null;
  meetingId: string | null;
  detail: string;
  ip: string | null;
  at: string;
}

export interface AuditQuery {
  search: string | null;
  action: AuditAction | null;
  from: string | null;
  to: string | null;
  limit: number | null;
  cursor: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextCursor: string | null;
  total: number;
}

// ---------------------------------------------------------------------------
// MFA
// ---------------------------------------------------------------------------

/**
 * TOTP enrollment material. Returned once, never re-readable.
 *
 * WebAuthn is the intended second factor and the API has a credential
 * collection for it, but no enrollment endpoint yet — see lib/auth/passkeys.ts
 * for the seam. TOTP plus backup codes is what exists, so it is what the gate
 * enrolls against.
 */
export interface MfaEnrollmentStart {
  /** Base32, grouped for manual entry into an authenticator app. */
  secret: string;
  otpauthUri: string;
  issuer: string;
  account: string;
}

export interface MfaEnrollmentResult {
  /** Single-use. Shown exactly once, at this moment, and never again. */
  backupCodes: string[];
  enrolledAt: string;
}

/**
 * The result of re-proving identity for an administrative action.
 *
 * Step-up is a distinct thing from enrolment: holding a session is enough to use
 * the product and is not enough to change who can use it. The API refuses every
 * gated action with `step_up_required` until this succeeds, then allows them for
 * a short grace window.
 */
export interface StepUpResult {
  verifiedAt: string;
  /** When the grace lapses and the next gated action asks again. */
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Owner analytics
// ---------------------------------------------------------------------------

export type AnalyticsGrain = 'day' | 'week' | 'month';

export interface AnalyticsQuery {
  grain: AnalyticsGrain;
  /** Number of periods back from now. */
  periods: number;
}

export interface AcquisitionSeriesPoint {
  /** ISO date for 'day', ISO date of the week start for 'week', 'YYYY-MM' for 'month'. */
  period: string;
  signups: number;
  /** First meeting actually run. The only activation definition used anywhere. */
  activations: number;
  paidConversions: number;
}

export interface FunnelStage {
  id: string;
  label: string;
  count: number;
}

export interface RevenueSummary {
  mrrCents: number;
  arrCents: number;
  arpuCents: number;
  /** Logo churn over the trailing period, as a percentage. */
  churnRatePct: number;
  /** Top-up revenue above subscription, the only expansion motion that exists. */
  expansionCents: number;
  paidOrgs: number;
  trialOrgs: number;
}

/**
 * The number the $20 tier lives or dies by. Revenue is the subscription revenue
 * attributable to the period; cost is metered Lily runtime only.
 */
export interface MarginRow {
  period: string;
  meetings: number;
  tokens: number;
  revenueCents: number;
  costCents: number;
  grossMarginPct: number;
  costPerMeetingCents: number;
  revenuePerMeetingCents: number;
}

export interface AcquisitionRow {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  visits: number;
  signups: number;
  paid: number;
}

export interface DiscountRow {
  code: string;
  redemptions: number;
  discountCents: number;
  /** Revenue from orgs that redeemed this code, so a code's cost has a counterweight. */
  attributedRevenueCents: number;
}

/**
 * A figure the server could not derive from a real collection.
 *
 * It exists so the API never has to choose between returning a plausible-looking
 * number it invented and omitting a field the type requires. A zero next to an
 * entry here means "not measured", not "none" — and the screen says so rather
 * than letting someone make a pricing decision on a fabricated cost.
 */
export interface UnavailableFigure {
  /** Dotted path into this response, e.g. 'margin.costCents'. */
  field: string;
  reason: string;
}

export interface OwnerAnalytics {
  grain: AnalyticsGrain;
  generatedAt: string;
  series: AcquisitionSeriesPoint[];
  funnel: FunnelStage[];
  revenue: RevenueSummary;
  margin: MarginRow[];
  acquisition: AcquisitionRow[];
  discounts: DiscountRow[];
  unavailable: UnavailableFigure[];
}

/** Right now, across every org. Polled, and refreshed by the socket when it is up. */
export interface LiveSnapshot {
  at: string;
  meetingsRunning: number;
  orgsOnline: number;
  daemonsConnected: number;
  tasksInFlight: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'invalid_credentials'
  | 'email_taken'
  | 'email_not_verified'
  | 'invalid_code'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'network'
  | 'server_error'
  // The API answers these on any administrative action; declaring them means the
  // step-up interceptor in ./http.ts can match on a code rather than a message.
  | 'step_up_required'
  | 'mfa_enrollment_required'
  | 'conflict'
  | 'gone';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Field-level messages, keyed by form field name, for inline display. */
  readonly fields: Readonly<Record<string, string>>;

  constructor(
    code: ApiErrorCode,
    message: string,
    status = 0,
    fields: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

// ---------------------------------------------------------------------------
// The client contract
// ---------------------------------------------------------------------------

/**
 * Both adapters implement this. The UI depends on the interface only, so
 * swapping mock for http is a one-line change in ./index.ts and touches no
 * component.
 */
export interface LilyApi {
  signup(body: SignupRequest): Promise<{ user: User; verificationRequired: boolean }>;
  verifyEmail(body: VerifyEmailRequest): Promise<AuthSession>;
  resendVerification(email: string): Promise<void>;
  login(body: LoginRequest): Promise<AuthSession>;
  refresh(body: RefreshRequest): Promise<AuthTokens>;

  createOrg(body: CreateOrgRequest): Promise<Org>;
  invite(orgId: string, body: InviteRequest): Promise<Invite>;
  listInvites(orgId: string): Promise<Invite[]>;
  getEmployee(orgId: string, employeeId: string): Promise<User>;
  removeEmployee(orgId: string, employeeId: string): Promise<void>;

  createMeeting(body: CreateMeetingRequest): Promise<Meeting>;
  getMeeting(meetingId: string): Promise<Meeting>;
  endMeeting(meetingId: string): Promise<Meeting>;

  listTasks(query: ListTasksQuery): Promise<Task[]>;

  // --- dashboard ----------------------------------------------------------
  listTeam(orgId: string): Promise<TeamMember[]>;
  bulkInvite(orgId: string, rows: BulkInviteRow[]): Promise<BulkInviteResult>;

  listMeetings(orgId: string, query: ListMeetingsQuery): Promise<Meeting[]>;
  getMeetingDetail(meetingId: string): Promise<MeetingDetail>;

  listOrgTasks(orgId: string, query: OrgTasksQuery): Promise<Task[]>;

  getOrgSettings(orgId: string): Promise<OrgSettings>;
  updateOrgSettings(orgId: string, body: UpdateOrgSettingsRequest): Promise<OrgSettings>;
  acknowledgeConsentNotice(orgId: string): Promise<OrgSettings>;

  listAudit(orgId: string, query: AuditQuery): Promise<AuditPage>;
  /** Returns CSV text. The download is assembled in the browser from this. */
  exportAudit(orgId: string, query: AuditQuery): Promise<string>;

  // --- MFA ----------------------------------------------------------------
  startMfaEnrollment(): Promise<MfaEnrollmentStart>;
  confirmMfaEnrollment(code: string): Promise<MfaEnrollmentResult>;
  /** A TOTP code or a backup code. Satisfies the gate on administrative actions. */
  verifyStepUp(code: string): Promise<StepUpResult>;

  // --- owner only ---------------------------------------------------------
  getOwnerAnalytics(query: AnalyticsQuery): Promise<OwnerAnalytics>;
  getLiveSnapshot(): Promise<LiveSnapshot>;
}

import { PLANS } from '@/config/plans';
import {
  buildAnalytics,
  buildAudit,
  buildMeetings,
  buildPermissions,
  buildSettings,
  buildTasks,
  buildTeam,
  DEMO_LOGINS,
  DEMO_ORG_ID,
  DEMO_PASSWORD,
} from './fixtures';
import {
  ApiError,
  type AnalyticsQuery,
  type AuditEntry,
  type AuditPage,
  type AuditQuery,
  type AuthSession,
  type AuthTokens,
  type BulkInviteFailure,
  type BulkInviteRow,
  type CreateMeetingRequest,
  type CreateOrgRequest,
  type Invite,
  type InviteRequest,
  type LilyApi,
  type ListMeetingsQuery,
  type ListTasksQuery,
  type LiveSnapshot,
  type LoginRequest,
  type Meeting,
  type MeetingDetail,
  type MeetingParticipant,
  type MfaEnrollmentResult,
  type MfaEnrollmentStart,
  type Org,
  type OrgSettings,
  type OrgTasksQuery,
  type OwnerAnalytics,
  type PermissionEvent,
  type RefreshRequest,
  type SignupRequest,
  type StepUpResult,
  type Task,
  type TeamMember,
  type UpdateOrgSettingsRequest,
  type User,
  type VerifyEmailRequest,
} from './types';

/**
 * In-memory adapter so the whole UI is demoable before the API exists.
 *
 * It models the states the UI has to handle rather than being a happy path:
 * duplicate email, wrong verification code, unverified login, an unknown
 * employee. Data lives in module scope and resets on reload, which is the right
 * behaviour for a demo — there is no fake persistence to get out of sync.
 */

const VERIFICATION_CODE = '123456'; // Shown in the UI in mock mode; see VerifyEmail.

const users = new Map<string, User>(); // keyed by normalised email
const passwords = new Map<string, string>();
const verified = new Set<string>();
const orgs = new Map<string, Org>();
const invitesByOrg = new Map<string, Invite[]>();
const meetings = new Map<string, Meeting>();
let tasks: Task[] = [];

// --- dashboard state -------------------------------------------------------
let team: TeamMember[] = [];
let permissions: PermissionEvent[] = [];
let auditEntries: AuditEntry[] = [];
let settings: OrgSettings = buildSettings();
/**
 * Who the mock believes is calling.
 *
 * The real API reads this from the bearer token. Tracking it here is what lets
 * the mock refuse a request the way the API will — an employee asking for the
 * team list gets a 403, not a filtered list — so the UI is exercised against
 * the failure rather than assuming it cannot happen.
 */
let currentEmail: string | null = null;

let sequence = 0;
function id(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence.toString().padStart(6, '0')}`;
}

function normalise(email: string): string {
  return email.trim().toLowerCase();
}

/** Enough latency that spinners and disabled states are actually exercised. */
function delay<T>(value: T, ms = 420): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function tokens(): AuthTokens {
  return { accessToken: id('at'), expiresInSec: 15 * 60, refreshToken: id('rt') };
}

function sessionFor(user: User): AuthSession {
  const org = user.orgId === null ? null : (orgs.get(user.orgId) ?? null);
  currentEmail = normalise(user.email);
  return { tokens: tokens(), user, org };
}

// ---------------------------------------------------------------------------
// Demo seed
// ---------------------------------------------------------------------------

/**
 * A populated org so the dashboard is reachable without clicking through signup.
 *
 * Seeded at module load rather than behind a flag: the mock adapter only loads
 * at all when `VITE_LILY_API_MODE` is `mock`, so there is no build in which this
 * data can reach a screen pointed at a real API.
 */
function seedDemoOrg(): void {
  const plan = PLANS[1];
  orgs.set(DEMO_ORG_ID, {
    id: DEMO_ORG_ID,
    name: 'Northwind Labs',
    sizeBucket: '11-50',
    plan: 'team',
    tokenAllowance: plan?.tokenAllowance ?? 2_000_000,
    tokensUsedCycle: 731_400,
    topupBalance: 250_000,
    retentionDays: 90,
    memberCount: 9,
  });

  team = buildTeam();
  permissions = buildPermissions();
  auditEntries = buildAudit();
  settings = buildSettings();
  tasks = buildTasks();
  for (const meeting of buildMeetings()) meetings.set(meeting.id, meeting);

  for (const login of DEMO_LOGINS) {
    const member = team.find((row) => row.employeeId === login.employeeId);
    if (member === undefined) continue;
    const email = normalise(member.email);
    users.set(email, {
      id: member.id,
      orgId: DEMO_ORG_ID,
      employeeId: member.employeeId,
      email: member.email,
      emailVerified: true,
      name: member.name,
      role: member.role,
      jobDescription: member.jobDescription,
      status: 'active',
      mfaEnrolled: member.mfaEnrolled,
      daemonEnrolled: member.daemonEnrolled,
      agentKind: member.agentKind,
      agentCapabilities: [...member.agentCapabilities],
    });
    passwords.set(email, DEMO_PASSWORD);
    verified.add(email);
  }
}

seedDemoOrg();

// ---------------------------------------------------------------------------
// Authorisation, modelled rather than assumed
// ---------------------------------------------------------------------------

function callerOrNull(): User | null {
  return currentEmail === null ? null : (users.get(currentEmail) ?? null);
}

/** 401 when there is no session at all. */
function caller(): User {
  const user = callerOrNull();
  if (user === null) throw new ApiError('unauthorized', 'Sign in again.', 401);
  return user;
}

const PRIVILEGED = new Set(['owner', 'admin', 'manager']);

function requireManager(): User {
  const user = caller();
  if (!PRIVILEGED.has(user.role)) {
    throw new ApiError('forbidden', 'Your account does not have access to this.', 403);
  }
  return user;
}

function requireOwner(): User {
  const user = caller();
  if (user.role !== 'owner') {
    throw new ApiError('forbidden', 'Owner access only.', 403);
  }
  return user;
}

function requireOrg(orgId: string): void {
  const user = caller();
  if (user.orgId !== orgId) {
    throw new ApiError('forbidden', 'That organization is not yours.', 403);
  }
}

export const mockApi: LilyApi = {
  async signup(body: SignupRequest) {
    const email = normalise(body.email);
    if (users.has(email)) {
      throw new ApiError('email_taken', 'That email already has an account.', 409, {
        email: 'An account with this email already exists.',
      });
    }
    if (body.provider === 'password' && body.password.length < 12) {
      throw new ApiError('validation_failed', 'Password is too short.', 400, {
        password: 'Use at least 12 characters.',
      });
    }

    const user: User = {
      id: id('usr'),
      orgId: null,
      employeeId: id('emp'),
      email: body.email,
      emailVerified: false,
      name: body.name,
      role: 'owner',
      jobDescription: '',
      status: 'invited',
      mfaEnrolled: false,
      daemonEnrolled: false,
      agentKind: null,
      agentCapabilities: [],
    };
    users.set(email, user);
    if (body.provider === 'password') passwords.set(email, body.password);

    // Google has already proven the address, so that path skips verification —
    // the same rule the real API should apply.
    if (body.provider === 'google') {
      verified.add(email);
      const confirmed: User = { ...user, emailVerified: true, status: 'active' };
      users.set(email, confirmed);
      return delay({ user: confirmed, verificationRequired: false });
    }

    return delay({ user, verificationRequired: true });
  },

  async verifyEmail(body: VerifyEmailRequest) {
    const email = normalise(body.email);
    const user = users.get(email);
    if (user === undefined) throw new ApiError('not_found', 'No account for that email.', 404);
    if (body.code.trim() !== VERIFICATION_CODE) {
      throw new ApiError('invalid_code', 'That code is not right.', 400, {
        code: 'Check the code and try again.',
      });
    }
    verified.add(email);
    const confirmed: User = { ...user, emailVerified: true, status: 'active' };
    users.set(email, confirmed);
    return delay(sessionFor(confirmed));
  },

  async resendVerification(email: string) {
    if (!users.has(normalise(email))) {
      throw new ApiError('not_found', 'No account for that email.', 404);
    }
    return delay(undefined);
  },

  async login(body: LoginRequest) {
    const email = normalise(body.email);
    const user = users.get(email);
    if (user === undefined || passwords.get(email) !== body.password) {
      // Deliberately the same error for "no such user" and "wrong password" —
      // distinguishing them turns the login form into an account enumerator.
      throw new ApiError('invalid_credentials', 'Email or password is not right.', 401);
    }
    if (!verified.has(email)) {
      throw new ApiError('email_not_verified', 'Verify your email first.', 403);
    }
    return delay(sessionFor(user));
  },

  async refresh(_body: RefreshRequest) {
    return delay(tokens(), 120);
  },

  async createOrg(body: CreateOrgRequest) {
    const plan = PLANS[0];
    const org: Org = {
      id: id('org'),
      name: body.name,
      sizeBucket: body.sizeBucket,
      plan: 'test',
      tokenAllowance: plan?.tokenAllowance ?? 0,
      tokensUsedCycle: 0,
      topupBalance: 0,
      retentionDays: 90,
      memberCount: 1,
    };
    orgs.set(org.id, org);

    // Attach the org to the most recently created user, mirroring what the real
    // endpoint does with the authenticated caller.
    const last = [...users.entries()].at(-1);
    if (last !== undefined) {
      const [email, user] = last;
      users.set(email, { ...user, orgId: org.id, status: 'active' });
    }

    return delay(org);
  },

  async invite(orgId: string, body: InviteRequest) {
    if (!orgs.has(orgId)) throw new ApiError('not_found', 'Unknown organization.', 404);
    const invite = addInvite(orgId, body);
    return delay(invite);
  },

  async listInvites(orgId: string) {
    return delay(invitesByOrg.get(orgId) ?? [], 150);
  },

  async getEmployee(orgId: string, employeeId: string) {
    const match = [...users.values()].find(
      (user) => user.orgId === orgId && user.employeeId === employeeId,
    );
    if (match === undefined) throw new ApiError('not_found', 'No such employee.', 404);
    return delay(match, 150);
  },

  async removeEmployee(orgId: string, employeeId: string) {
    requireManager();
    requireOrg(orgId);

    const target = team.find((member) => member.employeeId === employeeId);
    if (target !== undefined && target.role === 'owner') {
      throw new ApiError('forbidden', 'The owner cannot be removed.', 403);
    }

    const list = invitesByOrg.get(orgId) ?? [];
    invitesByOrg.set(
      orgId,
      list.filter((invite) => invite.id !== employeeId),
    );
    team = team.filter((member) => member.employeeId !== employeeId);

    const org = orgs.get(orgId);
    if (org !== undefined) {
      orgs.set(orgId, { ...org, memberCount: Math.max(0, org.memberCount - 1) });
    }

    auditEntries = [
      {
        id: id('aud'),
        action: 'employee.removed',
        actorName: callerOrNull()?.name ?? null,
        subjectName: target?.name ?? employeeId,
        meetingId: null,
        detail: `removed ${target?.email ?? employeeId}`,
        ip: '10.0.0.1',
        at: new Date().toISOString(),
      },
      ...auditEntries,
    ];

    return delay(undefined, 150);
  },

  async createMeeting(body: CreateMeetingRequest) {
    const meeting: Meeting = {
      id: id('mtg'),
      orgId: [...orgs.keys()][0] ?? id('org'),
      platform: body.platform,
      title: body.title,
      status: 'launching',
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationSec: null,
      participantUserIds: [],
      externalParticipantCount: 0,
      tokensConsumed: 0,
      summary: null,
      decisions: [],
    };
    meetings.set(meeting.id, meeting);
    return delay(meeting);
  },

  async getMeeting(meetingId: string) {
    const meeting = meetings.get(meetingId);
    if (meeting === undefined) throw new ApiError('not_found', 'No such meeting.', 404);
    return delay(meeting, 150);
  },

  async endMeeting(meetingId: string) {
    const meeting = meetings.get(meetingId);
    if (meeting === undefined) throw new ApiError('not_found', 'No such meeting.', 404);
    const ended: Meeting = {
      ...meeting,
      status: 'completed',
      endedAt: new Date().toISOString(),
      durationSec: 1_800,
      summary: 'Meeting ended.',
    };
    meetings.set(meetingId, ended);
    return delay(ended);
  },

  async listTasks(query: ListTasksQuery) {
    let result = tasks;
    if (query.meetingId !== null) result = result.filter((t) => t.meetingId === query.meetingId);
    if (query.status !== null) result = result.filter((t) => t.status === query.status);
    if (query.limit !== null) result = result.slice(0, query.limit);
    return delay(result, 150);
  },

  // --- dashboard ----------------------------------------------------------

  async listTeam(orgId: string) {
    requireManager();
    requireOrg(orgId);
    return delay(team.map((member) => ({ ...member })), 260);
  },

  async bulkInvite(orgId: string, rows: BulkInviteRow[]) {
    requireManager();
    requireOrg(orgId);

    const invited: Invite[] = [];
    const failed: BulkInviteFailure[] = [];
    const seen = new Set(team.map((member) => normalise(member.email)));

    for (const row of rows) {
      const email = normalise(row.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        failed.push({ line: row.line, email: row.email, message: 'Not a valid email address.' });
        continue;
      }
      if (seen.has(email)) {
        failed.push({ line: row.line, email: row.email, message: 'Already on the team.' });
        continue;
      }
      seen.add(email);
      invited.push(
        addInvite(orgId, {
          email: row.email,
          name: row.name,
          role: row.role,
          jobDescription: row.jobDescription,
        }),
      );
    }

    return delay({ invited, failed }, 620);
  },

  async listMeetings(orgId: string, query: ListMeetingsQuery) {
    requireManager();
    requireOrg(orgId);

    const all = [...meetings.values()].filter((meeting) => meeting.orgId === orgId);
    const isPast = (meeting: Meeting) =>
      meeting.status === 'completed' || meeting.status === 'failed';

    let result =
      query.window === 'all' ? all : all.filter((m) => (query.window === 'past' ? isPast(m) : !isPast(m)));

    result = result.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    if (query.limit !== null) result = result.slice(0, query.limit);
    return delay(result.map((meeting) => ({ ...meeting })), 280);
  },

  async getMeetingDetail(meetingId: string) {
    requireManager();
    const meeting = meetings.get(meetingId);
    if (meeting === undefined) throw new ApiError('not_found', 'No such meeting.', 404);

    const participants: MeetingParticipant[] = meeting.participantUserIds.flatMap((userId) => {
      const member = team.find((row) => row.id === userId);
      if (member === undefined) return [];
      return [
        {
          userId: member.id,
          employeeId: member.employeeId,
          name: member.name,
          role: member.role,
          daemonEnrolled: member.daemonEnrolled,
        },
      ];
    });

    const detail: MeetingDetail = {
      meeting: { ...meeting },
      participants,
      tasks: tasks.filter((task) => task.meetingId === meetingId),
      permissions: permissions.filter((event) => event.meetingId === meetingId),
    };
    return delay(detail, 300);
  },

  async listOrgTasks(orgId: string, query: OrgTasksQuery) {
    requireManager();
    requireOrg(orgId);

    let result = tasks.filter((task) => task.orgId === orgId);
    if (query.ownerEmployeeId !== null) {
      result = result.filter((task) => task.ownerEmployeeId === query.ownerEmployeeId);
    }
    if (query.status !== null) result = result.filter((task) => task.status === query.status);
    const dueFrom = query.dueFrom;
    if (dueFrom !== null) {
      result = result.filter((task) => task.due !== null && task.due >= dueFrom);
    }
    const dueTo = query.dueTo;
    if (dueTo !== null) {
      result = result.filter((task) => task.due !== null && task.due <= dueTo);
    }
    if (query.limit !== null) result = result.slice(0, query.limit);
    return delay(result.map((task) => ({ ...task })), 240);
  },

  async getOrgSettings(orgId: string) {
    requireManager();
    requireOrg(orgId);
    return delay(cloneSettings(settings), 220);
  },

  async updateOrgSettings(orgId: string, body: UpdateOrgSettingsRequest) {
    const user = requireManager();
    requireOrg(orgId);
    // Retention and rotation are org-wide security posture. A manager can read
    // them; changing them is owner/admin, which is the rule the API will apply.
    if (user.role === 'manager') {
      throw new ApiError('forbidden', 'Only an owner or admin can change these settings.', 403);
    }

    settings = {
      ...settings,
      listeningMode: body.listeningMode,
      deviceTokenRotationSec: body.deviceTokenRotationSec,
      permissionPolicyByRole: body.permissionPolicyByRole.map((policy) => ({ ...policy })),
      taskVisibility: body.taskVisibility,
      retentionDays: body.retentionDays,
    };

    const org = orgs.get(orgId);
    if (org !== undefined) orgs.set(orgId, { ...org, retentionDays: body.retentionDays });

    auditEntries = [
      {
        id: id('aud'),
        action: 'policy.changed',
        actorName: user.name,
        subjectName: null,
        meetingId: null,
        detail: `retention ${body.retentionDays}d, rotation ${body.deviceTokenRotationSec}s`,
        ip: '10.0.0.1',
        at: new Date().toISOString(),
      },
      ...auditEntries,
    ];

    return delay(cloneSettings(settings), 320);
  },

  async acknowledgeConsentNotice(orgId: string) {
    const user = requireManager();
    requireOrg(orgId);
    settings = {
      ...settings,
      consentNotice: {
        policyVersion: settings.consentNotice.policyVersion,
        acknowledgedAt: new Date().toISOString(),
        acknowledgedByName: user.name,
      },
    };
    return delay(cloneSettings(settings), 240);
  },

  async listAudit(orgId: string, query: AuditQuery) {
    requireManager();
    requireOrg(orgId);

    const matches = filterAudit(query);
    const limit = query.limit ?? 25;
    const start = query.cursor === null ? 0 : Number.parseInt(query.cursor, 10);
    const from = Number.isNaN(start) ? 0 : start;
    const page = matches.slice(from, from + limit);
    const next = from + limit;

    const result: AuditPage = {
      entries: page,
      nextCursor: next < matches.length ? String(next) : null,
      total: matches.length,
    };
    return delay(result, 260);
  },

  async exportAudit(orgId: string, query: AuditQuery) {
    const user = requireManager();
    requireOrg(orgId);

    const rows = filterAudit(query);
    const header = 'at,action,actor,subject,meeting_id,detail,ip';
    const body = rows
      .map((entry) =>
        [
          entry.at,
          entry.action,
          entry.actorName ?? '',
          entry.subjectName ?? '',
          entry.meetingId ?? '',
          entry.detail,
          entry.ip ?? '',
        ]
          .map(csvCell)
          .join(','),
      )
      .join('\n');

    // Exporting the audit log is itself an audited action.
    auditEntries = [
      {
        id: id('aud'),
        action: 'audit.exported',
        actorName: user.name,
        subjectName: null,
        meetingId: null,
        detail: `exported ${rows.length} entries as CSV`,
        ip: '10.0.0.1',
        at: new Date().toISOString(),
      },
      ...auditEntries,
    ];

    return delay(`${header}\n${body}\n`, 480);
  },

  // --- MFA ----------------------------------------------------------------

  async startMfaEnrollment() {
    const user = caller();
    return delay(
      {
        // Fixed rather than random: a demo secret that changes on every render
        // makes it impossible to actually finish enrolling in an app.
        secret: 'JBSWY3DPEHPK3PXPMR2WK5TF',
        otpauthUri: `otpauth://totp/Lily:${encodeURIComponent(user.email)}?secret=JBSWY3DPEHPK3PXPMR2WK5TF&issuer=Lily&algorithm=SHA1&digits=6&period=30`,
        issuer: 'Lily',
        account: user.email,
      } satisfies MfaEnrollmentStart,
      380,
    );
  },

  async confirmMfaEnrollment(code: string) {
    const user = caller();
    if (!/^\d{6}$/.test(code.trim())) {
      throw new ApiError('validation_failed', 'Enter the six-digit code.', 400, {
        code: 'Six digits, no spaces.',
      });
    }
    // The mock cannot compute a real TOTP, so it accepts any six digits except
    // one reserved value that exists purely to exercise the failure path.
    if (code.trim() === '000000') {
      throw new ApiError('invalid_code', 'That code is not right.', 400, {
        code: 'Check your authenticator app and try again.',
      });
    }

    const email = normalise(user.email);
    users.set(email, { ...user, mfaEnrolled: true });
    team = team.map((member) =>
      member.employeeId === user.employeeId ? { ...member, mfaEnrolled: true } : member,
    );

    const result: MfaEnrollmentResult = {
      backupCodes: [
        '4f2c-91ab',
        '7d10-3e55',
        'b8a4-6c02',
        '1e73-df98',
        '9c46-2ab1',
        '5a0f-77e3',
        'e214-b6dd',
        '3b89-40fc',
      ],
      enrolledAt: new Date().toISOString(),
    };
    return delay(result, 420);
  },

  async verifyStepUp(code: string) {
    caller();
    // The mock cannot compute a real TOTP, so it accepts anything except one
    // reserved value that exists to exercise the wrong-code path in the prompt.
    if (code.trim() === '000000') {
      throw new ApiError('invalid_code', 'That code is not right.', 400, {
        code: 'Use your authenticator app or a backup code.',
      });
    }
    const now = new Date();
    const result: StepUpResult = {
      verifiedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    };
    return delay(result, 300);
  },

  // --- owner only ---------------------------------------------------------

  async getOwnerAnalytics(query: AnalyticsQuery) {
    requireOwner();
    return delay(buildAnalytics(query) satisfies OwnerAnalytics, 540);
  },

  async getLiveSnapshot() {
    requireOwner();
    const live = [...meetings.values()].filter(
      (meeting) => meeting.status === 'live' || meeting.status === 'joining',
    ).length;
    const snapshot: LiveSnapshot = {
      at: new Date().toISOString(),
      meetingsRunning: live + 6,
      orgsOnline: 34,
      daemonsConnected: team.filter((member) => member.daemonOnline).length + 211,
      tasksInFlight: tasks.filter((task) => task.status === 'in_progress').length + 9,
    };
    return delay(snapshot, 180);
  },
};

// ---------------------------------------------------------------------------
// Mock-only helpers
// ---------------------------------------------------------------------------

function addInvite(orgId: string, body: InviteRequest): Invite {
  const invite: Invite = {
    id: id('inv'),
    email: body.email,
    name: body.name,
    role: body.role,
    status: 'invited',
    invitedAt: new Date().toISOString(),
  };
  invitesByOrg.set(orgId, [...(invitesByOrg.get(orgId) ?? []), invite]);

  team = [
    ...team,
    {
      id: id('usr'),
      employeeId: id('emp'),
      name: body.name,
      email: body.email,
      role: body.role,
      jobDescription: body.jobDescription,
      status: 'invited',
      daemonEnrolled: false,
      mfaEnrolled: false,
      agentKind: null,
      agentCapabilities: [],
      daemonOnline: false,
      lastSeenAt: null,
      invitedAt: invite.invitedAt,
    },
  ];

  const org = orgs.get(orgId);
  if (org !== undefined) orgs.set(orgId, { ...org, memberCount: org.memberCount + 1 });

  auditEntries = [
    {
      id: id('aud'),
      action: 'employee.invited',
      actorName: callerOrNull()?.name ?? null,
      subjectName: body.name,
      meetingId: null,
      detail: `invited ${body.email} as ${body.role}`,
      ip: '10.0.0.1',
      at: invite.invitedAt,
    },
    ...auditEntries,
  ];

  return invite;
}

function cloneSettings(value: OrgSettings): OrgSettings {
  return {
    ...value,
    permissionPolicyByRole: value.permissionPolicyByRole.map((policy) => ({ ...policy })),
    consentNotice: { ...value.consentNotice },
    connectedPlatforms: value.connectedPlatforms.map((platform) => ({ ...platform })),
  };
}

function filterAudit(query: AuditQuery): AuditEntry[] {
  const needle = query.search === null ? '' : query.search.trim().toLowerCase();
  return auditEntries.filter((entry) => {
    if (query.action !== null && entry.action !== query.action) return false;
    if (query.from !== null && entry.at < query.from) return false;
    if (query.to !== null && entry.at > query.to) return false;
    if (needle === '') return true;
    return [entry.action, entry.actorName, entry.subjectName, entry.detail, entry.ip]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLowerCase().includes(needle));
  });
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Called when the access token is cleared, so a signed-out mock behaves like a
 *  signed-out API rather than continuing to answer. */
export function clearMockSession(): void {
  currentEmail = null;
}

/** Test seam. Exported so a future vitest suite can start from a known state. */
export function resetMock(): void {
  users.clear();
  passwords.clear();
  verified.clear();
  orgs.clear();
  invitesByOrg.clear();
  meetings.clear();
  tasks = [];
  team = [];
  permissions = [];
  auditEntries = [];
  settings = buildSettings();
  currentEmail = null;
  sequence = 0;
  seedDemoOrg();
}

export { VERIFICATION_CODE };

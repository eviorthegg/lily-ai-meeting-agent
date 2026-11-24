import type {
  AcquisitionRow,
  AcquisitionSeriesPoint,
  AnalyticsGrain,
  AnalyticsQuery,
  AuditEntry,
  DiscountRow,
  FunnelStage,
  MarginRow,
  Meeting,
  OrgSettings,
  OwnerAnalytics,
  PermissionEvent,
  Role,
  Task,
  TeamMember,
} from './types';

/**
 * Demo data for the mock adapter.
 *
 * Pure data and deterministic builders — no state, no side effects. It exists so
 * every dashboard screen can be judged on how it handles real shapes: a member
 * who was invited and never installed anything, a meeting that failed, tasks
 * that nobody confirmed, permissions that were refused, an org whose margin on
 * one meeting is negative.
 *
 * Numbers come from `rand()` below rather than Math.random so a reload shows the
 * same chart twice. A demo that reshuffles on every render teaches you nothing
 * about the design.
 *
 * DATA POLICY: nothing here is transcript, source, file content or agent output,
 * because none of those exist in the API and inventing a placeholder for them in
 * a fixture is how they end up rendered by a component later.
 */

export const DEMO_ORG_ID = 'org_demo';
export const DEMO_PASSWORD = 'lily-demo-password';

/** Deterministic 0..1, seeded. Mulberry32. */
function makeRand(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

interface Seed {
  first: string;
  last: string;
  role: Role;
  job: string;
  agent: string | null;
  caps: string[];
  online: boolean;
  seenMs: number | null;
  enrolled: boolean;
  mfa: boolean;
  status: TeamMember['status'];
}

const SEEDS: readonly Seed[] = [
  {
    first: 'Maya',
    last: 'Ronen',
    role: 'owner',
    job: 'Runs the company. Owns pricing and anything to do with the board.',
    agent: 'claude-code',
    caps: ['github', 'google-calendar', 'linear'],
    online: true,
    seenMs: 2 * MINUTE,
    enrolled: true,
    // Deliberately false: the two accounts the mock lets you log in as start
    // un-enrolled so the MFA gate is the first thing the dashboard shows.
    mfa: false,
    status: 'active',
  },
  {
    first: 'Dan',
    last: 'Weiss',
    role: 'admin',
    job: 'Platform lead. Owns the deploy pipeline, infra cost and on-call.',
    agent: 'claude-code',
    caps: ['github', 'aws', 'pagerduty'],
    online: true,
    seenMs: 40_000,
    enrolled: true,
    mfa: true,
    status: 'active',
  },
  {
    first: 'Ari',
    last: 'Bloom',
    role: 'manager',
    job: 'Engineering manager for the payments squad. Owns the roadmap there.',
    agent: 'cursor',
    caps: ['github', 'linear'],
    online: true,
    seenMs: 6 * MINUTE,
    enrolled: true,
    mfa: false,
    status: 'active',
  },
  {
    first: 'Noa',
    last: 'Katz',
    role: 'employee',
    job: 'Backend engineer. Owns billing and the payments service.',
    agent: 'claude-code',
    caps: ['github', 'stripe-docs'],
    online: true,
    seenMs: 11 * MINUTE,
    enrolled: true,
    mfa: false,
    status: 'active',
  },
  {
    first: 'Tom',
    last: 'Halevi',
    role: 'employee',
    job: 'Frontend engineer. Owns the customer dashboard and the design system.',
    agent: 'codex',
    caps: ['github'],
    online: false,
    seenMs: 3 * HOUR,
    enrolled: true,
    mfa: false,
    status: 'active',
  },
  {
    first: 'Rina',
    last: 'Shaked',
    role: 'employee',
    job: 'Data. Owns the warehouse, the metrics definitions and anything called a funnel.',
    agent: 'gemini',
    caps: ['github', 'bigquery'],
    online: false,
    seenMs: 26 * HOUR,
    enrolled: true,
    mfa: false,
    status: 'active',
  },
  {
    first: 'Yuval',
    last: 'Peretz',
    role: 'employee',
    job: 'Support lead. Knows every open customer issue and who reported it.',
    agent: null,
    caps: [],
    online: false,
    seenMs: null,
    enrolled: false,
    mfa: false,
    status: 'active',
  },
  {
    first: 'Elior',
    last: 'Mizrahi',
    role: 'employee',
    job: 'QA. Owns the release checklist and the regression suite.',
    agent: null,
    caps: [],
    online: false,
    seenMs: null,
    enrolled: false,
    mfa: false,
    status: 'invited',
  },
  {
    first: 'Shira',
    last: 'Adler',
    role: 'manager',
    job: 'Product. Owns discovery and what ships in which order.',
    agent: null,
    caps: [],
    online: false,
    seenMs: null,
    enrolled: false,
    mfa: false,
    status: 'invited',
  },
];

export function buildTeam(): TeamMember[] {
  return SEEDS.map((seed, index) => {
    const n = index + 1;
    const employeeId = `emp_${seed.first.toLowerCase()}`;
    return {
      id: `usr_demo_${n}`,
      employeeId,
      name: `${seed.first} ${seed.last}`,
      email: `${seed.first.toLowerCase()}@northwind.test`,
      role: seed.role,
      jobDescription: seed.job,
      status: seed.status,
      daemonEnrolled: seed.enrolled,
      mfaEnrolled: seed.mfa,
      agentKind: seed.agent,
      agentCapabilities: [...seed.caps],
      daemonOnline: seed.online,
      lastSeenAt: seed.seenMs === null ? null : ago(seed.seenMs),
      invitedAt: ago((30 - index * 2) * DAY),
    };
  });
}

/** The two accounts the mock lets you log in as. Documented in web/README.md. */
export const DEMO_LOGINS: ReadonlyArray<{ email: string; employeeId: string }> = [
  { email: 'maya@northwind.test', employeeId: 'emp_maya' },
  { email: 'ari@northwind.test', employeeId: 'emp_ari' },
  { email: 'noa@northwind.test', employeeId: 'emp_noa' },
];

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

interface MeetingSeed {
  id: string;
  title: string;
  platform: Meeting['platform'];
  status: Meeting['status'];
  /** Milliseconds ago the meeting started. Always in the past — a meeting comes
   *  into existence when Lily is given a join link, so a future start time is
   *  not a state this system can be in. */
  startMs: number;
  durationSec: number | null;
  participants: number[];
  external: number;
  tokens: number;
  summary: string | null;
  decisions: string[];
}

const MEETING_SEEDS: readonly MeetingSeed[] = [
  {
    id: 'mtg_demo_1',
    title: 'Payments standup',
    platform: 'zoom',
    status: 'live',
    startMs: 18 * MINUTE,
    durationSec: null,
    participants: [1, 2, 3, 4],
    external: 0,
    tokens: 41_200,
    summary: null,
    decisions: [],
  },
  {
    id: 'mtg_demo_2',
    title: 'Dashboard design review',
    platform: 'meet',
    status: 'joining',
    startMs: 40_000,
    durationSec: null,
    participants: [3, 5],
    external: 1,
    tokens: 900,
    summary: null,
    decisions: [],
  },
  {
    id: 'mtg_demo_3',
    title: 'Weekly planning',
    platform: 'zoom',
    status: 'completed',
    startMs: 26 * HOUR,
    durationSec: 3_180,
    participants: [1, 2, 3, 4, 5, 6],
    external: 0,
    tokens: 186_400,
    summary:
      'Agreed to hold the payments migration until the reconciliation job has run clean for a week. Dan will keep the old writer behind a flag rather than deleting it. Two support escalations were reassigned.',
    decisions: [
      'Payments migration held until reconciliation is clean for seven days',
      'Old writer stays behind a flag, not deleted',
      'Support escalations move to Yuval',
    ],
  },
  {
    id: 'mtg_demo_4',
    title: 'Incident review — checkout timeouts',
    platform: 'teams',
    status: 'completed',
    startMs: 3 * DAY,
    durationSec: 2_640,
    participants: [2, 4, 7],
    external: 2,
    tokens: 143_900,
    summary:
      'Root cause was connection-pool exhaustion under a retry storm, not the payment provider. Pool sizing is now derived from the container limit. Follow-up to add a circuit breaker before the next sale.',
    decisions: [
      'Pool size derived from container limit, not hardcoded',
      'Circuit breaker required before the next sale',
    ],
  },
  {
    id: 'mtg_demo_5',
    title: 'Roadmap — Q3',
    platform: 'meet',
    status: 'completed',
    startMs: 6 * DAY,
    durationSec: 4_020,
    participants: [1, 3, 6, 9],
    external: 0,
    tokens: 221_800,
    summary:
      'Two of the four proposed initiatives were cut on capacity grounds. The dashboard work stays, the mobile app moves to next quarter, and reporting is descoped to exports only.',
    decisions: ['Mobile app deferred to Q4', 'Reporting descoped to exports'],
  },
  {
    id: 'mtg_demo_6',
    title: 'Vendor call',
    platform: 'zoom',
    status: 'failed',
    startMs: 8 * DAY,
    durationSec: 90,
    participants: [1],
    external: 3,
    tokens: 2_100,
    summary: null,
    decisions: [],
  },
  {
    id: 'mtg_demo_7',
    title: 'Onboarding — Rina',
    platform: 'meet',
    status: 'completed',
    startMs: 12 * DAY,
    durationSec: 1_860,
    participants: [1, 6],
    external: 0,
    tokens: 74_300,
    summary:
      'Walked through the warehouse layout and the metric definitions. Rina owns the funnel definitions from now on; nobody else edits them without asking her.',
    decisions: ['Funnel definitions owned by Rina'],
  },
];

export function buildMeetings(): Meeting[] {
  return MEETING_SEEDS.map((seed) => ({
    id: seed.id,
    orgId: DEMO_ORG_ID,
    platform: seed.platform,
    title: seed.title,
    status: seed.status,
    startedAt: ago(seed.startMs),
    // A meeting that is still running has no end. Everything else ended
    // `durationSec` after it started.
    endedAt: seed.durationSec === null ? null : ago(seed.startMs - seed.durationSec * 1000),
    durationSec: seed.durationSec,
    participantUserIds: seed.participants.map((n) => `usr_demo_${n}`),
    externalParticipantCount: seed.external,
    tokensConsumed: seed.tokens,
    summary: seed.summary,
    decisions: [...seed.decisions],
  }));
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

interface TaskSeed {
  text: string;
  owner: string;
  meeting: string | null;
  dueDays: number | null;
  status: Task['status'];
  type: Task['type'];
  outcome: Task['dispatchOutcome'];
  createdDaysAgo: number;
}

const TASK_SEEDS: readonly TaskSeed[] = [
  {
    text: 'Check whether the reconciliation job ran clean overnight',
    owner: 'emp_noa',
    meeting: 'mtg_demo_1',
    dueDays: 0,
    status: 'in_progress',
    type: 'lily_action',
    outcome: 'not_dispatched',
    createdDaysAgo: 0,
  },
  {
    text: 'Pull the open PR count on the payments repo',
    owner: 'emp_dan',
    meeting: 'mtg_demo_1',
    dueDays: 0,
    status: 'done',
    type: 'lily_action',
    outcome: 'succeeded',
    createdDaysAgo: 0,
  },
  {
    text: 'Write up the flag rollout plan',
    owner: 'emp_dan',
    meeting: 'mtg_demo_3',
    dueDays: 2,
    status: 'confirmed',
    type: 'human_assignment',
    outcome: 'not_dispatched',
    createdDaysAgo: 1,
  },
  {
    text: 'Reassign the two open escalations',
    owner: 'emp_yuval',
    meeting: 'mtg_demo_3',
    dueDays: 1,
    status: 'unconfirmed',
    type: 'human_assignment',
    outcome: 'not_dispatched',
    createdDaysAgo: 1,
  },
  {
    text: 'Run the regression suite against the release branch',
    owner: 'emp_elior',
    meeting: 'mtg_demo_3',
    dueDays: -1,
    status: 'unconfirmed',
    type: 'human_assignment',
    outcome: 'not_dispatched',
    createdDaysAgo: 1,
  },
  {
    text: 'Add the circuit breaker in front of the payment provider',
    owner: 'emp_noa',
    meeting: 'mtg_demo_4',
    dueDays: 5,
    status: 'in_progress',
    type: 'human_assignment',
    outcome: 'not_dispatched',
    createdDaysAgo: 3,
  },
  {
    text: 'Derive pool size from the container memory limit',
    owner: 'emp_dan',
    meeting: 'mtg_demo_4',
    dueDays: -2,
    status: 'done',
    type: 'human_assignment',
    outcome: 'not_dispatched',
    createdDaysAgo: 3,
  },
  {
    text: 'Find when the retry storm started in the logs',
    owner: 'emp_dan',
    meeting: 'mtg_demo_4',
    dueDays: null,
    status: 'done',
    type: 'lily_action',
    outcome: 'succeeded',
    createdDaysAgo: 3,
  },
  {
    text: 'Check the on-call rota for the sale weekend',
    owner: 'emp_dan',
    meeting: 'mtg_demo_4',
    dueDays: null,
    status: 'done',
    type: 'lily_action',
    outcome: 'failed',
    createdDaysAgo: 3,
  },
  {
    text: 'Move the mobile epic to Q4 in the tracker',
    owner: 'emp_ari',
    meeting: 'mtg_demo_5',
    dueDays: -3,
    status: 'done',
    type: 'lily_action',
    outcome: 'succeeded',
    createdDaysAgo: 6,
  },
  {
    text: 'Descope reporting to exports and update the brief',
    owner: 'emp_shira',
    meeting: 'mtg_demo_5',
    dueDays: 4,
    status: 'confirmed',
    type: 'human_assignment',
    outcome: 'not_dispatched',
    createdDaysAgo: 6,
  },
  {
    text: 'Share the current funnel definitions',
    owner: 'emp_rina',
    meeting: 'mtg_demo_7',
    dueDays: -5,
    status: 'done',
    type: 'lily_action',
    outcome: 'succeeded',
    createdDaysAgo: 12,
  },
  {
    text: 'Grant warehouse read access',
    owner: 'emp_rina',
    meeting: 'mtg_demo_7',
    dueDays: -6,
    status: 'cancelled',
    type: 'human_assignment',
    outcome: 'not_dispatched',
    createdDaysAgo: 12,
  },
  {
    text: 'Draft the pricing note for the board pack',
    owner: 'emp_maya',
    meeting: null,
    dueDays: 8,
    status: 'confirmed',
    type: 'human_assignment',
    outcome: 'not_dispatched',
    createdDaysAgo: 2,
  },
  {
    text: 'Summarise last week’s support themes',
    owner: 'emp_yuval',
    meeting: null,
    dueDays: 3,
    status: 'unconfirmed',
    type: 'human_assignment',
    outcome: 'not_dispatched',
    createdDaysAgo: 2,
  },
];

export function buildTasks(): Task[] {
  return TASK_SEEDS.map((seed, index) => ({
    id: `tsk_demo_${index + 1}`,
    orgId: DEMO_ORG_ID,
    meetingId: seed.meeting,
    text: seed.text,
    ownerEmployeeId: seed.owner,
    ownerUserId: null,
    due: seed.dueDays === null ? null : new Date(Date.now() + seed.dueDays * DAY).toISOString(),
    status: seed.status,
    type: seed.type,
    dispatchOutcome: seed.outcome,
    createdAt: ago(seed.createdDaysAgo * DAY + HOUR),
  }));
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

interface PermSeed {
  meeting: string;
  employeeId: string;
  kind: PermissionEvent['kind'];
  detail: string;
  decision: PermissionEvent['decision'];
  minutesAgo: number;
}

const PERM_SEEDS: readonly PermSeed[] = [
  {
    meeting: 'mtg_demo_1',
    employeeId: 'emp_noa',
    kind: 'test',
    detail: 'run `npm test -w payments`',
    decision: 'granted',
    minutesAgo: 12,
  },
  {
    meeting: 'mtg_demo_1',
    employeeId: 'emp_noa',
    kind: 'write',
    detail: 'edit `services/payments/src/reconcile.ts`',
    decision: 'denied',
    minutesAgo: 9,
  },
  {
    meeting: 'mtg_demo_1',
    employeeId: 'emp_dan',
    kind: 'shell',
    detail: 'run `gh pr list --state open`',
    decision: 'granted',
    minutesAgo: 6,
  },
  {
    meeting: 'mtg_demo_3',
    employeeId: 'emp_dan',
    kind: 'network',
    detail: 'call the status page API',
    decision: 'granted',
    minutesAgo: 26 * 60 - 20,
  },
  {
    meeting: 'mtg_demo_3',
    employeeId: 'emp_noa',
    kind: 'install',
    detail: 'install `pg-pool@3.7.0`',
    decision: 'timed_out',
    minutesAgo: 26 * 60 - 12,
  },
  {
    meeting: 'mtg_demo_4',
    employeeId: 'emp_dan',
    kind: 'shell',
    detail: 'run `kubectl top pods -n payments`',
    decision: 'granted',
    minutesAgo: 3 * 24 * 60 - 30,
  },
  {
    meeting: 'mtg_demo_4',
    employeeId: 'emp_dan',
    kind: 'deploy',
    detail: 'deploy `payments` to production',
    decision: 'hard_blocked',
    minutesAgo: 3 * 24 * 60 - 22,
  },
  {
    meeting: 'mtg_demo_4',
    employeeId: 'emp_noa',
    kind: 'write',
    detail: 'edit `infra/payments/deployment.yaml`',
    decision: 'denied',
    minutesAgo: 3 * 24 * 60 - 18,
  },
  {
    meeting: 'mtg_demo_5',
    employeeId: 'emp_ari',
    kind: 'network',
    detail: 'update the Q3 epic in the tracker',
    decision: 'granted',
    minutesAgo: 6 * 24 * 60 - 40,
  },
  {
    meeting: 'mtg_demo_7',
    employeeId: 'emp_rina',
    kind: 'vcs_read',
    detail: 'read `analytics/definitions/`',
    decision: 'granted',
    minutesAgo: 12 * 24 * 60 - 15,
  },
];

export function buildPermissions(): PermissionEvent[] {
  return PERM_SEEDS.map((seed, index) => ({
    id: `perm_demo_${index + 1}`,
    meetingId: seed.meeting,
    taskId: null,
    employeeId: seed.employeeId,
    kind: seed.kind,
    detail: seed.detail,
    decision: seed.decision,
    at: ago(seed.minutesAgo * MINUTE),
  }));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function buildSettings(): OrgSettings {
  return {
    listeningMode: 'name_only',
    deviceTokenRotationSec: 12 * 60 * 60,
    permissionPolicyByRole: [
      { role: 'owner', gatedAllowed: true },
      { role: 'admin', gatedAllowed: true },
      { role: 'manager', gatedAllowed: true },
      { role: 'employee', gatedAllowed: false },
    ],
    taskVisibility: 'owner_and_managers',
    retentionDays: 90,
    consentNotice: {
      policyVersion: '2026-07-25',
      acknowledgedAt: ago(9 * DAY),
      acknowledgedByName: 'Maya Ronen',
    },
    connectedPlatforms: [
      { platform: 'zoom', label: 'Zoom', connected: true, connectedAt: ago(34 * DAY) },
      { platform: 'meet', label: 'Google Meet', connected: true, connectedAt: ago(31 * DAY) },
      { platform: 'teams', label: 'Microsoft Teams', connected: false, connectedAt: null },
    ],
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const AUDIT_TEMPLATES: ReadonlyArray<{
  action: AuditEntry['action'];
  detail: string;
  actor: string | null;
  subject: string | null;
}> = [
  {
    action: 'permission.granted',
    detail: 'run `npm test -w payments`',
    actor: 'Noa Katz',
    subject: 'Noa Katz',
  },
  {
    action: 'permission.denied',
    detail: 'edit `services/payments/src/reconcile.ts`',
    actor: 'Noa Katz',
    subject: 'Noa Katz',
  },
  {
    action: 'permission.timed_out',
    detail: 'install `pg-pool@3.7.0`',
    actor: null,
    subject: 'Noa Katz',
  },
  { action: 'task.dispatched', detail: 'question routed to Dan Weiss', actor: 'Lily', subject: 'Dan Weiss' },
  { action: 'employee.invited', detail: 'invited elior@northwind.test as employee', actor: 'Maya Ronen', subject: 'Elior Mizrahi' },
  { action: 'employee.removed', detail: 'removed contractor account', actor: 'Dan Weiss', subject: 'Ex Contractor' },
  { action: 'token.rotated', detail: 'device token rotated on schedule', actor: null, subject: 'Dan Weiss' },
  { action: 'token.reuse_detected', detail: 'token family revoked after replay', actor: null, subject: 'Tom Halevi' },
  { action: 'policy.changed', detail: 'retention window 120 → 90 days', actor: 'Maya Ronen', subject: null },
  { action: 'billing.changed', detail: 'plan test → team', actor: 'Maya Ronen', subject: null },
  { action: 'audit.exported', detail: 'exported 412 entries as CSV', actor: 'Maya Ronen', subject: null },
  { action: 'install_token.issued', detail: 'install link issued', actor: 'Maya Ronen', subject: 'Rina Shaked' },
  { action: 'meeting.started', detail: 'Payments standup on zoom', actor: 'Ari Bloom', subject: null },
  { action: 'meeting.ended', detail: 'Weekly planning, 53 minutes', actor: 'Ari Bloom', subject: null },
  { action: 'data.hard_deleted', detail: 'purged 38 records past retention', actor: null, subject: null },
];

export function buildAudit(count = 140): AuditEntry[] {
  const rand = makeRand(0x1105);
  const entries: AuditEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const template = AUDIT_TEMPLATES[index % AUDIT_TEMPLATES.length];
    if (template === undefined) continue;
    entries.push({
      id: `aud_demo_${index + 1}`,
      action: template.action,
      actorName: template.actor,
      subjectName: template.subject,
      meetingId: index % 4 === 0 ? 'mtg_demo_3' : null,
      detail: template.detail,
      ip: template.actor === null ? null : `10.${Math.floor(rand() * 200)}.${index % 255}.${(index * 7) % 255}`,
      at: ago(index * 4 * HOUR + Math.floor(rand() * HOUR)),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Owner analytics
// ---------------------------------------------------------------------------

const GRAIN_MS: Record<AnalyticsGrain, number> = {
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
};

function periodLabel(grain: AnalyticsGrain, date: Date): string {
  const iso = date.toISOString();
  if (grain === 'month') return iso.slice(0, 7);
  return iso.slice(0, 10);
}

/**
 * Cost model behind gross margin.
 *
 * These are the meters in `UsageEventDoc.breakdown` collapsed into one
 * cents-per-1k-tokens number. It is provisional and marked as such in the UI —
 * a margin figure presented as settled when the inputs are not is worse than no
 * figure at all.
 */
export const COST_CENTS_PER_1K_TOKENS = 0.9;

export function buildAnalytics(query: AnalyticsQuery): OwnerAnalytics {
  const rand = makeRand(query.grain === 'day' ? 0x51ce : query.grain === 'week' ? 0x77aa : 0x9911);
  const step = GRAIN_MS[query.grain];
  const scale = query.grain === 'day' ? 1 : query.grain === 'week' ? 6.4 : 27;

  const series: AcquisitionSeriesPoint[] = [];
  const margin: MarginRow[] = [];

  for (let index = query.periods - 1; index >= 0; index -= 1) {
    const at = new Date(Date.now() - index * step);
    const label = periodLabel(query.grain, at);
    // A gentle upward drift plus noise. Growth that is visible but not a
    // hockey stick, because a fixture that always looks great hides the states
    // the design has to survive.
    const growth = 1 + (query.periods - index) / (query.periods * 2.2);
    const signups = Math.round((3 + rand() * 5) * scale * growth);
    const activations = Math.round(signups * (0.42 + rand() * 0.16));
    const paidConversions = Math.round(activations * (0.19 + rand() * 0.13));
    series.push({ period: label, signups, activations, paidConversions });

    const meetings = Math.round((58 + rand() * 46) * scale * growth);
    // ~120k–210k normalised tokens for a meeting of realistic length. At the
    // cost constant above that is $1.08–$1.89 of Lily runtime per meeting.
    const tokens = Math.round(meetings * (120_000 + rand() * 90_000));
    const costCents = Math.round((tokens / 1000) * COST_CENTS_PER_1K_TOKENS);
    // Subscription revenue attributable to the period. A $20 seat that runs
    // eight meetings a month is earning about $2.50 a meeting, which is the
    // range that makes the margin question interesting rather than obvious.
    const revenueCents = Math.round(meetings * (215 + rand() * 95));
    const grossMarginPct =
      revenueCents === 0 ? 0 : Math.round(((revenueCents - costCents) / revenueCents) * 1000) / 10;
    margin.push({
      period: label,
      meetings,
      tokens,
      revenueCents,
      costCents,
      grossMarginPct,
      costPerMeetingCents: meetings === 0 ? 0 : Math.round(costCents / meetings),
      revenuePerMeetingCents: meetings === 0 ? 0 : Math.round(revenueCents / meetings),
    });
  }

  const totalSignups = series.reduce((sum, point) => sum + point.signups, 0);
  const totalActivations = series.reduce((sum, point) => sum + point.activations, 0);
  const totalPaid = series.reduce((sum, point) => sum + point.paidConversions, 0);

  const funnel: FunnelStage[] = [
    { id: 'visit', label: 'Visited the site', count: Math.round(totalSignups * 21.4) },
    { id: 'signup', label: 'Signed up', count: totalSignups },
    { id: 'invited', label: 'Invited a teammate', count: Math.round(totalSignups * 0.61) },
    { id: 'daemon', label: 'Installed a daemon', count: Math.round(totalSignups * 0.44) },
    { id: 'meeting', label: 'Ran a first meeting', count: totalActivations },
    { id: 'paid', label: 'Paid', count: totalPaid },
  ];

  const paidOrgs = 148 + totalPaid;
  const mrrCents = paidOrgs * 2_000 + 61 * 10_000;
  const revenue = {
    mrrCents,
    arrCents: mrrCents * 12,
    arpuCents: Math.round(mrrCents / paidOrgs),
    churnRatePct: 3.4,
    expansionCents: 214_500,
    paidOrgs,
    trialOrgs: 96,
  };

  const acquisition: AcquisitionRow[] = [
    { source: 'google', medium: 'cpc', campaign: 'brand', visits: 8_412, signups: 341, paid: 74 },
    { source: 'google', medium: 'organic', campaign: null, visits: 6_190, signups: 226, paid: 41 },
    { source: 'linkedin', medium: 'social', campaign: 'founder-posts', visits: 3_884, signups: 198, paid: 52 },
    { source: 'producthunt', medium: 'referral', campaign: 'launch', visits: 2_951, signups: 412, paid: 19 },
    { source: 'hn', medium: 'referral', campaign: null, visits: 2_106, signups: 137, paid: 11 },
    { source: null, medium: null, campaign: null, visits: 5_338, signups: 129, paid: 23 },
  ];

  const discounts: DiscountRow[] = [
    { code: 'LAUNCH40', redemptions: 118, discountCents: 94_400, attributedRevenueCents: 236_000 },
    { code: 'NOMEETING48', redemptions: 64, discountCents: 25_600, attributedRevenueCents: 128_000 },
    { code: 'TRIALEND', redemptions: 41, discountCents: 16_400, attributedRevenueCents: 82_000 },
    { code: 'WINBACK', redemptions: 12, discountCents: 12_000, attributedRevenueCents: 24_000 },
  ];

  return {
    grain: query.grain,
    generatedAt: new Date().toISOString(),
    series,
    funnel,
    revenue,
    margin,
    acquisition,
    discounts,
    // Empty here on purpose: a fixture can invent every number, which is exactly
    // the difference between the demo and the real endpoint. The real one names
    // what it could not measure, and the screen renders that panel from this
    // field — so it renders nothing in demo mode.
    unavailable: [],
  };
}

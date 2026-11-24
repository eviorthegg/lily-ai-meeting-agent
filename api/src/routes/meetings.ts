import { ObjectId } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { assertNoForbiddenContent } from '../db/data-policy.js';
import { auditLog, meetings, orgs, tasks, users } from '../db/collections.js';
import type { MeetingDoc } from '../db/schema.js';
import { authenticate, MANAGER_ROLES, requireOrg, requireRole } from './context.js';
import {
  badRequest,
  conflict,
  created,
  notFound,
  ok,
  parseBody,
  requireParam,
  type ApiRequest,
  type RouteDeps,
  type RouteHandler,
} from './http.js';
import { presentMeeting, presentTask } from './present.js';

/**
 * Meetings.
 *
 * A meeting comes into existence when someone hands Lily a join link — there is
 * no scheduling model. `POST /meetings` therefore *launches* an orchestrator
 * rather than creating a calendar entry.
 *
 * The join URL is treated as a credential: anyone holding it can enter the call.
 * It is accepted once, handed to the launcher inside a signed single-use
 * payload, and **never written to the database** — `meetingUrl` is on the
 * forbidden-field list in ../db/data-policy.ts, so an attempt to persist it
 * fails loudly rather than silently leaking.
 */

const PLATFORMS = ['jitsi', 'meet', 'zoom', 'teams', 'local'] as const;

const createSchema = z.object({
  platform: z.enum(PLATFORMS),
  /** Empty for the simulated room, which has nothing to join. */
  joinUrl: z.string().max(2_000),
  title: z.string().max(300).nullable(),
});

const endSchema = z.object({
  reason: z.enum(['host_ended', 'cancelled']).optional(),
});

/**
 * Rejects anything that is not an ordinary public https meeting link.
 *
 * This is SSRF defence, not validation theatre: the URL is handed to a browser
 * that runs inside our own network, so a `file://` or a link pointing at
 * 169.254.169.254 would be asking that browser to fetch something on our behalf.
 */
function assertSafeJoinUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('That is not a valid URL.', { joinUrl: 'Must be a full https:// link.' });
  }

  if (url.protocol !== 'https:') {
    throw badRequest('Meeting links must be https.', { joinUrl: 'Must start with https://' });
  }

  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '169.254.169.254' ||
    /^(127\.|10\.|192\.168\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '[::1]';

  if (blocked) {
    throw badRequest('That link points inside a private network.', {
      joinUrl: 'Must be a public meeting link.',
    });
  }

  return url.toString();
}

/** Hosts each driver knows how to drive. */
const PLATFORM_HOSTS: Readonly<Record<string, { readonly test: RegExp; readonly label: string }>> = {
  jitsi: { test: /(^|\.)jit\.si$|jitsi/i, label: 'Jitsi' },
  meet: { test: /(^|\.)meet\.google\.com$/i, label: 'Google Meet' },
  zoom: { test: /(^|\.)zoom\.(us|com)$/i, label: 'Zoom' },
  teams: { test: /(^|\.)teams\.(microsoft|live)\.com$/i, label: 'Microsoft Teams' },
};

/**
 * Reject a link that belongs to a different platform than the one selected.
 *
 * Each driver only knows its own DOM. Pointing the Jitsi driver at a Google Meet
 * URL is not a degraded experience, it is a guaranteed failure — it navigates,
 * hunts for selectors that will never exist, and the process exits. Catching it
 * here turns a mystifying "Joining…" that never resolves into an error naming
 * exactly what is wrong, before anything is launched.
 */
function assertPlatformMatchesUrl(platform: string, url: string): void {
  const expected = PLATFORM_HOSTS[platform];
  if (expected === undefined) return;

  const host = new URL(url).hostname;
  if (expected.test.test(host)) return;

  const actual = Object.entries(PLATFORM_HOSTS).find(([, v]) => v.test.test(host));

  throw badRequest(
    actual === undefined
      ? `That link is not a ${expected.label} meeting.`
      : `That is a ${actual[1].label} link, but ${expected.label} is selected.`,
    {
      joinUrl:
        actual === undefined
          ? `Expected a ${expected.label} link.`
          : `Choose ${actual[1].label} as the platform, or paste a ${expected.label} link.`,
    },
  );
}

// ---------------------------------------------------------------------------
// POST /meetings
// ---------------------------------------------------------------------------

export const createMeeting: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);

  const body = parseBody(createSchema, req.body);
  const now = deps.now();

  const simulated = body.platform === 'local';
  const joinUrl = simulated ? '' : assertSafeJoinUrl(body.joinUrl.trim());
  if (!simulated) assertPlatformMatchesUrl(body.platform, joinUrl);

  const orgsCol = await orgs();
  const org = await orgsCol.findOne({ _id: actor.orgId });
  if (org === null) throw notFound('Organisation not found.');

  // Token exhaustion blocks a NEW meeting. A live one is never cut off — that
  // rule lives in the orchestrator's usage flush, not here.
  const remaining =
    org.billing.tokenAllowance - org.billing.tokensUsedCycle + org.billing.topupBalance;
  if (remaining <= 0) {
    throw conflict(
      'This organisation has used its Lily tokens for the cycle. Top up to start another meeting.',
    );
  }

  const meetingsCol = await meetings();
  const meetingId = new ObjectId();

  // Retention is stamped at write time from the org's setting, so a later change
  // to the org policy cannot retroactively extend what was already promised.
  const purgeAfter = new Date(now.getTime() + org.retention.days * 86_400_000);

  const doc: MeetingDoc = {
    _id: meetingId,
    orgId: actor.orgId,
    platform: body.platform === 'local' ? 'meet' : (body.platform as MeetingDoc['platform']),
    title: body.title,
    status: 'launching',
    startedAt: null,
    endedAt: null,
    durationSec: null,
    participantUserIds: [],
    externalParticipantCount: 0,
    orchestratorHandle: null,
    tokensConsumed: 0,
    costCents: null,
    summary: null,
    decisions: [],
    startedByUserId: actor.userId,
    failureReason: null,
    purgeAfter,
    createdAt: now,
    updatedAt: now,
  };

  // Belt and braces: the guard would reject a join URL if one ever leaked into
  // this document through a future edit.
  assertNoForbiddenContent(doc);
  await meetingsCol.insertOne(doc);

  // Single-use, short-lived. The orchestrator exchanges it for its real config
  // rather than receiving the meeting URL in an environment it cannot protect.
  const bootstrapToken = randomBytes(32).toString('base64url');

  try {
    const launched = await deps.providers.orchestrator.launch({
      meetingId: meetingId.toHexString(),
      orgId: actor.orgId.toHexString(),
      platform: body.platform,
      meetingUrl: joinUrl,
      bootstrapToken,
      maxDurationSec: deps.config.meeting.maxDurationSec,
    });

    await meetingsCol.updateOne(
      { _id: meetingId },
      {
        $set: {
          orchestratorHandle: launched.handle,
          status: 'joining',
          startedAt: launched.launchedAt,
          updatedAt: deps.now(),
        },
      },
    );
  } catch (error) {
    // The launcher's messages name the actual fix (Docker not running, image not
    // built, port in use). Record it and surface it rather than replacing it
    // with something generic that sends the operator hunting.
    const reason = error instanceof Error ? error.message : 'Launch failed.';
    await meetingsCol.updateOne(
      { _id: meetingId },
      { $set: { status: 'failed', failureReason: reason.slice(0, 500), updatedAt: deps.now() } },
    );
    throw conflict(reason);
  }

  const auditCol = await auditLog();
  await auditCol.insertOne({
    _id: new ObjectId(),
    orgId: actor.orgId,
    action: 'meeting.started',
    actorUserId: actor.userId,
    subjectUserId: null,
    meetingId,
    detail: `Started a ${body.platform} meeting`,
    ip: req.ip,
    at: now,
  });

  const stored = await meetingsCol.findOne({ _id: meetingId });
  return created(presentMeeting(stored ?? doc));
};

// ---------------------------------------------------------------------------
// GET /meetings/:meetingId
// ---------------------------------------------------------------------------

export const getMeeting: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  const meeting = await loadMeeting(req, actor.orgId);

  const tasksCol = await tasks();
  const meetingTasks = await tasksCol.find({ meetingId: meeting._id }).toArray();

  return ok({
    ...(presentMeeting(meeting) as Record<string, unknown>),
    tasks: meetingTasks.map((task) => presentTask(task)),
  });
};

// ---------------------------------------------------------------------------
// GET /orgs/:orgId/meetings
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  window: z.enum(['upcoming', 'past', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const LIVE_STATUSES = ['launching', 'joining', 'live', 'ending'] as const;

export const listMeetings: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const query = listQuerySchema.parse(req.query);
  const filter: Record<string, unknown> = { orgId };

  // "upcoming" means in flight, not scheduled — nothing in this system has a
  // future start time, and the dashboard tab is labelled "In progress" to match.
  if (query.window === 'upcoming') filter['status'] = { $in: LIVE_STATUSES };
  if (query.window === 'past') filter['status'] = { $in: ['completed', 'failed'] };

  const meetingsCol = await meetings();
  const rows = await meetingsCol
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(query.limit)
    .toArray();

  return ok(rows.map((row) => presentMeeting(row)));
};

// ---------------------------------------------------------------------------
// POST /meetings/:meetingId/end
// ---------------------------------------------------------------------------

export const endMeeting: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);

  const meeting = await loadMeeting(req, actor.orgId);
  parseBody(endSchema, req.body ?? {});

  const now = deps.now();
  const meetingsCol = await meetings();

  if (meeting.orchestratorHandle !== null) {
    // Idempotent by contract, so ending an already-gone meeting is not an error.
    await deps.providers.orchestrator.terminate(meeting.orchestratorHandle);
  }

  const startedAt = meeting.startedAt;
  await meetingsCol.updateOne(
    { _id: meeting._id },
    {
      $set: {
        status: 'completed',
        endedAt: now,
        durationSec:
          startedAt === null ? null : Math.round((now.getTime() - startedAt.getTime()) / 1000),
        updatedAt: now,
      },
    },
  );

  const auditCol = await auditLog();
  await auditCol.insertOne({
    _id: new ObjectId(),
    orgId: actor.orgId,
    action: 'meeting.ended',
    actorUserId: actor.userId,
    subjectUserId: null,
    meetingId: meeting._id,
    detail: 'Ended from the dashboard',
    ip: req.ip,
    at: now,
  });

  const updated = await meetingsCol.findOne({ _id: meeting._id });
  return ok(presentMeeting(updated ?? meeting));
};

// ---------------------------------------------------------------------------
// GET /meetings/:meetingId/detail
// ---------------------------------------------------------------------------

/**
 * The action kinds a permission decision can be about.
 *
 * Mirrors `ActionKind` in packages/shared/src/protocol and the copy the dashboard
 * declares. Listed here so the audit detail can be parsed back into one without
 * this file depending on the protocol module.
 */
const ACTION_KINDS = [
  'read',
  'search',
  'vcs_read',
  'write',
  'shell',
  'test',
  'install',
  'network',
  'vcs_push_protected',
  'delete',
  'deploy',
  'credential_access',
] as const;

type ActionKind = (typeof ACTION_KINDS)[number];

const PERMISSION_ACTIONS = [
  'permission.granted',
  'permission.denied',
  'permission.timed_out',
] as const;

/**
 * Recover the action kind from an audit entry.
 *
 * `AuditLogDoc` has no `kind` column — it has `detail`, which is the command that
 * was approved. The convention this API writes and reads is `"<kind>: <command>"`,
 * so the kind survives without widening the audit schema for one screen.
 *
 * A row that does not follow the convention yields `null` rather than a guess.
 * The dashboard renders that as "—", which is the honest answer: the decision is
 * recorded, its category is not.
 */
function splitPermissionDetail(detail: string): { kind: ActionKind | null; detail: string } {
  const separator = detail.indexOf(':');
  if (separator === -1) return { kind: null, detail };

  const candidate = detail.slice(0, separator).trim();
  if (!(ACTION_KINDS as readonly string[]).includes(candidate)) return { kind: null, detail };

  return { kind: candidate as ActionKind, detail: detail.slice(separator + 1).trim() };
}

export const getMeetingDetail: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);

  const meeting = await loadMeeting(req, actor.orgId);

  const [tasksCol, usersCol, auditCol] = await Promise.all([tasks(), users(), auditLog()]);

  const [meetingTasks, participants, decisions] = await Promise.all([
    tasksCol.find({ orgId: actor.orgId, meetingId: meeting._id }).toArray(),
    // Resolved by join rather than duplicated onto the meeting, so a rename shows
    // up here instead of freezing whatever the name was on the day.
    meeting.participantUserIds.length === 0
      ? Promise.resolve([])
      : usersCol.find({ _id: { $in: meeting.participantUserIds } }).toArray(),
    auditCol
      .find({
        orgId: actor.orgId,
        meetingId: meeting._id,
        action: { $in: PERMISSION_ACTIONS },
      })
      .sort({ at: 1 })
      .toArray(),
  ]);

  const employeeById = new Map(
    participants.map((person) => [person._id.toHexString(), person.employeeId]),
  );

  return ok({
    meeting: presentMeeting(meeting),
    participants: participants.map((person) => ({
      userId: person._id.toHexString(),
      employeeId: person.employeeId,
      name: person.name,
      role: person.role,
      daemonEnrolled: person.daemonEnrolled,
    })),
    tasks: meetingTasks.map((task) => presentTask(task)),
    permissions: decisions.map((entry) => {
      const parsed = splitPermissionDetail(entry.detail);
      return {
        id: entry._id.toHexString(),
        meetingId: meeting._id.toHexString(),
        // Not stored on the audit row; the entry records the decision, not the
        // task it belonged to.
        taskId: null,
        employeeId:
          entry.subjectUserId === null
            ? ''
            : (employeeById.get(entry.subjectUserId.toHexString()) ?? ''),
        kind: parsed.kind,
        detail: parsed.detail,
        decision: entry.action.slice('permission.'.length),
        at: entry.at.toISOString(),
      };
    }),
  });
};

// ---------------------------------------------------------------------------

async function loadMeeting(req: ApiRequest, orgId: ObjectId): Promise<MeetingDoc> {
  const raw = requireParam(req, 'meetingId');
  if (!ObjectId.isValid(raw)) throw notFound('No such meeting.');

  const meetingsCol = await meetings();
  // Scoped by org in the query itself, so another tenant's id returns 404 rather
  // than leaking that it exists.
  const meeting = await meetingsCol.findOne({ _id: new ObjectId(raw), orgId });
  if (meeting === null) throw notFound('No such meeting.');
  return meeting;
}

export const meetingRoutes = [
  { method: 'POST', pattern: '/meetings', handler: createMeeting },
  { method: 'GET', pattern: '/meetings/:meetingId', handler: getMeeting },
  { method: 'GET', pattern: '/meetings/:meetingId/detail', handler: getMeetingDetail },
  { method: 'POST', pattern: '/meetings/:meetingId/end', handler: endMeeting },
  { method: 'GET', pattern: '/orgs/:orgId/meetings', handler: listMeetings },
] as const satisfies readonly { method: string; pattern: string; handler: RouteHandler }[];

export type { RouteDeps };

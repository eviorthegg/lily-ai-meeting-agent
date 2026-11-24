import { z } from 'zod';
import { policyChecked } from '../db/data-policy.js';
import {
  connections,
  daemonTokens,
  installTokens,
  meetings,
  orgs,
  refreshTokens,
  sessions,
  tasks,
  usageEvents,
  users,
} from '../db/collections.js';
import type { OrgDoc, UtmAttribution } from '../db/schema.js';
import { DEFAULT_PLAN, planFor } from '../billing/plans.js';
import { revokeEmployeeConnections } from '../ws/handlers.js';
import {
  ADMIN_ROLES,
  MANAGER_ROLES,
  authenticate,
  requireOrg,
  requireRole,
  requireStepUpFor,
} from './context.js';
import {
  HttpError,
  badRequest,
  conflict,
  created,
  forbidden,
  ok,
  parseBody,
  requireParam,
  type RouteDeps,
  type RouteHandler,
} from './http.js';
import { presentOrg, presentOrgSettings } from './present.js';
import { attributionPayloadSchema } from './auth.js';
import { loadOrg, memberCount, writeAudit } from './support.js';

/**
 * Organisations.
 *
 * The org document is created *after* the user, at `POST /orgs`, into the id that
 * signup already reserved on `UserDoc.orgId` — see the note at the top of
 * ./auth.ts. That is why this file never assigns an org id: it fills one in.
 *
 * Two authorization lines run through everything here, and they are different
 * lines on purpose. Reading settings is a manager's job — they need to know what
 * the policy is. *Changing* retention, rotation or the permission policy is
 * owner/admin, and additionally needs a fresh MFA challenge, because those three
 * settings are the ones that decide how much damage a compromised session can do.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createOrgSchema = z.object({
  name: z.string().trim().min(1, 'Give the organisation a name.').max(200),
  sizeBucket: z.string().trim().max(40).nullable().optional(),
  attribution: attributionPayloadSchema.optional(),
});

const ROLES = ['owner', 'admin', 'manager', 'employee'] as const;

/**
 * Bounds on the rotation interval.
 *
 * Below fifteen minutes a daemon spends its life rotating instead of working;
 * above thirty days the rotation stops being a meaningful bound on a leaked
 * token's life. Both ends are refused rather than clamped — silently changing a
 * number an admin typed is how a security setting ends up not being what the
 * screen says it is.
 */
const MIN_ROTATION_SEC = 15 * 60;
const MAX_ROTATION_SEC = 30 * 24 * 3_600;

const updateSettingsSchema = z.object({
  listeningMode: z.enum(['always', 'name_only']),
  deviceTokenRotationSec: z.coerce.number().int().min(MIN_ROTATION_SEC).max(MAX_ROTATION_SEC),
  permissionPolicyByRole: z
    .array(z.object({ role: z.enum(ROLES), gatedAllowed: z.boolean() }))
    .max(ROLES.length),
  taskVisibility: z.enum(['org', 'owner_and_managers']),
  retentionDays: z.coerce.number().int().min(1).max(730),
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

type AttributionInput = z.infer<typeof attributionPayloadSchema>;

/** ISO string to Date, refusing to invent a timestamp for an unparseable one. */
function toTouch(
  touch: NonNullable<AttributionInput>['firstTouch'],
  fallback: Date,
): UtmAttribution | null {
  if (touch === null) return null;
  const parsed = new Date(touch.capturedAt);

  return {
    source: touch.source,
    medium: touch.medium,
    campaign: touch.campaign,
    term: touch.term,
    content: touch.content,
    gclid: touch.gclid,
    fbclid: touch.fbclid,
    referrer: touch.referrer,
    landingPath: touch.landingPath,
    capturedAt: Number.isNaN(parsed.getTime()) ? fallback : parsed,
  };
}

// ---------------------------------------------------------------------------
// POST /orgs
// ---------------------------------------------------------------------------

export const createOrg: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  const body = parseBody(createOrgSchema, req.body);
  const now = deps.now();

  // Email verification gates org actions, not merely login. An unverified address
  // is an address nobody has proved they can read, and the org is the thing every
  // later invite and every install token hangs off.
  if (actor.user.emailVerifiedAt === null) {
    throw new HttpError(403, 'email_not_verified', 'Verify your email address first.');
  }

  const orgsCol = await orgs();
  const existing = await orgsCol.findOne({ _id: actor.orgId });
  if (existing !== null) {
    throw conflict('This account already belongs to an organisation.');
  }

  const plan = planFor(DEFAULT_PLAN);
  const attribution = body.attribution ?? null;

  const document: OrgDoc = {
    _id: actor.orgId,
    name: body.name,
    sizeBucket: body.sizeBucket ?? null,
    ownerUserId: actor.userId,
    adminUserIds: [],
    billing: {
      plan: plan.id,
      // Copied, not referenced: a later change to the plan table must not
      // retroactively alter a cycle that is already running.
      tokenAllowance: plan.tokenAllowance,
      tokensUsedCycle: 0,
      topupBalance: 0,
      cycleResetsAt: new Date(now.getTime() + 30 * 86_400_000),
      status: 'active',
      lemonSqueezyCustomerId: null,
      lemonSqueezySubscriptionId: null,
      autoTopup: null,
      gracePeriodEndsAt: null,
    },
    settings: {
      listeningMode: deps.config.meeting.defaultListeningMode,
      deviceTokenRotationSec: deps.config.auth.deviceTokenRotationSec,
      // Empty means "the defaults apply"; `presentOrgSettings` fills every role in.
      permissionPolicyByRole: {},
      taskVisibility: 'org',
    },
    retention: { days: deps.config.retention.defaultDays },
    attribution: {
      firstTouch: toTouch(attribution?.firstTouch ?? null, now),
      lastTouch: toTouch(attribution?.lastTouch ?? null, now),
    },
    consentNotice: null,
    sso: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await orgsCol.insertOne(policyChecked(document));
  } catch (error) {
    // Two tabs, one account. The _id is the user's reserved org id, so the
    // duplicate-key path is the same conflict as the read above.
    if ((error as { code?: unknown }).code === 11000) {
      throw conflict('This account already belongs to an organisation.');
    }
    throw error;
  }

  // The owner becomes a full member the moment the org exists.
  const usersCol = await users();
  await usersCol.updateOne(
    { _id: actor.userId },
    { $set: { status: 'active', role: 'owner', updatedAt: now } },
  );

  await writeAudit({
    orgId: document._id,
    action: 'policy.changed',
    actorUserId: actor.userId,
    detail: `Created organisation "${document.name}" on the ${plan.name} plan`,
    ip: req.ip,
    at: now,
  });

  return created(presentOrg(document, await memberCount(document._id)));
};

// ---------------------------------------------------------------------------
// GET /orgs/:orgId
// ---------------------------------------------------------------------------

export const getOrg: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const org = await loadOrg(orgId);
  return ok(presentOrg(org, await memberCount(orgId)));
};

// ---------------------------------------------------------------------------
// GET /orgs/:orgId/settings
// ---------------------------------------------------------------------------

async function settingsResponse(org: OrgDoc, deps: RouteDeps): Promise<unknown> {
  const acknowledgedBy = org.consentNotice;
  let acknowledgedByName: string | null = null;

  if (acknowledgedBy !== null) {
    const usersCol = await users();
    const who = await usersCol.findOne(
      { _id: acknowledgedBy.acknowledgedByUserId },
      { projection: { name: 1 } },
    );
    acknowledgedByName = who?.name ?? null;
  }

  return presentOrgSettings(org, {
    currentPolicyVersion: deps.config.analytics.consentPolicyVersion,
    acknowledgedByName,
  });
}

export const getOrgSettings: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  return ok(await settingsResponse(await loadOrg(orgId), deps));
};

// ---------------------------------------------------------------------------
// PATCH /orgs/:orgId/settings
// ---------------------------------------------------------------------------

export const updateOrgSettings: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  // Managers can read this screen and cannot change it. The role check is here
  // rather than in the presenter because the two verbs genuinely differ.
  requireRole(actor, ADMIN_ROLES);

  const now = deps.now();
  requireStepUpFor(actor, 'policy.change', now);

  const body = parseBody(updateSettingsSchema, req.body);
  const { minDays, maxDays } = deps.config.retention;

  if (body.retentionDays < minDays || body.retentionDays > maxDays) {
    throw badRequest(`Retention must be between ${minDays} and ${maxDays} days.`, {
      retentionDays: `Between ${minDays} and ${maxDays}.`,
    });
  }

  const org = await loadOrg(orgId);

  const policy: Record<string, { gatedAllowed: boolean }> = {};
  for (const entry of body.permissionPolicyByRole) {
    policy[entry.role] = { gatedAllowed: entry.gatedAllowed };
  }

  const orgsCol = await orgs();
  await orgsCol.updateOne(
    { _id: orgId },
    {
      $set: {
        'settings.listeningMode': body.listeningMode,
        'settings.deviceTokenRotationSec': body.deviceTokenRotationSec,
        'settings.permissionPolicyByRole': policy,
        'settings.taskVisibility': body.taskVisibility,
        'retention.days': body.retentionDays,
        updatedAt: now,
      },
    },
  );

  // The detail names what changed, not merely that something did — an audit line
  // reading "settings updated" answers no question anyone asks it later.
  const changes = [
    org.settings.listeningMode === body.listeningMode
      ? null
      : `listening ${org.settings.listeningMode}→${body.listeningMode}`,
    org.settings.deviceTokenRotationSec === body.deviceTokenRotationSec
      ? null
      : `rotation ${org.settings.deviceTokenRotationSec}s→${body.deviceTokenRotationSec}s`,
    org.settings.taskVisibility === body.taskVisibility
      ? null
      : `task visibility ${org.settings.taskVisibility}→${body.taskVisibility}`,
    org.retention.days === body.retentionDays
      ? null
      : `retention ${org.retention.days}d→${body.retentionDays}d`,
    describePolicyChange(org, policy),
  ].filter((entry): entry is string => entry !== null);

  await writeAudit({
    orgId,
    action: 'policy.changed',
    actorUserId: actor.userId,
    detail: changes.length === 0 ? 'Settings saved with no changes' : changes.join(', '),
    ip: req.ip,
    at: now,
  });

  const updated = await loadOrg(orgId);
  return ok(await settingsResponse(updated, deps));
};

function describePolicyChange(
  org: OrgDoc,
  next: Record<string, { gatedAllowed: boolean }>,
): string | null {
  const moved: string[] = [];
  for (const role of ROLES) {
    const before = org.settings.permissionPolicyByRole[role]?.gatedAllowed ?? true;
    const after = next[role]?.gatedAllowed ?? true;
    if (before !== after) moved.push(`${role} gated ${before ? 'on' : 'off'}→${after ? 'on' : 'off'}`);
  }
  return moved.length === 0 ? null : moved.join('; ');
}

// ---------------------------------------------------------------------------
// POST /orgs/:orgId/consent-notice
// ---------------------------------------------------------------------------

/**
 * Record that someone accepted the current AI-participation notice.
 *
 * Jurisdictions differ on whether an AI participant in a call needs disclosure
 * and on who may consent to it, so the acknowledgement is stored with the person
 * and the policy version rather than as a boolean. Bumping
 * `analytics.consentPolicyVersion` re-arms the prompt by construction — the
 * presenter compares the stored version against the current one.
 */
export const acknowledgeConsentNotice: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const now = deps.now();
  const policyVersion = deps.config.analytics.consentPolicyVersion;

  const orgsCol = await orgs();
  await orgsCol.updateOne(
    { _id: orgId },
    {
      $set: {
        consentNotice: {
          acknowledgedByUserId: actor.userId,
          acknowledgedAt: now,
          policyVersion,
        },
        updatedAt: now,
      },
    },
  );

  await writeAudit({
    orgId,
    action: 'policy.changed',
    actorUserId: actor.userId,
    detail: `Acknowledged the AI participation notice, version ${policyVersion}`,
    ip: req.ip,
    at: now,
  });

  return ok(await settingsResponse(await loadOrg(orgId), deps));
};

// ---------------------------------------------------------------------------
// PATCH /orgs/:orgId/billing
// ---------------------------------------------------------------------------

const updateBillingSchema = z.object({
  plan: z.enum(['test', 'team', 'scale']).optional(),
  autoTopup: z
    .object({
      enabled: z.boolean(),
      packSize: z.coerce.number().int().min(10_000).max(50_000_000),
      /** The customer's own limit, not ours. Zero means "never auto-charge". */
      monthlyCeilingCents: z.coerce.number().int().min(0).max(1_000_000),
    })
    .nullable()
    .optional(),
});

/**
 * Change the plan or the auto-top-up posture.
 *
 * Owner only and behind step-up, because `billing.change` is in STEP_UP_ACTIONS
 * for the obvious reason: an attacker with a live session who can turn on
 * auto-top-up with a high ceiling can spend the customer's money.
 *
 * No payment processing happens here. LemonSqueezy owns the subscription and its
 * webhook owns `lemonSqueezySubscriptionId`; this records the org's *intent* and
 * the allowance that follows from it. Wiring the processor is out of scope for
 * this change, which is why nothing below pretends a card was charged.
 */
export const updateBilling: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  if (actor.role !== 'owner') throw forbidden('Only the owner can change billing.');

  const now = deps.now();
  requireStepUpFor(actor, 'billing.change', now);

  const body = parseBody(updateBillingSchema, req.body);
  const org = await loadOrg(orgId);

  const changes: string[] = [];
  const update: Record<string, unknown> = { updatedAt: now };

  if (body.plan !== undefined && body.plan !== org.billing.plan) {
    const next = planFor(body.plan);
    update['billing.plan'] = next.id;
    // Copied onto the org, same rule as at creation: the allowance in force is
    // the one recorded here, not whatever the plan table says later.
    update['billing.tokenAllowance'] = next.tokenAllowance;
    changes.push(`plan ${org.billing.plan}→${next.id}`);
  }

  if (body.autoTopup !== undefined) {
    update['billing.autoTopup'] = body.autoTopup;
    changes.push(
      body.autoTopup === null || !body.autoTopup.enabled
        ? 'auto top-up off'
        : `auto top-up on, ceiling ${body.autoTopup.monthlyCeilingCents}c/month`,
    );
  }

  const orgsCol = await orgs();
  await orgsCol.updateOne({ _id: orgId }, { $set: update });

  await writeAudit({
    orgId,
    action: 'billing.changed',
    actorUserId: actor.userId,
    detail: changes.length === 0 ? 'Billing saved with no changes' : changes.join(', '),
    ip: req.ip,
    at: now,
  });

  const updated = await loadOrg(orgId);
  return ok(presentOrg(updated, await memberCount(orgId)));
};

// ---------------------------------------------------------------------------
// POST /orgs/:orgId/hard-delete
// ---------------------------------------------------------------------------

/**
 * Delete everything derived from this org's meetings, now.
 *
 * Retention normally runs through TTL indexes on `purgeAfter`, which the database
 * enforces whether or not our code is running. This is the "do it today" path a
 * customer is entitled to ask for, and it deletes rather than tombstones.
 *
 * `audit_log` deliberately survives. It records who authorised what, contains no
 * meeting content, and is excluded from the retention sweep for the same reason —
 * deleting the record of a deletion is not a privacy feature.
 *
 * Owner only, and behind step-up: this is the single most destructive action the
 * API exposes.
 */
export const hardDelete: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  if (actor.role !== 'owner') throw forbidden('Only the owner can hard-delete organisation data.');

  const now = deps.now();
  requireStepUpFor(actor, 'policy.change', now);

  const org = await loadOrg(orgId);

  const [meetingsCol, tasksCol, usageCol] = await Promise.all([meetings(), tasks(), usageEvents()]);

  const [deletedMeetings, deletedTasks, deletedUsage] = await Promise.all([
    meetingsCol.deleteMany({ orgId }),
    tasksCol.deleteMany({ orgId }),
    usageCol.deleteMany({ orgId }),
  ]);

  // Live daemons are cut off before the tokens are revoked, so there is no window
  // in which a connection outlives the data it was allowed to act on.
  const usersCol = await users();
  const members = await usersCol.find({ orgId }, { projection: { _id: 1 } }).toArray();
  await Promise.all(
    members.map((member) =>
      revokeEmployeeConnections(orgId, member._id, 'org_suspended', deps.providers.ws),
    ),
  );

  const [orgsCol, tokensCol, refreshCol, sessionsCol, installCol, connectionsCol] = await Promise.all([
    orgs(),
    daemonTokens(),
    refreshTokens(),
    sessions(),
    installTokens(),
    connections(),
  ]);

  await Promise.all([
    tokensCol.updateMany(
      { orgId, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: 'admin_revoke', updatedAt: now } },
    ),
    refreshCol.updateMany(
      { orgId, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: 'admin_revoke', updatedAt: now } },
    ),
    sessionsCol.updateMany({ orgId, revokedAt: null }, { $set: { revokedAt: now, updatedAt: now } }),
    installCol.deleteMany({ orgId }),
    connectionsCol.deleteMany({ orgId }),
  ]);

  await orgsCol.updateOne({ _id: orgId }, { $set: { deletedAt: now, updatedAt: now } });

  await usersCol.updateMany(
    { orgId },
    { $set: { status: 'removed', removedAt: now, updatedAt: now } },
  );

  await writeAudit({
    orgId,
    action: 'data.hard_deleted',
    actorUserId: actor.userId,
    detail:
      `Hard-deleted "${org.name}": ${deletedMeetings.deletedCount} meetings, ` +
      `${deletedTasks.deletedCount} tasks, ${deletedUsage.deletedCount} usage records`,
    ip: req.ip,
    at: now,
  });

  return ok({
    deletedAt: now.toISOString(),
    meetings: deletedMeetings.deletedCount,
    tasks: deletedTasks.deletedCount,
    usageEvents: deletedUsage.deletedCount,
    membersRemoved: members.length,
  });
};

export const orgRoutes = [
  { method: 'POST', pattern: '/orgs', handler: createOrg },
  { method: 'GET', pattern: '/orgs/:orgId', handler: getOrg },
  { method: 'GET', pattern: '/orgs/:orgId/settings', handler: getOrgSettings },
  { method: 'PATCH', pattern: '/orgs/:orgId/settings', handler: updateOrgSettings },
  { method: 'POST', pattern: '/orgs/:orgId/consent-notice', handler: acknowledgeConsentNotice },
  { method: 'PATCH', pattern: '/orgs/:orgId/billing', handler: updateBilling },
  { method: 'POST', pattern: '/orgs/:orgId/hard-delete', handler: hardDelete },
] as const satisfies readonly { method: string; pattern: string; handler: RouteHandler }[];

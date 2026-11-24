import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { policyChecked } from '../db/data-policy.js';
import { connections, daemonTokens, installTokens, users } from '../db/collections.js';
import type { InstallTokenDoc, OrgDoc, Role, UserDoc } from '../db/schema.js';
import {
  generateOpaqueToken,
  hashToken,
  revokeAllRefreshTokensForUser,
  revokeDeviceTokensForUser,
} from '../auth/tokens.js';
import { revokeEmployeeConnections } from '../ws/handlers.js';
import {
  MANAGER_ROLES,
  authenticate,
  requireOrg,
  requireRole,
  requireStepUpFor,
  type Actor,
} from './context.js';
import {
  HttpError,
  badRequest,
  conflict,
  created,
  forbidden,
  noContent,
  notFound,
  ok,
  parseBody,
  requireParam,
  type RouteDeps,
  type RouteHandler,
} from './http.js';
import { presentInvite, presentTeamMember, presentUser } from './present.js';
import { findEmployee, loadOrg, newEmployeeId, normalizeEmail, writeAudit } from './support.js';
import { inviteEmail } from '../mail/templates.js';

/**
 * Team membership.
 *
 * Everything that changes who is in the org, or what their machine is trusted
 * with, lives here — which is why almost every handler in this file is behind a
 * step-up challenge. A live session is enough to look at the team; it is not
 * enough to add someone to it.
 *
 * The removal path is the one to read closely. Revoking tokens is necessary and
 * not sufficient: a daemon that is *already connected* holds an open socket, and
 * a socket outlives the token that opened it. So removal cuts the connection
 * explicitly through `revokeEmployeeConnections`, and it does that before it
 * revokes anything, so there is no interval in which a removed employee is still
 * receiving dispatches.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ASSIGNABLE_ROLES = ['owner', 'admin', 'manager', 'employee'] as const;

const inviteSchema = z.object({
  email: z.string().trim().min(3).max(320).email('Enter a valid email address.'),
  name: z.string().trim().min(1, 'Give the person a name.').max(200),
  role: z.enum(ASSIGNABLE_ROLES),
  // Fed into Lily's routing context, so it is org-authored description rather
  // than meeting content — in policy, and capped by the data-policy guard at 2000.
  jobDescription: z.string().trim().max(2_000).default(''),
});

const bulkInviteSchema = z.object({
  rows: z
    .array(inviteSchema.extend({ line: z.coerce.number().int().min(1).max(100_000) }))
    .min(1, 'The file had no rows.')
    .max(500, 'Split files larger than 500 rows.'),
});

type InviteInput = z.infer<typeof inviteSchema>;

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

/**
 * Who may hand out which role.
 *
 * Only an owner can mint another owner or an admin. A manager can invite
 * employees and nothing else. Without this, "manager" would be a role that can
 * promote itself to owner in two steps, which is not a role at all.
 */
function assertMayAssign(actor: Actor, role: Role): void {
  if (actor.role === 'owner') return;

  if (actor.role === 'admin') {
    if (role === 'owner') throw forbidden('Only the owner can create another owner.');
    return;
  }

  if (role !== 'employee') {
    throw forbidden('Managers can invite employees only.');
  }
}

// ---------------------------------------------------------------------------
// GET /orgs/:orgId/team
// ---------------------------------------------------------------------------

/**
 * The team table, with presence.
 *
 * Presence is a join against `connections` rather than a field on the user: the
 * connection row is the authority on whether a daemon is attached right now, it
 * is deleted on `$disconnect` and it has a TTL for the case where a machine dies
 * without one. A boolean on the user would go stale in exactly the situation
 * where the answer matters.
 */
export const listTeam: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const [usersCol, connectionsCol] = await Promise.all([users(), connections()]);

  const [members, live] = await Promise.all([
    usersCol.find({ orgId, status: { $ne: 'removed' } }).sort({ createdAt: 1 }).toArray(),
    connectionsCol.find({ orgId }).toArray(),
  ]);

  const byEmployee = new Map(live.map((connection) => [connection.employeeId, connection]));

  return ok(members.map((member) => presentTeamMember(member, byEmployee.get(member.employeeId))));
};

// ---------------------------------------------------------------------------
// GET /orgs/:orgId/invites
// ---------------------------------------------------------------------------

export const listInvites: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const usersCol = await users();
  const invited = await usersCol.find({ orgId, status: 'invited' }).sort({ createdAt: -1 }).toArray();

  return ok(invited.map((user) => presentInvite(user)));
};

// ---------------------------------------------------------------------------
// Invite creation
// ---------------------------------------------------------------------------

class InviteRejected extends Error {}

/**
 * Create the member, mint a single-use install token, send the email.
 *
 * Returns the created user so the caller can present it. Throws `InviteRejected`
 * for the "this row is bad" cases so the bulk path can collect them per line
 * instead of failing the whole file — a 400 on row 47 of a CSV is a worse
 * outcome than 46 successful invites and one reported failure.
 */
async function createInvite(
  actor: Actor,
  org: OrgDoc,
  input: InviteInput,
  deps: RouteDeps,
  ip: string | null,
  now: Date,
): Promise<UserDoc> {
  assertMayAssign(actor, input.role);

  const emailNormalized = normalizeEmail(input.email);
  const usersCol = await users();

  const existing = await usersCol.findOne({ emailNormalized });
  if (existing !== null) {
    throw new InviteRejected(
      existing.orgId.equals(org._id)
        ? 'Already on the team.'
        : 'That email already has a Lily account.',
    );
  }

  const user: UserDoc = {
    _id: new ObjectId(),
    orgId: org._id,
    employeeId: newEmployeeId(),
    email: input.email.trim(),
    emailNormalized,
    // An invited member proves their address by enrolling their daemon with the
    // token from the message, which only the mailbox owner received.
    emailVerifiedAt: null,
    name: input.name,
    role: input.role,
    jobDescription: input.jobDescription,
    status: 'invited',
    // No password: an invited member signs in only after setting one, and there
    // is no code path here that creates a credential on someone else's behalf.
    passwordHash: null,
    mfa: {
      enrolled: false,
      totpSecretEncrypted: null,
      backupCodeHashes: [],
      enrolledAt: null,
      lastVerifiedAt: null,
    },
    emailVerificationHash: null,
    emailVerificationExpiresAt: null,
    // Opt-in, per the product decision. An admin cannot set this to true; only
    // the employee running the daemon can.
    daemonEnrolled: false,
    agentKind: null,
    agentCapabilities: [],
    voiceProfileVector: null,
    lastSeenAt: null,
    removedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await usersCol.insertOne(policyChecked(user));
  } catch (error) {
    if ((error as { code?: unknown }).code === 11000) {
      throw new InviteRejected('Already invited.');
    }
    throw error;
  }

  const rawToken = await issueInstallToken(user, org, deps, now);

  await deps.providers.mail.send(
    inviteEmail({
      to: user.email,
      name: user.name,
      orgName: org.name,
      inviterName: actor.user.name,
      role: user.role,
      jobDescription: user.jobDescription,
      installToken: rawToken,
      expiresInHours: Math.round(deps.config.auth.installTokenTtlSec / 3_600),
    }),
  );

  await writeAudit({
    orgId: org._id,
    action: 'employee.invited',
    actorUserId: actor.userId,
    subjectUserId: user._id,
    detail: `Invited ${user.email} as ${user.role}`,
    ip,
    at: now,
  });

  await writeAudit({
    orgId: org._id,
    action: 'install_token.issued',
    actorUserId: actor.userId,
    subjectUserId: user._id,
    detail: `Single-use install token issued for ${user.employeeId}`,
    ip,
    at: now,
  });

  return user;
}

/**
 * Mint the install token.
 *
 * Only `sha256(token || pepper)` is stored. The raw value is returned to the
 * caller, goes into exactly one email, and is unrecoverable afterwards — there is
 * deliberately no "resend the same link" feature, because that would require
 * keeping it.
 */
async function issueInstallToken(
  user: UserDoc,
  org: OrgDoc,
  deps: RouteDeps,
  now: Date,
): Promise<string> {
  const rawToken = generateOpaqueToken();
  const collection = await installTokens();

  const document: InstallTokenDoc = {
    _id: new ObjectId(),
    orgId: org._id,
    userId: user._id,
    tokenHash: await hashToken(rawToken),
    expiresAt: new Date(now.getTime() + deps.config.auth.installTokenTtlSec * 1_000),
    consumedAt: null,
    utm:
      org.attribution.firstTouch === null
        ? null
        : {
            source: org.attribution.firstTouch.source,
            medium: org.attribution.firstTouch.medium,
            campaign: org.attribution.firstTouch.campaign,
          },
    createdAt: now,
    updatedAt: now,
  };

  await collection.insertOne(policyChecked(document));
  return rawToken;
}

// ---------------------------------------------------------------------------
// POST /orgs/:orgId/invite
// ---------------------------------------------------------------------------

export const invite: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const now = deps.now();
  // Two distinct gates, because the action does two distinct things: it adds a
  // member and it mints a credential that installs software on a machine.
  requireStepUpFor(actor, 'employee.add', now);
  requireStepUpFor(actor, 'install_token.issue', now);

  const body = parseBody(inviteSchema, req.body);
  const org = await loadOrg(orgId);

  try {
    const user = await createInvite(actor, org, body, deps, req.ip, now);
    return created(presentInvite(user));
  } catch (error) {
    if (error instanceof InviteRejected) {
      throw new HttpError(409, 'conflict', error.message, { email: error.message });
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// POST /orgs/:orgId/invite/bulk
// ---------------------------------------------------------------------------

export const bulkInvite: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const now = deps.now();
  requireStepUpFor(actor, 'employee.add', now);
  requireStepUpFor(actor, 'install_token.issue', now);

  const body = parseBody(bulkInviteSchema, req.body);
  const org = await loadOrg(orgId);

  const invited: unknown[] = [];
  const failed: { line: number; email: string; message: string }[] = [];

  // Sequential rather than parallel: each row sends an email and writes two audit
  // entries, and a 500-row file fired at the mail provider at once is how a
  // sending reputation gets destroyed.
  const seen = new Set<string>();

  for (const row of body.rows) {
    const key = normalizeEmail(row.email);

    // Duplicates *within the file* never reach the database, so the reported
    // reason is the true one rather than a unique-index collision.
    if (seen.has(key)) {
      failed.push({ line: row.line, email: row.email, message: 'Duplicated in this file.' });
      continue;
    }
    seen.add(key);

    try {
      const user = await createInvite(actor, org, row, deps, req.ip, now);
      invited.push(presentInvite(user));
    } catch (error) {
      if (error instanceof InviteRejected) {
        failed.push({ line: row.line, email: row.email, message: error.message });
        continue;
      }
      // A role the caller may not assign is a per-row problem too — the rest of
      // the file is still perfectly good.
      if (error instanceof HttpError && error.status === 403) {
        failed.push({ line: row.line, email: row.email, message: error.message });
        continue;
      }
      throw error;
    }
  }

  return ok({ invited, failed });
};

// ---------------------------------------------------------------------------
// GET /orgs/:orgId/employees/:employeeId
// ---------------------------------------------------------------------------

export const getEmployee: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));
  const employeeId = requireParam(req, 'employeeId');

  // Anyone in the org may look up a colleague; only a manager sees the team list
  // with presence. Someone reading their own record is the common case.
  const user = await findEmployee(orgId, employeeId);
  if (user === null || user.status === 'removed') throw notFound('No such employee.');

  return ok(presentUser(user, { orgExists: true }));
};

// ---------------------------------------------------------------------------
// DELETE /orgs/:orgId/employees/:employeeId
// ---------------------------------------------------------------------------

/**
 * Remove someone from the org.
 *
 * The acceptance requirement is that a removed employee stops receiving work
 * within five seconds, so the order below is the implementation of that promise:
 *
 *   1. Cut the live socket first. This is the only step with a deadline — the
 *      others govern *future* authentication, and a daemon that is already
 *      connected does not authenticate again.
 *   2. Revoke device tokens, so a reconnect fails.
 *   3. Revoke refresh tokens and end sessions, so the dashboard half stops too.
 *   4. Mark the user removed, which `handleConnect` re-checks independently.
 *
 * Step 4 is the backstop for steps 1–3: even holding an unswept token, a removed
 * user is refused at connect time.
 */
export const removeEmployee: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const now = deps.now();
  requireStepUpFor(actor, 'employee.remove', now);

  const employeeId = requireParam(req, 'employeeId');
  const target = await findEmployee(orgId, employeeId);
  if (target === null || target.status === 'removed') throw notFound('No such employee.');

  // The owner is the account the org hangs off — `OrgDoc.ownerUserId` points at
  // it — so removing them would leave an org nobody can administer.
  if (target.role === 'owner') throw forbidden('The owner cannot be removed.');

  // A manager may remove employees; promoting themselves past that by removing an
  // admin is the same escalation `assertMayAssign` refuses on the way in.
  if (actor.role === 'manager' && target.role !== 'employee') {
    throw forbidden('Managers can remove employees only.');
  }

  if (target._id.equals(actor.userId)) {
    throw badRequest('You cannot remove your own account.');
  }

  await revokeEmployeeConnections(orgId, target._id, 'employee_removed', deps.providers.ws);

  await Promise.all([
    revokeDeviceTokensForUser({ userId: target._id, reason: 'employee_removed', now }),
    revokeAllRefreshTokensForUser({ userId: target._id, reason: 'admin_revoke', now }),
  ]);

  const installCol = await installTokens();
  await installCol.deleteMany({ userId: target._id, consumedAt: null });

  const usersCol = await users();
  await usersCol.updateOne(
    { _id: target._id },
    {
      $set: {
        status: 'removed',
        removedAt: now,
        daemonEnrolled: false,
        agentCapabilities: [],
        agentKind: null,
        updatedAt: now,
      },
    },
  );

  await writeAudit({
    orgId,
    action: 'employee.removed',
    actorUserId: actor.userId,
    subjectUserId: target._id,
    detail: `Removed ${target.email} (${target.role}); tokens revoked and connections closed`,
    ip: req.ip,
    at: now,
  });

  return noContent();
};

// ---------------------------------------------------------------------------
// POST /employees/:employeeId/rotate-token
// ---------------------------------------------------------------------------

/**
 * Force a device-token rotation for one employee.
 *
 * Rotation normally happens on a schedule and on every reconnect. This is the
 * "I think that laptop is compromised" button: the current token is retired
 * immediately, the live connection is dropped, and the daemon re-enrols.
 *
 * The replacement token is deliberately NOT returned. There is no way to get it
 * to the right machine over this channel, and a rotation endpoint that hands the
 * new credential to whoever asked would be a credential-theft endpoint.
 */
export const rotateEmployeeToken: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);

  const now = deps.now();
  requireStepUpFor(actor, 'token.rotate', now);

  const employeeId = requireParam(req, 'employeeId');
  const target = await findEmployee(actor.orgId, employeeId);
  if (target === null || target.status === 'removed') throw notFound('No such employee.');

  const tokensCol = await daemonTokens();
  const live = await tokensCol.find({ userId: target._id, revokedAt: null }).toArray();

  if (live.length === 0) {
    throw conflict('That employee has no enrolled device to rotate.');
  }

  // `rotateDeviceToken` takes the raw token, which by design we do not have. What
  // an administrator can do is revoke: the daemon's next connect fails and its
  // owner re-enrols from a fresh invite. That is the honest shape of this action
  // given the raw token exists only on the employee's machine.
  await revokeDeviceTokensForUser({ userId: target._id, reason: 'admin_revoke', now });
  await revokeEmployeeConnections(actor.orgId, target._id, 'token_revoked', deps.providers.ws);

  const usersCol = await users();
  await usersCol.updateOne(
    { _id: target._id },
    { $set: { daemonEnrolled: false, updatedAt: now } },
  );

  await writeAudit({
    orgId: actor.orgId,
    action: 'token.rotated',
    actorUserId: actor.userId,
    subjectUserId: target._id,
    detail: `Revoked ${live.length} device token(s) for ${target.employeeId}; re-enrolment required`,
    ip: req.ip,
    at: now,
  });

  return ok({
    employeeId: target.employeeId,
    revokedTokens: live.length,
    rotatedAt: now.toISOString(),
    // Named so the dashboard can say the true thing: the employee has to run
    // enrolment again rather than expecting a silent handover.
    reEnrollmentRequired: true,
  });
};

export const teamRoutes = [
  { method: 'GET', pattern: '/orgs/:orgId/team', handler: listTeam },
  { method: 'GET', pattern: '/orgs/:orgId/invites', handler: listInvites },
  { method: 'POST', pattern: '/orgs/:orgId/invite', handler: invite },
  { method: 'POST', pattern: '/orgs/:orgId/invite/bulk', handler: bulkInvite },
  { method: 'GET', pattern: '/orgs/:orgId/employees/:employeeId', handler: getEmployee },
  { method: 'DELETE', pattern: '/orgs/:orgId/employees/:employeeId', handler: removeEmployee },
  { method: 'POST', pattern: '/employees/:employeeId/rotate-token', handler: rotateEmployeeToken },
] as const satisfies readonly { method: string; pattern: string; handler: RouteHandler }[];

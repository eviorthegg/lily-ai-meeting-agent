import { ObjectId } from 'mongodb';
import { getConfig } from '@lily/shared';
import { sessions, users } from '../db/collections.js';
import type { Role, SessionDoc, UserDoc } from '../db/schema.js';
import { verifyAccessToken } from '../auth/tokens.js';
import { assertStepUp, StepUpRequiredError, type StepUpAction } from '../auth/step-up.js';
import { mfaRequiredForUser } from '../auth/mfa-policy.js';
import { HttpError, forbidden, notFound, unauthorized, type ApiRequest } from './http.js';

/**
 * Who is calling, established server-side.
 *
 * The single most important property of this module: `role` is read from the
 * caller's own row in `users`, never from the request body and never from a
 * claim the client could have shaped. A client can influence authorization here
 * only by first changing its own database row, which is the thing authorization
 * is protecting. There is no parameter anywhere below through which a role can
 * be supplied.
 *
 * The access token *does* carry a role claim, and it is deliberately not used
 * for decisions — it is signed by us, but it is also a snapshot. Re-reading the
 * row means a demotion or a suspension takes effect on the next request rather
 * than at the end of the token's fifteen minutes.
 */
export interface Actor {
  readonly user: UserDoc;
  readonly session: SessionDoc;
  readonly userId: ObjectId;
  readonly orgId: ObjectId;
  readonly role: Role;
  readonly ip: string | null;
}

function bearer(req: ApiRequest): string | null {
  const raw = req.headers['authorization'];
  if (raw === undefined) return null;
  const [scheme, value] = raw.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value === '') return null;
  return value;
}

/**
 * Authenticate a request.
 *
 * Four things have to hold, and the checks are ordered cheapest-first only where
 * that does not change the answer: a valid signature, a session row that is
 * neither revoked nor timed out, and a user who is still allowed in. A revoked
 * session must fail even while its access token is cryptographically fine —
 * otherwise revocation would take up to a full token lifetime to bite, which is
 * exactly the window an attacker is holding.
 */
export async function authenticate(req: ApiRequest): Promise<Actor> {
  const token = bearer(req);
  if (token === null) throw unauthorized();

  const verification = await verifyAccessToken(token);
  if (!verification.ok) {
    throw unauthorized(
      verification.reason === 'expired'
        ? 'Your session has expired. Refresh and try again.'
        : 'Authentication required.',
    );
  }

  const { claims } = verification;
  const now = new Date();

  const sessionsCol = await sessions();
  const session = await sessionsCol.findOne({ _id: new ObjectId(claims.sessionId) });

  if (session === null || session.revokedAt !== null) throw unauthorized('Session ended.');
  if (session.absoluteExpiresAt.getTime() <= now.getTime()) {
    throw unauthorized('Session expired. Sign in again.');
  }

  const idleMs = getConfig().auth.session.idleTimeoutSec * 1_000;
  if (now.getTime() - session.lastActiveAt.getTime() > idleMs) {
    await sessionsCol.updateOne({ _id: session._id }, { $set: { revokedAt: now, updatedAt: now } });
    throw unauthorized('Session timed out. Sign in again.');
  }

  const usersCol = await users();
  const user = await usersCol.findOne({ _id: new ObjectId(claims.userId) });

  if (user === null || user.status === 'removed' || user.status === 'suspended') {
    throw unauthorized('This account is no longer active.');
  }

  await sessionsCol.updateOne({ _id: session._id }, { $set: { lastActiveAt: now } });

  return {
    user,
    session,
    userId: user._id,
    orgId: user.orgId,
    role: user.role,
    ip: req.ip,
  };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** Roles that may act on the org rather than merely participate in meetings. */
export const ADMIN_ROLES: readonly Role[] = ['owner', 'admin'];
export const MANAGER_ROLES: readonly Role[] = ['owner', 'admin', 'manager'];

export function requireRole(actor: Actor, allowed: readonly Role[]): void {
  if (!allowed.includes(actor.role)) {
    throw forbidden(`This action requires one of: ${allowed.join(', ')}.`);
  }
}

/**
 * Confirm the caller belongs to the org in the path.
 *
 * A mismatch answers 404, not 403. "Forbidden" would confirm that the org exists,
 * which is a membership oracle for anyone holding any valid session.
 */
export function requireOrg(actor: Actor, orgIdParam: string): ObjectId {
  if (!ObjectId.isValid(orgIdParam) || !actor.orgId.equals(new ObjectId(orgIdParam))) {
    throw notFound('No such organisation.');
  }
  return actor.orgId;
}

/**
 * Gate an action behind a fresh MFA challenge.
 *
 * A user who never enrolled has `mfaVerifiedAt === null` on every session they
 * will ever have, so this also enforces enrolment for privileged roles without a
 * second check — there is no way to satisfy step-up without having enrolled. The
 * two responses are distinguished only so the dashboard can route to the right
 * screen.
 */
export function requireStepUpFor(actor: Actor, action: StepUpAction, now: Date): void {
  try {
    assertStepUp(action, actor.session, now);
  } catch (error) {
    if (!(error instanceof StepUpRequiredError)) throw error;

    if (!actor.user.mfa.enrolled) {
      throw new HttpError(
        403,
        'mfa_enrollment_required',
        mfaRequiredForUser(actor.user)
          ? 'Enrol in two-factor authentication before performing administrative actions.'
          : 'This action requires two-factor authentication. Enrol first.',
      );
    }

    throw new HttpError(
      403,
      'step_up_required',
      'Confirm your identity with a two-factor code before continuing.',
      { action },
    );
  }
}

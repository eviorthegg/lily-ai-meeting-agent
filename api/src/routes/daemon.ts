import { z } from 'zod';
import { installTokens, users } from '../db/collections.js';
import { hashToken, issueDeviceToken } from '../auth/tokens.js';
import {
  gone,
  ok,
  parseBody,
  type RouteHandler,
} from './http.js';
import { writeAudit } from './support.js';

/**
 * Daemon enrolment.
 *
 * The request and response shapes here are not a design choice — `daemon/src/index.ts`
 * already calls this endpoint with a fixed contract, including its treatment of
 * HTTP 410 as the one status that means "this link is spent, ask for another"
 * rather than a transient failure worth retrying. Everything below matches it:
 *
 *     →  { installToken, daemonVersion }
 *     ←  { employeeId, orgId, deviceToken, wsUrl? }
 *     ←  410 when the token is already used, expired, or unknown
 *
 * This route is deliberately unauthenticated. The install token *is* the
 * credential: it arrived in an email only the invitee could read, it is good for
 * exactly one exchange, and it is short-lived. Requiring a session as well would
 * mean the employee had to have a dashboard login before they could connect their
 * own machine, which inverts the onboarding order the product actually has.
 */

const enrollSchema = z.object({
  installToken: z.string().min(10).max(500),
  daemonVersion: z.string().max(40).default('unknown'),
});

/**
 * A single 410 for every rejection.
 *
 * Unknown, expired and already-consumed are deliberately indistinguishable. The
 * daemon prints the same sentence for all three, and separating them would let
 * anyone holding a candidate token learn whether it ever existed.
 */
const SPENT = 'That install token has already been used or has expired.';

export const enrollDaemon: RouteHandler = async (req, deps) => {
  const body = parseBody(enrollSchema, req.body);
  const now = deps.now();

  const tokensCol = await installTokens();
  const tokenHash = await hashToken(body.installToken);

  // Single use is enforced by the filter, not by a read-then-write: `consumedAt: null`
  // is part of the match, so two daemons racing with the same token produce exactly
  // one winner and the loser sees an unmodified document.
  const claimed = await tokensCol.findOneAndUpdate(
    { tokenHash, consumedAt: null, expiresAt: { $gt: now } },
    { $set: { consumedAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );

  if (claimed === null) throw gone(SPENT);

  const usersCol = await users();
  const user = await usersCol.findOne({ _id: claimed.userId });

  // The token outlived the person. Nothing to enrol, and the row is already
  // consumed, so a second attempt gets the same answer.
  if (user === null || user.status === 'removed' || user.status === 'suspended') {
    throw gone(SPENT);
  }

  const device = await issueDeviceToken({
    userId: user._id,
    orgId: user.orgId,
    employeeId: user.employeeId,
    now,
  });

  await usersCol.updateOne(
    { _id: user._id },
    {
      $set: {
        // Running enrolment IS the employee opting in — an admin cannot set this.
        daemonEnrolled: true,
        // Accepting the invite proves the mailbox, which is what verification is
        // for. An invited member has no other route to a verified address.
        emailVerifiedAt: user.emailVerifiedAt ?? now,
        status: user.status === 'invited' ? 'active' : user.status,
        lastSeenAt: now,
        updatedAt: now,
      },
    },
  );

  await writeAudit({
    orgId: user.orgId,
    action: 'token.rotated',
    // System-initiated: the employee acted on their own machine, not through a
    // dashboard session this API can attribute.
    actorUserId: null,
    subjectUserId: user._id,
    detail: `Daemon ${body.daemonVersion} enrolled for ${user.employeeId}; device token issued`,
    ip: req.ip,
    at: now,
  });

  return ok({
    employeeId: user.employeeId,
    orgId: user.orgId.toHexString(),
    // The only moment this value exists in plaintext anywhere. It is not stored,
    // not logged, and not recoverable — a lost token means re-enrolment.
    deviceToken: device.token,
    wsUrl: deps.config.wsBaseUrl,
  });
};

export const daemonRoutes = [
  { method: 'POST', pattern: '/daemon/enroll', handler: enrollDaemon },
] as const satisfies readonly { method: string; pattern: string; handler: RouteHandler }[];

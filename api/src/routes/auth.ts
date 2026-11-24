import { ObjectId } from 'mongodb';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from '@lily/shared';
import { policyChecked } from '../db/data-policy.js';
import { sessions, users } from '../db/collections.js';
import type { SessionDoc, UserDoc } from '../db/schema.js';
import {
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
  PASSWORD_MAX_LENGTH,
} from '../auth/passwords.js';
import {
  hashToken,
  issueAccessToken,
  issueRefreshToken,
  revokeRefreshFamily,
  rotateRefreshToken,
} from '../auth/tokens.js';
import { codeLimiter, loginLimiter } from '../auth/rate-limit.js';
import { encryptTotpSecret, generateTotpSecret, totpEnrollmentUri, verifyTotp } from '../auth/mfa/totp.js';
import { issueBackupCodes, redeemBackupCode } from '../auth/mfa/backup-codes.js';
import { stepUpExpiresAt } from '../auth/step-up.js';
import { authenticate, requireStepUpFor, type Actor } from './context.js';
import {
  HttpError,
  badRequest,
  conflict,
  created,
  noContent,
  notFound,
  ok,
  parseBody,
  unauthorized,
  type ApiRequest,
  type RouteDeps,
  type RouteHandler,
} from './http.js';
import { presentOrg, presentUser } from './present.js';
import { findOrg, memberCount, newEmployeeId, normalizeEmail, writeAudit } from './support.js';
import { verificationEmail } from '../mail/templates.js';

/**
 * Authentication.
 *
 * Nothing else in this API is reachable without it, and three decisions here
 * shape every other route file:
 *
 *   1. **An org id is reserved at signup, and the org document is created later.**
 *      `UserDoc.orgId` is required, but a user who has just signed up has no
 *      organisation. Rather than making the field nullable — which would push a
 *      null check into every query in the codebase — the id is minted at signup
 *      and `POST /orgs` fills it in. `presentUser` reports `orgId: null` until
 *      the document exists, which is what the dashboard's `User` type expects.
 *
 *   2. **MFA is not a login challenge; it is a step-up challenge.** Login
 *      succeeds with a password alone and yields a session whose `mfaVerifiedAt`
 *      is null. That session can read, and can do nothing privileged: every
 *      administrative action goes through `requireStepUpFor`, which refuses until
 *      a fresh code is presented at `POST /auth/mfa/step-up`. A privileged user
 *      who never enrolled therefore cannot perform a single administrative action,
 *      which is the mandate — enforced by the absence of any path to satisfy
 *      step-up rather than by a flag someone could forget to check.
 *
 *   3. **The verification code exists only in the email.** What is stored is
 *      `sha256(code || pepper)` in `emailVerificationHash`, and it is cleared on
 *      success. There is no code path that can read a live code back out.
 *
 * WebAuthn is deliberately absent. `webauthn_credentials` exists and
 * `web/src/lib/auth/passkeys.ts` describes the seam; there is no enrolment
 * endpoint here and adding one is out of scope for this change.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email('Enter a valid email address.');

const attributionTouchSchema = z.object({
  source: z.string().max(200).nullable(),
  medium: z.string().max(200).nullable(),
  campaign: z.string().max(200).nullable(),
  term: z.string().max(200).nullable(),
  content: z.string().max(200).nullable(),
  gclid: z.string().max(400).nullable(),
  fbclid: z.string().max(400).nullable(),
  referrer: z.string().max(1_000).nullable(),
  landingPath: z.string().max(1_000).nullable(),
  capturedAt: z.string().max(40),
});

export const attributionPayloadSchema = z
  .object({
    firstTouch: attributionTouchSchema.nullable(),
    lastTouch: attributionTouchSchema.nullable(),
  })
  .nullable();

const signupSchema = z.object({
  email: emailSchema,
  // Length is bounded here so a multi-megabyte string never reaches Argon2; the
  // real policy check happens below and reports as a field error.
  password: z.string().max(PASSWORD_MAX_LENGTH).default(''),
  name: z.string().trim().min(1, 'Tell us your name.').max(200),
  provider: z.enum(['password', 'google']).default('password'),
  googleAuthCode: z.string().max(2_000).nullable().optional(),
  attribution: attributionPayloadSchema.optional(),
});

const verifyEmailSchema = z.object({
  email: emailSchema,
  code: z.string().trim().min(1).max(12),
});

const resendSchema = z.object({ email: emailSchema });

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().max(PASSWORD_MAX_LENGTH),
});

const refreshSchema = z.object({ refreshToken: z.string().min(10).max(500) });

const mfaCodeSchema = z.object({ code: z.string().trim().min(1).max(32) });

// ---------------------------------------------------------------------------
// Session establishment
// ---------------------------------------------------------------------------

interface WireTokens {
  readonly accessToken: string;
  readonly expiresInSec: number;
  readonly refreshToken: string;
}

function userAgentOf(req: ApiRequest): string | null {
  const raw = req.headers['user-agent'];
  return raw === undefined || raw === '' ? null : raw.slice(0, 400);
}

/**
 * Open a session: a refresh family, a session row, and an access token.
 *
 * The order is forced by the data. The refresh token creates the family id, the
 * session row is what makes revocation immediate, and the access token has to
 * name the session it belongs to. There is no useful intermediate state — a
 * failure at any step leaves at worst an orphaned refresh token that expires on
 * its own.
 */
async function establishSession(
  user: UserDoc,
  req: ApiRequest,
  now: Date,
  mfaVerifiedAt: Date | null,
): Promise<{ session: SessionDoc; tokens: WireTokens }> {
  const config = getConfig();
  const userAgent = userAgentOf(req);

  const refresh = await issueRefreshToken({
    userId: user._id,
    orgId: user.orgId,
    now,
    // Omitted rather than passed as undefined — exactOptionalPropertyTypes makes
    // those different types, and the store writes null for an absent value.
    ...(req.ip === null ? {} : { ip: req.ip }),
    ...(userAgent === null ? {} : { userAgent }),
  });

  const session: SessionDoc = {
    _id: new ObjectId(),
    userId: user._id,
    orgId: user.orgId,
    familyId: refresh.familyId,
    deviceFingerprint: null,
    ip: req.ip,
    userAgent,
    geoCountry: null,
    lastActiveAt: now,
    absoluteExpiresAt: new Date(now.getTime() + config.auth.session.absoluteLifetimeSec * 1_000),
    mfaVerifiedAt,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const sessionsCol = await sessions();
  await sessionsCol.insertOne(policyChecked(session));

  const access = await issueAccessToken(
    {
      userId: user._id,
      orgId: user.orgId,
      role: user.role,
      sessionId: session._id,
      familyId: refresh.familyId,
      mfaVerified: mfaVerifiedAt !== null,
    },
    now,
  );

  return {
    session,
    tokens: {
      accessToken: access.token,
      expiresInSec: config.auth.accessTokenTtlSec,
      refreshToken: refresh.token,
    },
  };
}

/** The `AuthSession` the dashboard expects: tokens, the user, and their org if it exists. */
async function authSession(user: UserDoc, tokens: WireTokens): Promise<unknown> {
  const org = await findOrg(user.orgId);

  return {
    tokens,
    user: presentUser(user, { orgExists: org !== null }),
    org: org === null ? null : presentOrg(org, await memberCount(org._id)),
  };
}

// ---------------------------------------------------------------------------
// Email verification challenge
// ---------------------------------------------------------------------------

/** Six digits: what people can read off a phone and type without a mistake. */
function newVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — and a mismatch there is not secret, since both sides are fixed-width
 * SHA-256 output.
 */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

async function issueVerificationChallenge(
  user: UserDoc,
  deps: RouteDeps,
  now: Date,
): Promise<void> {
  const code = newVerificationCode();
  const ttlSec = deps.config.auth.emailVerificationTtlSec;

  const usersCol = await users();
  await usersCol.updateOne(
    { _id: user._id },
    {
      $set: {
        emailVerificationHash: await hashToken(code),
        emailVerificationExpiresAt: new Date(now.getTime() + ttlSec * 1_000),
        updatedAt: now,
      },
    },
  );

  // Sent after the hash is committed: a message carrying a code the database has
  // not yet accepted would be a code that does not work.
  await deps.providers.mail.send(
    verificationEmail({
      to: user.email,
      name: user.name,
      code,
      expiresInHours: Math.round(ttlSec / 3_600),
    }),
  );
}

/**
 * Translate a backoff decision into a 429.
 *
 * Only ever applied to the result of `check()`, never to the result of `fail()`.
 * A recorded failure always reports `allowed: false` — that is what it means —
 * so asserting on it would answer 429 to the very first mistyped code and hide
 * the "that code is wrong" message the user actually needs. The penalty is
 * charged on the way out and collected on the *next* attempt.
 *
 * `retryAfterMs` is surfaced in the message rather than only in a header because
 * the dashboard renders `ApiError.message` verbatim and a bare "too many
 * attempts" leaves the user refreshing at random.
 */
function assertNotThrottled(decision: { allowed: boolean; retryAfterMs: number }): void {
  if (decision.allowed) return;
  const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1_000));
  throw new HttpError(
    429,
    'rate_limited',
    `Too many attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
  );
}

// ---------------------------------------------------------------------------
// POST /auth/signup
// ---------------------------------------------------------------------------

export const signup: RouteHandler = async (req, deps) => {
  const body = parseBody(signupSchema, req.body);
  const now = deps.now();

  if (body.provider === 'google') {
    // The button exists in the UI and the OAuth client does not exist here.
    // Failing with a specific message beats a generic 400 that sends someone
    // looking for a bug in their own form.
    throw badRequest('Google sign-in is not configured for this deployment.', {
      provider: 'Use an email and password for now.',
    });
  }

  const policy = checkPasswordPolicy(body.password);
  if (!policy.ok) throw badRequest(policy.message, { password: policy.message });

  const emailNormalized = normalizeEmail(body.email);
  const usersCol = await users();

  const existing = await usersCol.findOne({ emailNormalized });
  if (existing !== null) {
    throw new HttpError(409, 'email_taken', 'That email already has an account.', {
      email: 'An account with this email already exists.',
    });
  }

  const user: UserDoc = {
    _id: new ObjectId(),
    // Reserved now, filled in by POST /orgs. See the note at the top of this file.
    orgId: new ObjectId(),
    employeeId: newEmployeeId(),
    email: body.email.trim(),
    emailNormalized,
    emailVerifiedAt: null,
    name: body.name,
    // Whoever signs up owns the organisation they are about to create. Every
    // other member arrives through an invite, where the inviter sets the role.
    role: 'owner',
    jobDescription: '',
    status: 'invited',
    passwordHash: await hashPassword(body.password),
    mfa: {
      enrolled: false,
      totpSecretEncrypted: null,
      backupCodeHashes: [],
      enrolledAt: null,
      lastVerifiedAt: null,
    },
    emailVerificationHash: null,
    emailVerificationExpiresAt: null,
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
    // The unique index on emailNormalized is the real guard; the read above only
    // makes the common case a clean message. Two simultaneous signups land here.
    if ((error as { code?: unknown }).code === 11000) {
      throw new HttpError(409, 'email_taken', 'That email already has an account.', {
        email: 'An account with this email already exists.',
      });
    }
    throw error;
  }

  await issueVerificationChallenge(user, deps, now);

  return created({
    user: presentUser(user, { orgExists: false }),
    verificationRequired: true,
  });
};

// ---------------------------------------------------------------------------
// POST /auth/verify-email
// ---------------------------------------------------------------------------

export const verifyEmail: RouteHandler = async (req, deps) => {
  const body = parseBody(verifyEmailSchema, req.body);
  const now = deps.now();
  const emailNormalized = normalizeEmail(body.email);

  assertNotThrottled(codeLimiter.check(`verify:${emailNormalized}`, now));

  const usersCol = await users();
  const user = await usersCol.findOne({ emailNormalized });
  if (user === null) throw notFound('No account for that email.');

  const invalid = new HttpError(400, 'invalid_code', 'That code is not right.', {
    code: 'Check the code and try again.',
  });

  // A cleared hash means the challenge was already spent — including by a
  // successful verification. There is no path from "I know the address" to a
  // session; a fresh code has to be requested.
  if (user.emailVerificationHash === null) throw invalid;

  if (
    user.emailVerificationExpiresAt !== null &&
    user.emailVerificationExpiresAt.getTime() <= now.getTime()
  ) {
    throw new HttpError(400, 'invalid_code', 'That code has expired. Ask for a new one.', {
      code: 'Expired — request a new code.',
    });
  }

  if (!hashesMatch(user.emailVerificationHash, await hashToken(body.code.trim()))) {
    codeLimiter.fail(`verify:${emailNormalized}`, now);
    throw invalid;
  }

  codeLimiter.succeed(`verify:${emailNormalized}`);

  await usersCol.updateOne(
    { _id: user._id },
    {
      $set: {
        emailVerifiedAt: now,
        status: 'active',
        emailVerificationHash: null,
        emailVerificationExpiresAt: null,
        updatedAt: now,
      },
    },
  );

  const verified: UserDoc = {
    ...user,
    emailVerifiedAt: now,
    status: 'active',
    emailVerificationHash: null,
    emailVerificationExpiresAt: null,
  };

  const { tokens } = await establishSession(verified, req, now, null);
  return ok(await authSession(verified, tokens));
};

// ---------------------------------------------------------------------------
// POST /auth/verify-email/resend
// ---------------------------------------------------------------------------

export const resendVerification: RouteHandler = async (req, deps) => {
  const body = parseBody(resendSchema, req.body);
  const now = deps.now();
  const emailNormalized = normalizeEmail(body.email);

  // Throttled hard: this endpoint sends mail on demand, so it is both an
  // enumeration oracle and a way to use us to spam a third party.
  assertNotThrottled(codeLimiter.check(`resend:${emailNormalized}`, now));
  codeLimiter.fail(`resend:${emailNormalized}`, now);

  const usersCol = await users();
  const user = await usersCol.findOne({ emailNormalized });
  if (user === null) throw notFound('No account for that email.');

  // Already verified: nothing to resend, and re-arming the challenge would let
  // anyone knock a live account back into an unverified-looking state.
  if (user.emailVerifiedAt === null) await issueVerificationChallenge(user, deps, now);

  return noContent();
};

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

export const login: RouteHandler = async (req, deps) => {
  const body = parseBody(loginSchema, req.body);
  const now = deps.now();
  const emailNormalized = normalizeEmail(body.email);

  assertNotThrottled(loginLimiter.check(emailNormalized, now));

  const usersCol = await users();
  const user = await usersCol.findOne({ emailNormalized });

  // One error for "no such user" and for "wrong password". Distinguishing them
  // turns the login form into an account enumerator, and the response time is
  // kept comparable by hashing a throwaway password when the user is absent.
  const rejected = new HttpError(401, 'invalid_credentials', 'Email or password is not right.');

  if (user === null || user.passwordHash === null) {
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$b3JkaW5hcnlwbGFjZWhvbGRlcmhhc2g',
      body.password,
    );
    loginLimiter.fail(emailNormalized, now);
    throw rejected;
  }

  if (!(await verifyPassword(user.passwordHash, body.password))) {
    loginLimiter.fail(emailNormalized, now);
    throw rejected;
  }

  if (user.status === 'removed' || user.status === 'suspended') {
    loginLimiter.fail(emailNormalized, now);
    throw rejected;
  }

  loginLimiter.succeed(emailNormalized);

  if (user.emailVerifiedAt === null) {
    throw new HttpError(403, 'email_not_verified', 'Verify your email address first.');
  }

  // The only moment the plaintext is available to re-hash with, so it is the only
  // moment a cost increase can be applied to an existing account.
  if (needsRehash(user.passwordHash)) {
    await usersCol.updateOne(
      { _id: user._id },
      { $set: { passwordHash: await hashPassword(body.password), updatedAt: now } },
    );
  }

  const { tokens } = await establishSession(user, req, now, null);
  return ok(await authSession(user, tokens));
};

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------

export const refresh: RouteHandler = async (req, deps) => {
  const body = parseBody(refreshSchema, req.body);
  const now = deps.now();
  const userAgent = userAgentOf(req);

  const result = await rotateRefreshToken({
    presentedToken: body.refreshToken,
    now,
    ...(req.ip === null ? {} : { ip: req.ip }),
    ...(userAgent === null ? {} : { userAgent }),
  });

  if (result.outcome === 'reuse_detected') {
    // The family is already revoked by the rotation itself. This records *why*,
    // because a replayed refresh token is the clearest signal of compromise this
    // system can observe and it must survive in the compliance record.
    await writeAudit({
      orgId: result.orgId,
      action: 'token.reuse_detected',
      actorUserId: null,
      subjectUserId: result.userId,
      detail: `Refresh token replayed; revoked ${result.revokedTokenCount} token(s) in the family`,
      ip: req.ip,
      at: now,
    });

    throw unauthorized('That session has been ended for security. Sign in again.');
  }

  if (result.outcome !== 'rotated') {
    throw unauthorized('Session expired. Sign in again.');
  }

  const sessionsCol = await sessions();
  const session = await sessionsCol.findOne({ familyId: result.familyId, revokedAt: null });
  if (session === null) throw unauthorized('Session ended.');

  const usersCol = await users();
  const user = await usersCol.findOne({ _id: result.userId });
  if (user === null || user.status === 'removed' || user.status === 'suspended') {
    throw unauthorized('This account is no longer active.');
  }

  const access = await issueAccessToken(
    {
      userId: user._id,
      orgId: user.orgId,
      role: user.role,
      sessionId: session._id,
      familyId: result.familyId,
      mfaVerified: session.mfaVerifiedAt !== null,
    },
    now,
  );

  return ok({
    accessToken: access.token,
    expiresInSec: deps.config.auth.accessTokenTtlSec,
    refreshToken: result.refresh.token,
  });
};

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

export const logout: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  const now = deps.now();

  // The whole family, not just this token: the access token is self-contained and
  // would otherwise stay valid for the rest of its fifteen minutes, which is the
  // window a "sign out" is supposed to close.
  await revokeRefreshFamily({ familyId: actor.session.familyId, reason: 'logout', now });

  return noContent();
};

// ---------------------------------------------------------------------------
// POST /auth/mfa/totp/enroll
// ---------------------------------------------------------------------------

const MFA_ISSUER = 'Lily';

export const startTotpEnrollment: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  const now = deps.now();

  // Re-enrolling replaces the existing factor, which is a change of security
  // posture on a live account and therefore needs a fresh challenge first.
  if (actor.user.mfa.enrolled) requireStepUpFor(actor, 'policy.change', now);

  const secret = generateTotpSecret();

  // Stored before it is shown, but `enrolled` stays false: an unconfirmed secret
  // must not satisfy the MFA gate, or enrolment would be a formality anyone could
  // skip by starting it and walking away.
  const usersCol = await users();
  await usersCol.updateOne(
    { _id: actor.userId },
    { $set: { 'mfa.totpSecretEncrypted': await encryptTotpSecret(secret), updatedAt: now } },
  );

  return ok({
    secret,
    otpauthUri: totpEnrollmentUri({
      secret,
      accountName: actor.user.email,
      issuer: MFA_ISSUER,
    }),
    issuer: MFA_ISSUER,
    account: actor.user.email,
  });
};

// ---------------------------------------------------------------------------
// POST /auth/mfa/totp/confirm
// ---------------------------------------------------------------------------

export const confirmTotpEnrollment: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  const body = parseBody(mfaCodeSchema, req.body);
  const now = deps.now();
  const key = `mfa:${actor.userId.toHexString()}`;

  assertNotThrottled(codeLimiter.check(key, now));

  const secret = actor.user.mfa.totpSecretEncrypted;
  if (secret === null) {
    throw conflict('Start enrolment first — there is no secret to confirm.');
  }

  if (!/^\d{6}$/.test(body.code.trim())) {
    throw badRequest('Enter the six-digit code.', { code: 'Six digits, no spaces.' });
  }

  const verification = await verifyTotp({ encryptedSecret: secret, token: body.code.trim(), now });
  if (!verification.valid) {
    codeLimiter.fail(key, now);
    throw new HttpError(400, 'invalid_code', 'That code is not right.', {
      code: 'Check your authenticator app and try again.',
    });
  }

  codeLimiter.succeed(key);

  const usersCol = await users();
  await usersCol.updateOne(
    { _id: actor.userId },
    {
      $set: {
        'mfa.enrolled': true,
        'mfa.enrolledAt': now,
        'mfa.lastVerifiedAt': now,
        updatedAt: now,
      },
    },
  );

  // Confirming enrolment IS a fresh challenge, so the session gets its step-up
  // grace here. Without this the user would enrol and immediately be asked for a
  // second code to do the thing they enrolled in order to do.
  await markSessionVerified(actor, now);

  const { codes } = await issueBackupCodes({ userId: actor.userId, now });

  await writeAudit({
    orgId: actor.orgId,
    action: 'policy.changed',
    actorUserId: actor.userId,
    subjectUserId: actor.userId,
    detail: 'Enrolled in two-factor authentication (TOTP)',
    ip: req.ip,
    at: now,
  });

  return ok({ backupCodes: codes, enrolledAt: now.toISOString() });
};

// ---------------------------------------------------------------------------
// POST /auth/mfa/step-up
// ---------------------------------------------------------------------------

async function markSessionVerified(actor: Actor, now: Date): Promise<void> {
  const sessionsCol = await sessions();
  await sessionsCol.updateOne(
    { _id: actor.session._id },
    { $set: { mfaVerifiedAt: now, lastActiveAt: now, updatedAt: now } },
  );
}

/**
 * Re-prove identity for an administrative action.
 *
 * Accepts a TOTP code or a backup code, because the failure mode this exists for
 * — an unattended or hijacked session — is not the failure mode a lost phone is,
 * and locking someone out of their own org over a dead battery is not a security
 * win. A backup code is single-use and its redemption is atomic, so it cannot be
 * replayed even if it is observed.
 */
export const stepUp: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  const body = parseBody(mfaCodeSchema, req.body);
  const now = deps.now();
  const key = `stepup:${actor.userId.toHexString()}`;

  assertNotThrottled(codeLimiter.check(key, now));

  if (!actor.user.mfa.enrolled || actor.user.mfa.totpSecretEncrypted === null) {
    throw new HttpError(
      403,
      'mfa_enrollment_required',
      'Enrol in two-factor authentication before performing administrative actions.',
    );
  }

  const candidate = body.code.trim();
  let accepted = false;

  if (/^\d{6}$/.test(candidate)) {
    accepted = (
      await verifyTotp({
        encryptedSecret: actor.user.mfa.totpSecretEncrypted,
        token: candidate,
        now,
      })
    ).valid;
  }

  // Only tried when the code is not a live TOTP, so a legitimate six-digit code
  // never burns a backup code by accident.
  if (!accepted) {
    accepted = (await redeemBackupCode({ userId: actor.userId, code: candidate, now })).accepted;
  }

  if (!accepted) {
    codeLimiter.fail(key, now);
    throw new HttpError(400, 'invalid_code', 'That code is not right.', {
      code: 'Use your authenticator app or a backup code.',
    });
  }

  codeLimiter.succeed(key);

  const usersCol = await users();
  await usersCol.updateOne(
    { _id: actor.userId },
    { $set: { 'mfa.lastVerifiedAt': now, updatedAt: now } },
  );
  await markSessionVerified(actor, now);

  const expires = stepUpExpiresAt({ mfaVerifiedAt: now });

  return ok({
    verifiedAt: now.toISOString(),
    expiresAt: expires === null ? null : expires.toISOString(),
  });
};

// ---------------------------------------------------------------------------
// POST /auth/mfa/backup-codes
// ---------------------------------------------------------------------------

/**
 * Regenerate the set, invalidating the old one.
 *
 * Behind step-up because holding a session is not evidence of being the account
 * holder, and a silently regenerated set is how someone gets locked out of their
 * own recovery path without noticing.
 */
export const regenerateBackupCodes: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  const now = deps.now();

  requireStepUpFor(actor, 'policy.change', now);

  const { codes } = await issueBackupCodes({ userId: actor.userId, now });

  await writeAudit({
    orgId: actor.orgId,
    action: 'policy.changed',
    actorUserId: actor.userId,
    subjectUserId: actor.userId,
    detail: 'Regenerated two-factor backup codes',
    ip: req.ip,
    at: now,
  });

  return ok({ backupCodes: codes, generatedAt: now.toISOString() });
};

// ---------------------------------------------------------------------------

export const authRoutes = [
  { method: 'POST', pattern: '/auth/signup', handler: signup },
  { method: 'POST', pattern: '/auth/login', handler: login },
  { method: 'POST', pattern: '/auth/refresh', handler: refresh },
  { method: 'POST', pattern: '/auth/logout', handler: logout },
  { method: 'POST', pattern: '/auth/verify-email', handler: verifyEmail },
  { method: 'POST', pattern: '/auth/verify-email/resend', handler: resendVerification },
  { method: 'POST', pattern: '/auth/mfa/totp/enroll', handler: startTotpEnrollment },
  { method: 'POST', pattern: '/auth/mfa/totp/confirm', handler: confirmTotpEnrollment },
  { method: 'POST', pattern: '/auth/mfa/step-up', handler: stepUp },
  { method: 'POST', pattern: '/auth/mfa/backup-codes', handler: regenerateBackupCodes },
] as const satisfies readonly { method: string; pattern: string; handler: RouteHandler }[];

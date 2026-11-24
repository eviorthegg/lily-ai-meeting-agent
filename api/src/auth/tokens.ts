import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { ObjectId, type ClientSession, type Db, type TransactionOptions } from 'mongodb';
import { getConfig } from '@lily/shared';
import { policyChecked } from '../db/data-policy.js';
import type { DaemonTokenDoc, RefreshTokenDoc, Role } from '../db/schema.js';
import { accessTokenSigningKey, tokenPepper } from './keys.js';
import {
  daemonTokensIn,
  refreshTokensIn,
  resolveStore,
  sessionsIn,
  withSession,
  type AuthStore,
} from './store.js';

/**
 * Token issuance, verification and rotation.
 *
 * Two kinds of token, deliberately different shapes:
 *
 *   Access tokens are JWTs. They are short-lived, self-contained and read on
 *   every request; a database round trip per request to validate them would be
 *   the wrong trade.
 *
 *   Refresh and device tokens are opaque random strings, *not* JWTs. They are
 *   long-lived and must be revocable the instant a compromise is noticed, which
 *   a self-contained token cannot be. Only `sha256(token || pepper)` is stored,
 *   so a database dump yields nothing usable without the pepper, which lives in
 *   the secrets store.
 *
 * The raw value of an opaque token exists exactly once — in the response that
 * issues it. It is never written to a document and never passed to a logger.
 */

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

export interface AccessTokenSubject {
  readonly userId: ObjectId;
  readonly orgId: ObjectId;
  readonly role: Role;
  readonly sessionId: ObjectId;
  /** Ties the access token to the refresh family, so revoking the family is enforceable. */
  readonly familyId: string;
  /** Whether this session has passed an MFA challenge. Never taken from the client. */
  readonly mfaVerified: boolean;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface AccessTokenClaims {
  readonly userId: string;
  readonly orgId: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly familyId: string;
  readonly mfaVerified: boolean;
  readonly expiresAt: Date;
}

export type AccessTokenVerification =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly reason: 'expired' | 'invalid' };

/**
 * Stage is part of the issuer, so a token minted by dev is not merely untrusted
 * by prod — it fails the issuer check before any signature question arises.
 */
function issuer(): string {
  const config = getConfig();
  return `${config.serviceName}:${config.stage}`;
}

function audience(): string {
  return `${getConfig().serviceName}-api`;
}

/** Small allowance for clock drift between the signer and the verifier. */
const CLOCK_TOLERANCE_SEC = 5;

export async function issueAccessToken(
  subject: AccessTokenSubject,
  now: Date = new Date(),
): Promise<IssuedAccessToken> {
  const key = await accessTokenSigningKey();
  const expiresAt = new Date(now.getTime() + getConfig().auth.accessTokenTtlSec * 1_000);

  const token = await new SignJWT({
    org: subject.orgId.toHexString(),
    role: subject.role,
    sid: subject.sessionId.toHexString(),
    fam: subject.familyId,
    mfa: subject.mfaVerified,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(subject.userId.toHexString())
    .setIssuer(issuer())
    .setAudience(audience())
    .setIssuedAt(Math.floor(now.getTime() / 1_000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
    .setJti(randomBytes(16).toString('base64url'))
    .sign(key);

  return { token, expiresAt };
}

function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'admin' || value === 'manager' || value === 'employee';
}

export async function verifyAccessToken(token: string): Promise<AccessTokenVerification> {
  const key = await accessTokenSigningKey();

  let payload;
  try {
    // Pinning the algorithm is the point of this call, not a formality: without
    // it the verifier accepts whatever the token's own header asks for, which is
    // how algorithm-confusion attacks work.
    ({ payload } = await jwtVerify(token, key, {
      issuer: issuer(),
      audience: audience(),
      algorithms: ['HS256'],
      clockTolerance: CLOCK_TOLERANCE_SEC,
    }));
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    return { ok: false, reason: code === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid' };
  }

  const { sub, org, role, sid, fam, mfa, exp } = payload;

  if (
    typeof sub !== 'string' ||
    typeof org !== 'string' ||
    !isRole(role) ||
    typeof sid !== 'string' ||
    typeof fam !== 'string' ||
    typeof mfa !== 'boolean' ||
    typeof exp !== 'number'
  ) {
    return { ok: false, reason: 'invalid' };
  }

  return {
    ok: true,
    claims: {
      userId: sub,
      orgId: org,
      role,
      sessionId: sid,
      familyId: fam,
      mfaVerified: mfa,
      expiresAt: new Date(exp * 1_000),
    },
  };
}

// ---------------------------------------------------------------------------
// Opaque tokens
// ---------------------------------------------------------------------------

/** 256 bits. Guessing is not a threat model at this width; theft is. */
const OPAQUE_TOKEN_BYTES = 32;

export function generateOpaqueToken(byteLength: number = OPAQUE_TOKEN_BYTES): string {
  return randomBytes(byteLength).toString('base64url');
}

export function newFamilyId(): string {
  return `fam_${randomBytes(16).toString('base64url')}`;
}

/**
 * `sha256(token || pepper)`, per the note on `DaemonTokenDoc`.
 *
 * A plain hash rather than Argon2 on purpose. The input is 256 bits of CSPRNG
 * output, so there is no dictionary to grind and no work factor worth paying;
 * what an attacker with the database needs is the pepper, and no amount of
 * stretching would substitute for it. Argon2 here would only add tens of
 * milliseconds to every authenticated request.
 */
export async function hashToken(rawToken: string): Promise<string> {
  const pepper = await tokenPepper();
  return createHash('sha256').update(rawToken, 'utf8').update(pepper).digest('hex');
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export interface RefreshTokenContext {
  readonly deviceFingerprint?: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface IssueRefreshTokenInput extends RefreshTokenContext {
  readonly userId: ObjectId;
  readonly orgId: ObjectId;
  /** Omit to start a new family. */
  readonly familyId?: string;
  /** Omit for `now + refreshTokenTtlSec`. */
  readonly expiresAt?: Date;
  readonly store?: AuthStore;
  readonly now?: Date;
}

export interface IssuedRefreshToken {
  /**
   * The raw token. This is the only place it ever exists — it is not stored, and
   * putting it in a log line would be equivalent to storing it.
   */
  readonly token: string;
  readonly familyId: string;
  readonly expiresAt: Date;
}

const TRANSACTION_OPTIONS: TransactionOptions = {
  readConcern: { level: 'majority' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

async function insertRefreshToken(
  db: Db,
  input: {
    readonly userId: ObjectId;
    readonly orgId: ObjectId;
    readonly familyId: string;
    readonly expiresAt: Date;
    readonly now: Date;
    readonly context: RefreshTokenContext;
  },
  session?: ClientSession,
): Promise<IssuedRefreshToken> {
  const token = generateOpaqueToken();
  const tokenHash = await hashToken(token);

  await refreshTokensIn(db).insertOne(
    // Cheap insurance: the data-policy guard rejects a field literally named
    // `refreshToken`, which is exactly the mistake this document is one careless
    // edit away from.
    policyChecked<RefreshTokenDoc>({
      _id: new ObjectId(),
      userId: input.userId,
      orgId: input.orgId,
      familyId: input.familyId,
      tokenHash,
      expiresAt: input.expiresAt,
      consumedAt: null,
      revokedAt: null,
      revokedReason: null,
      deviceFingerprint: input.context.deviceFingerprint ?? null,
      ip: input.context.ip ?? null,
      userAgent: input.context.userAgent ?? null,
      createdAt: input.now,
      updatedAt: input.now,
    }),
    withSession(session),
  );

  return { token, familyId: input.familyId, expiresAt: input.expiresAt };
}

export async function issueRefreshToken(
  input: IssueRefreshTokenInput,
): Promise<IssuedRefreshToken> {
  const store = await resolveStore(input.store);
  const now = input.now ?? new Date();
  const expiresAt =
    input.expiresAt ?? new Date(now.getTime() + getConfig().auth.refreshTokenTtlSec * 1_000);

  return insertRefreshToken(store.db, {
    userId: input.userId,
    orgId: input.orgId,
    familyId: input.familyId ?? newFamilyId(),
    expiresAt,
    now,
    context: input,
  });
}

export type RefreshRevocationReason = NonNullable<RefreshTokenDoc['revokedReason']>;

export interface RotateRefreshTokenInput extends RefreshTokenContext {
  /** The raw token the client presented. Never logged, never stored. */
  readonly presentedToken: string;
  readonly store?: AuthStore;
  readonly now?: Date;
}

export type RefreshRotationResult =
  | {
      readonly outcome: 'rotated';
      readonly refresh: IssuedRefreshToken;
      readonly userId: ObjectId;
      readonly orgId: ObjectId;
      readonly familyId: string;
    }
  | {
      readonly outcome: 'reuse_detected';
      readonly userId: ObjectId;
      readonly orgId: ObjectId;
      readonly familyId: string;
      readonly revokedTokenCount: number;
    }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired'; readonly familyId: string }
  | {
      readonly outcome: 'revoked';
      readonly familyId: string;
      readonly reason: RefreshRevocationReason | null;
    };

async function revokeFamilyWithin(
  db: Db,
  familyId: string,
  reason: RefreshRevocationReason,
  now: Date,
  session?: ClientSession,
): Promise<number> {
  const tokens = await refreshTokensIn(db).updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: reason, updatedAt: now } },
    withSession(session),
  );

  // Revoking the tokens without ending the sessions would leave the already-issued
  // access tokens live for up to their full TTL, which is the window the attacker
  // is actually holding.
  await sessionsIn(db).updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: now, updatedAt: now } },
    withSession(session),
  );

  return tokens.modifiedCount;
}

/**
 * Exchange a refresh token for a new one, with reuse detection.
 *
 * The whole exchange runs in one transaction. Consuming the presented token and
 * issuing its replacement are a single fact: if the process died between them the
 * client would be left holding a token the server had already retired, and the
 * next request would look exactly like an attack.
 *
 * Replay is the interesting case. A legitimate client never presents a token it
 * has already exchanged — it has the replacement. So a second presentation means
 * two parties hold the same token, and there is no way to tell which one is the
 * user. Revoking only the replayed token would leave whichever party currently
 * holds the live token authenticated, and that is as likely to be the attacker as
 * the victim. The entire family goes.
 */
export async function rotateRefreshToken(
  input: RotateRefreshTokenInput,
): Promise<RefreshRotationResult> {
  const store = await resolveStore(input.store);
  const now = input.now ?? new Date();
  const presentedHash = await hashToken(input.presentedToken);
  const session = store.client.startSession();

  try {
    return await session.withTransaction<RefreshRotationResult>(async (txn) => {
      const tokens = refreshTokensIn(store.db);
      const presented = await tokens.findOne({ tokenHash: presentedHash }, { session: txn });

      if (presented === null) return { outcome: 'unknown' };

      const { familyId, userId, orgId } = presented;

      // Checked before `revokedAt`, because a rotated token carries both and the
      // replay of one is the signal we care about.
      if (presented.consumedAt !== null) {
        const revokedTokenCount = await revokeFamilyWithin(
          store.db,
          familyId,
          'reuse_detected',
          now,
          txn,
        );
        return { outcome: 'reuse_detected', userId, orgId, familyId, revokedTokenCount };
      }

      if (presented.revokedAt !== null) {
        return { outcome: 'revoked', familyId, reason: presented.revokedReason };
      }

      if (presented.expiresAt.getTime() <= now.getTime()) {
        return { outcome: 'expired', familyId };
      }

      const claimed = await tokens.updateOne(
        { _id: presented._id, consumedAt: null },
        { $set: { consumedAt: now, revokedAt: now, revokedReason: 'rotated', updatedAt: now } },
        { session: txn },
      );

      // The filter is the guard, not the read above: if a concurrent exchange
      // consumed this token first, exactly one of the two updates matches, and the
      // loser is by definition a second use of the same token.
      if (claimed.modifiedCount !== 1) {
        const revokedTokenCount = await revokeFamilyWithin(
          store.db,
          familyId,
          'reuse_detected',
          now,
          txn,
        );
        return { outcome: 'reuse_detected', userId, orgId, familyId, revokedTokenCount };
      }

      const refresh = await insertRefreshToken(
        store.db,
        {
          userId,
          orgId,
          familyId,
          // The family's expiry is carried forward rather than extended.
          // `refreshTokenTtlSec` is the outer bound on a family's life, and a
          // token that renewed its own deadline on every use would never reach it.
          expiresAt: presented.expiresAt,
          now,
          context: {
            ...(input.deviceFingerprint === undefined
              ? presented.deviceFingerprint === null
                ? {}
                : { deviceFingerprint: presented.deviceFingerprint }
              : { deviceFingerprint: input.deviceFingerprint }),
            ...(input.ip === undefined ? {} : { ip: input.ip }),
            ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
          },
        },
        txn,
      );

      await sessionsIn(store.db).updateMany(
        { familyId, revokedAt: null },
        { $set: { lastActiveAt: now, updatedAt: now } },
        { session: txn },
      );

      return { outcome: 'rotated', refresh, userId, orgId, familyId };
    }, TRANSACTION_OPTIONS);
  } finally {
    await session.endSession();
  }
}

/** Revoke every live token in a family, and end the sessions that belong to it. */
export async function revokeRefreshFamily(input: {
  readonly familyId: string;
  readonly reason: RefreshRevocationReason;
  readonly store?: AuthStore;
  readonly now?: Date;
}): Promise<number> {
  const store = await resolveStore(input.store);
  return revokeFamilyWithin(store.db, input.familyId, input.reason, input.now ?? new Date());
}

/** Every family the user has. Used on logout-everywhere and employee removal. */
export async function revokeAllRefreshTokensForUser(input: {
  readonly userId: ObjectId;
  readonly reason: RefreshRevocationReason;
  readonly store?: AuthStore;
  readonly now?: Date;
}): Promise<number> {
  const store = await resolveStore(input.store);
  const now = input.now ?? new Date();

  const tokens = await refreshTokensIn(store.db).updateMany(
    { userId: input.userId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: input.reason, updatedAt: now } },
  );

  await sessionsIn(store.db).updateMany(
    { userId: input.userId, revokedAt: null },
    { $set: { revokedAt: now, updatedAt: now } },
  );

  return tokens.modifiedCount;
}

// ---------------------------------------------------------------------------
// Daemon device tokens
// ---------------------------------------------------------------------------

export type DeviceRevocationReason = NonNullable<DaemonTokenDoc['revokedReason']>;

export interface IssueDeviceTokenInput {
  readonly userId: ObjectId;
  readonly orgId: ObjectId;
  readonly employeeId: string;
  readonly deviceFingerprint?: string;
  /** Set by `rotateDeviceToken`; absent on first enrolment. */
  readonly previousTokenHash?: string;
  readonly store?: AuthStore;
  readonly now?: Date;
}

export interface IssuedDeviceToken {
  /** Raw token. Handed to the daemon once and never recoverable afterwards. */
  readonly token: string;
  readonly tokenId: ObjectId;
  readonly rotatesAt: Date;
}

async function insertDeviceToken(
  db: Db,
  input: IssueDeviceTokenInput,
  now: Date,
  session?: ClientSession,
): Promise<IssuedDeviceToken> {
  const token = generateOpaqueToken();
  const tokenHash = await hashToken(token);
  const tokenId = new ObjectId();
  const rotatesAt = new Date(now.getTime() + getConfig().auth.deviceTokenRotationSec * 1_000);

  await daemonTokensIn(db).insertOne(
    policyChecked<DaemonTokenDoc>({
      _id: tokenId,
      orgId: input.orgId,
      userId: input.userId,
      employeeId: input.employeeId,
      tokenHash,
      previousTokenHash: input.previousTokenHash ?? null,
      rotatesAt,
      revokedAt: null,
      revokedReason: null,
      lastUsedAt: null,
      deviceFingerprint: input.deviceFingerprint ?? null,
      createdAt: now,
      updatedAt: now,
    }),
    withSession(session),
  );

  return { token, tokenId, rotatesAt };
}

export async function issueDeviceToken(
  input: IssueDeviceTokenInput,
): Promise<IssuedDeviceToken> {
  const store = await resolveStore(input.store);
  return insertDeviceToken(store.db, input, input.now ?? new Date());
}

export type DeviceTokenVerification =
  | { readonly outcome: 'valid'; readonly token: DaemonTokenDoc; readonly rotationDue: boolean }
  | { readonly outcome: 'superseded'; readonly token: DaemonTokenDoc }
  | {
      readonly outcome: 'revoked';
      readonly token: DaemonTokenDoc;
      readonly reason: DeviceRevocationReason | null;
    }
  | { readonly outcome: 'unknown' };

/**
 * Verify a device token presented by a daemon.
 *
 * `superseded` means the presented token matches some record's
 * `previousTokenHash` — the daemon is still holding the token it was supposed to
 * replace, which happens for real when a rotation response is lost on a flaky
 * connection, and also happens when something copied an old token off the disk.
 *
 * Unlike a replayed refresh token this does not revoke anything. There is no
 * family here: a device chain has exactly one live member, the superseded token
 * was already revoked at rotation, and presenting it grants nothing. Refusing the
 * connection and making the daemon present its current token resolves the honest
 * case; a daemon that cannot is re-enrolled by its owner. Revoking on every lost
 * acknowledgement would turn rotation itself into a denial of service.
 */
export async function verifyDeviceToken(input: {
  readonly presentedToken: string;
  readonly store?: AuthStore;
  readonly now?: Date;
}): Promise<DeviceTokenVerification> {
  const store = await resolveStore(input.store);
  const now = input.now ?? new Date();
  const presentedHash = await hashToken(input.presentedToken);
  const tokens = daemonTokensIn(store.db);

  const current = await tokens.findOne({ tokenHash: presentedHash });

  if (current === null) {
    // No record under this hash at all — but it may still be the pre-rotation
    // token of a chain whose predecessor document has since been cleaned up.
    const successor = await tokens.findOne({ previousTokenHash: presentedHash });
    return successor === null
      ? { outcome: 'unknown' }
      : { outcome: 'superseded', token: successor };
  }

  if (current.revokedAt !== null) {
    // Rotation is the one revocation reason with a successor to point at, and the
    // predecessor document outlives the rotation, so it is found here first. Every
    // other reason — removal, admin revoke, reuse — is a hard stop with nothing to
    // fall forward to.
    if (current.revokedReason === 'rotation') {
      const successor = await tokens.findOne({ previousTokenHash: presentedHash });
      if (successor !== null) return { outcome: 'superseded', token: successor };
    }

    return { outcome: 'revoked', token: current, reason: current.revokedReason };
  }

  await tokens.updateOne({ _id: current._id }, { $set: { lastUsedAt: now, updatedAt: now } });

  return {
    outcome: 'valid',
    token: current,
    rotationDue: current.rotatesAt.getTime() <= now.getTime(),
  };
}

export type DeviceRotationResult =
  | { readonly outcome: 'rotated'; readonly device: IssuedDeviceToken }
  | { readonly outcome: 'unknown' }
  | {
      readonly outcome: 'revoked';
      readonly reason: DeviceRevocationReason | null;
    };

/**
 * Retire the presented device token and issue its replacement.
 *
 * Called on the rotation schedule and on every reconnect, so a token that leaked
 * has a bounded useful life even if nobody notices the leak. The retired hash is
 * kept as `previousTokenHash` so the next presentation of it is recognisable as
 * superseded rather than merely unknown.
 */
export async function rotateDeviceToken(input: {
  readonly presentedToken: string;
  readonly deviceFingerprint?: string;
  readonly store?: AuthStore;
  readonly now?: Date;
}): Promise<DeviceRotationResult> {
  const store = await resolveStore(input.store);
  const now = input.now ?? new Date();
  const presentedHash = await hashToken(input.presentedToken);
  const session = store.client.startSession();

  try {
    return await session.withTransaction<DeviceRotationResult>(async (txn) => {
      const tokens = daemonTokensIn(store.db);
      const current = await tokens.findOne({ tokenHash: presentedHash }, { session: txn });

      if (current === null) return { outcome: 'unknown' };
      if (current.revokedAt !== null) {
        return { outcome: 'revoked', reason: current.revokedReason };
      }

      await tokens.updateOne(
        { _id: current._id },
        { $set: { revokedAt: now, revokedReason: 'rotation', updatedAt: now } },
        { session: txn },
      );

      const device = await insertDeviceToken(
        store.db,
        {
          userId: current.userId,
          orgId: current.orgId,
          employeeId: current.employeeId,
          previousTokenHash: presentedHash,
          ...(input.deviceFingerprint === undefined
            ? current.deviceFingerprint === null
              ? {}
              : { deviceFingerprint: current.deviceFingerprint }
            : { deviceFingerprint: input.deviceFingerprint }),
        },
        now,
        txn,
      );

      return { outcome: 'rotated', device };
    }, TRANSACTION_OPTIONS);
  } finally {
    await session.endSession();
  }
}

export async function revokeDeviceTokensForUser(input: {
  readonly userId: ObjectId;
  readonly reason: DeviceRevocationReason;
  readonly store?: AuthStore;
  readonly now?: Date;
}): Promise<number> {
  const store = await resolveStore(input.store);
  const now = input.now ?? new Date();

  const result = await daemonTokensIn(store.db).updateMany(
    { userId: input.userId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: input.reason, updatedAt: now } },
  );

  return result.modifiedCount;
}

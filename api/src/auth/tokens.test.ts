import { afterAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { SignJWT } from 'jose';
import { getConfig } from '@lily/shared';
import { COLLECTIONS } from '../db/collections.js';
import type { RefreshTokenDoc, SessionDoc } from '../db/schema.js';
import { accessTokenSigningKey, resetAuthKeyCache } from './keys.js';
import {
  generateOpaqueToken,
  hashToken,
  issueAccessToken,
  issueDeviceToken,
  issueRefreshToken,
  newFamilyId,
  rotateDeviceToken,
  rotateRefreshToken,
  verifyAccessToken,
  verifyDeviceToken,
} from './tokens.js';
import type { AuthStore } from './store.js';
import { openTestDatabase, useTestAuthSecrets } from './test-support.js';

useTestAuthSecrets();

const testDb = await openTestDatabase('tokens');

afterAll(async () => {
  await testDb?.drop();
});

function store(): AuthStore {
  // Unreachable while the suite is skipped, which is the only case where testDb
  // is null.
  if (testDb === null) throw new Error('mongod unavailable');
  return testDb.store;
}

function refreshDocs(): Promise<RefreshTokenDoc[]> {
  return store().db.collection<RefreshTokenDoc>(COLLECTIONS.refreshTokens).find({}).toArray();
}

async function seedSession(userId: ObjectId, orgId: ObjectId, familyId: string): Promise<ObjectId> {
  const _id = new ObjectId();
  const now = new Date();

  await store()
    .db.collection<SessionDoc>(COLLECTIONS.sessions)
    .insertOne({
      _id,
      userId,
      orgId,
      familyId,
      deviceFingerprint: null,
      ip: null,
      userAgent: null,
      geoCountry: null,
      lastActiveAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 12 * 3_600_000),
      mfaVerifiedAt: now,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

  return _id;
}

describe.skipIf(testDb === null)('refresh token rotation', () => {
  it('rotates repeatedly without falsely revoking the family', async () => {
    const userId = new ObjectId();
    const orgId = new ObjectId();

    const first = await issueRefreshToken({ userId, orgId, store: store() });
    let current = first;

    // Five honest exchanges. A false positive anywhere in this chain would lock a
    // normal user out of their own session, so this is the case that has to hold.
    for (let i = 0; i < 5; i += 1) {
      const result = await rotateRefreshToken({
        presentedToken: current.token,
        store: store(),
      });

      expect(result.outcome).toBe('rotated');
      if (result.outcome !== 'rotated') return;

      expect(result.familyId).toBe(first.familyId);
      expect(result.refresh.token).not.toBe(current.token);
      current = result.refresh;
    }

    const family = (await refreshDocs()).filter((d) => d.familyId === first.familyId);
    expect(family).toHaveLength(6);

    // Nothing in the chain was ever flagged as reuse.
    expect(family.some((d) => d.revokedReason === 'reuse_detected')).toBe(false);

    // Exactly one live member: the newest.
    const live = family.filter((d) => d.revokedAt === null && d.consumedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.tokenHash).toBe(await hashToken(current.token));
  });

  it('revokes the entire family when a consumed token is replayed', async () => {
    const userId = new ObjectId();
    const orgId = new ObjectId();

    const a = await issueRefreshToken({ userId, orgId, store: store() });
    await seedSession(userId, orgId, a.familyId);

    const firstRotation = await rotateRefreshToken({ presentedToken: a.token, store: store() });
    expect(firstRotation.outcome).toBe('rotated');
    if (firstRotation.outcome !== 'rotated') return;
    const b = firstRotation.refresh;

    const secondRotation = await rotateRefreshToken({ presentedToken: b.token, store: store() });
    expect(secondRotation.outcome).toBe('rotated');
    if (secondRotation.outcome !== 'rotated') return;
    const c = secondRotation.refresh;

    // The attacker replays A, which the legitimate client exchanged two steps ago.
    const replay = await rotateRefreshToken({ presentedToken: a.token, store: store() });
    expect(replay.outcome).toBe('reuse_detected');
    if (replay.outcome !== 'reuse_detected') return;
    expect(replay.familyId).toBe(a.familyId);

    const family = (await refreshDocs()).filter((d) => d.familyId === a.familyId);
    expect(family).toHaveLength(3);
    expect(family.every((d) => d.revokedAt !== null)).toBe(true);

    // C was the only live member, so it is the one that had to be revoked *because
    // of* the replay rather than by ordinary rotation.
    const newestHash = await hashToken(c.token);
    const newest = family.find((d) => d.tokenHash === newestHash);
    expect(newest?.revokedReason).toBe('reuse_detected');

    // The legitimate client's current token is now dead. This is the point of the
    // whole mechanism: at replay time the attacker and the user are
    // indistinguishable, so both are logged out.
    const afterRevocation = await rotateRefreshToken({ presentedToken: c.token, store: store() });
    expect(afterRevocation.outcome).toBe('revoked');
    if (afterRevocation.outcome !== 'revoked') return;
    expect(afterRevocation.reason).toBe('reuse_detected');

    // B was already consumed, so replaying it reports reuse again rather than
    // silently succeeding.
    const replayB = await rotateRefreshToken({ presentedToken: b.token, store: store() });
    expect(replayB.outcome).toBe('reuse_detected');

    // The session behind the family is ended too — otherwise the access token
    // already in the attacker's hands stays live for its full TTL.
    const sessions = await store()
      .db.collection<SessionDoc>(COLLECTIONS.sessions)
      .find({ familyId: a.familyId })
      .toArray();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revokedAt).not.toBeNull();
  });

  it('leaves other families untouched when one is revoked for reuse', async () => {
    const userId = new ObjectId();
    const orgId = new ObjectId();

    const laptop = await issueRefreshToken({ userId, orgId, store: store() });
    const phone = await issueRefreshToken({ userId, orgId, store: store() });
    expect(laptop.familyId).not.toBe(phone.familyId);

    const rotated = await rotateRefreshToken({ presentedToken: laptop.token, store: store() });
    expect(rotated.outcome).toBe('rotated');

    await rotateRefreshToken({ presentedToken: laptop.token, store: store() });

    // Revocation is scoped to the compromised family: signing out of a laptop
    // must not sign the user out of their phone.
    const stillGood = await rotateRefreshToken({ presentedToken: phone.token, store: store() });
    expect(stillGood.outcome).toBe('rotated');
  });

  it('carries the family expiry forward instead of extending it on every use', async () => {
    const userId = new ObjectId();
    const orgId = new ObjectId();

    const first = await issueRefreshToken({ userId, orgId, store: store() });
    const rotated = await rotateRefreshToken({ presentedToken: first.token, store: store() });

    expect(rotated.outcome).toBe('rotated');
    if (rotated.outcome !== 'rotated') return;

    // refreshTokenTtlSec is the outer bound on the family's life. A token that
    // renewed its own deadline every 15 minutes would never reach it.
    expect(rotated.refresh.expiresAt.getTime()).toBe(first.expiresAt.getTime());
  });

  it('reports an expired token as expired rather than rotating it', async () => {
    const userId = new ObjectId();
    const orgId = new ObjectId();
    const past = new Date(Date.now() - 60_000);

    const stale = await issueRefreshToken({
      userId,
      orgId,
      expiresAt: past,
      store: store(),
    });

    const result = await rotateRefreshToken({ presentedToken: stale.token, store: store() });
    expect(result.outcome).toBe('expired');
  });

  it('reports an unrecognised token as unknown and writes nothing', async () => {
    const before = (await refreshDocs()).length;

    const result = await rotateRefreshToken({
      presentedToken: generateOpaqueToken(),
      store: store(),
    });

    expect(result.outcome).toBe('unknown');
    expect((await refreshDocs()).length).toBe(before);
  });

  it('never writes the raw token to the database', async () => {
    const userId = new ObjectId();
    const orgId = new ObjectId();

    const issued = await issueRefreshToken({ userId, orgId, store: store() });
    const rotated = await rotateRefreshToken({ presentedToken: issued.token, store: store() });
    expect(rotated.outcome).toBe('rotated');
    if (rotated.outcome !== 'rotated') return;

    const dump = JSON.stringify(await refreshDocs());
    expect(dump).not.toContain(issued.token);
    expect(dump).not.toContain(rotated.refresh.token);

    // What is stored is the peppered hash, and only that.
    expect(dump).toContain(await hashToken(rotated.refresh.token));
  });

  it('derives a different hash for the same token under a different pepper', async () => {
    const raw = generateOpaqueToken();
    const withRealPepper = await hashToken(raw);

    // The pepper is what makes a stolen `refresh_tokens` dump useless on its own.
    // If the hash did not move with it, it would not be doing that job.
    process.env['LILY_LOCAL_TOKEN_PEPPER'] = 'a-completely-different-pepper-000000';
    resetAuthKeyCache();

    expect(await hashToken(raw)).not.toBe(withRealPepper);

    useTestAuthSecrets();
    expect(await hashToken(raw)).toBe(withRealPepper);
  });
});

describe.skipIf(testDb === null)('daemon device tokens', () => {
  it('rotates and recognises the superseded token rather than treating it as unknown', async () => {
    const userId = new ObjectId();
    const orgId = new ObjectId();

    const first = await issueDeviceToken({
      userId,
      orgId,
      employeeId: 'sarah',
      store: store(),
    });

    const initial = await verifyDeviceToken({ presentedToken: first.token, store: store() });
    expect(initial.outcome).toBe('valid');

    const rotated = await rotateDeviceToken({ presentedToken: first.token, store: store() });
    expect(rotated.outcome).toBe('rotated');
    if (rotated.outcome !== 'rotated') return;

    const replacement = await verifyDeviceToken({
      presentedToken: rotated.device.token,
      store: store(),
    });
    expect(replacement.outcome).toBe('valid');

    // The old token is superseded, not unknown — the distinction is what lets the
    // daemon be told to re-present its current token instead of re-enrolling.
    const old = await verifyDeviceToken({ presentedToken: first.token, store: store() });
    expect(old.outcome).toBe('superseded');
    if (old.outcome !== 'superseded') return;
    expect(old.token.previousTokenHash).toBe(await hashToken(first.token));
  });

  it('flags a token whose rotation is due', async () => {
    const userId = new ObjectId();
    const orgId = new ObjectId();
    const rotationSec = getConfig().auth.deviceTokenRotationSec;

    const issued = await issueDeviceToken({
      userId,
      orgId,
      employeeId: 'john',
      store: store(),
    });

    const fresh = await verifyDeviceToken({ presentedToken: issued.token, store: store() });
    expect(fresh.outcome).toBe('valid');
    if (fresh.outcome !== 'valid') return;
    expect(fresh.rotationDue).toBe(false);

    const later = new Date(Date.now() + (rotationSec + 60) * 1_000);
    const due = await verifyDeviceToken({
      presentedToken: issued.token,
      now: later,
      store: store(),
    });
    expect(due.outcome).toBe('valid');
    if (due.outcome !== 'valid') return;
    expect(due.rotationDue).toBe(true);
  });

  it('never writes the raw device token to the database', async () => {
    const issued = await issueDeviceToken({
      userId: new ObjectId(),
      orgId: new ObjectId(),
      employeeId: 'mia',
      store: store(),
    });

    const dump = JSON.stringify(
      await store().db.collection(COLLECTIONS.daemonTokens).find({}).toArray(),
    );
    expect(dump).not.toContain(issued.token);
  });
});

describe('access tokens', () => {
  const subject = {
    userId: new ObjectId(),
    orgId: new ObjectId(),
    role: 'admin' as const,
    sessionId: new ObjectId(),
    familyId: newFamilyId(),
    mfaVerified: true,
  };

  it('round-trips its claims', async () => {
    const issued = await issueAccessToken(subject);
    const verified = await verifyAccessToken(issued.token);

    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    expect(verified.claims.userId).toBe(subject.userId.toHexString());
    expect(verified.claims.orgId).toBe(subject.orgId.toHexString());
    expect(verified.claims.role).toBe('admin');
    expect(verified.claims.familyId).toBe(subject.familyId);
    expect(verified.claims.mfaVerified).toBe(true);
  });

  it('expires after accessTokenTtlSec', async () => {
    const ttl = getConfig().auth.accessTokenTtlSec;
    const issuedAt = new Date(Date.now() - (ttl + 600) * 1_000);

    const issued = await issueAccessToken(subject, issuedAt);
    const verified = await verifyAccessToken(issued.token);

    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.reason).toBe('expired');
  });

  it('rejects a tampered payload', async () => {
    const issued = await issueAccessToken(subject);
    const [header, payload, signature] = issued.token.split('.');
    expect(payload).toBeDefined();
    if (payload === undefined) return;

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    decoded['role'] = 'owner';
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

    const verified = await verifyAccessToken(`${header}.${forged}.${signature}`);
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.reason).toBe('invalid');
  });

  it('rejects a correctly-signed token issued for another stage', async () => {
    // Signed with the *same* key, so only the issuer claim differs. This is the
    // property that stops a token minted in dev from being replayed against prod
    // if key material were ever shared between them.
    const key = await accessTokenSigningKey();
    const foreign = await new SignJWT({
      org: subject.orgId.toHexString(),
      role: subject.role,
      sid: subject.sessionId.toHexString(),
      fam: subject.familyId,
      mfa: true,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(subject.userId.toHexString())
      .setIssuer('lily:prod')
      .setAudience('lily-api')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);

    const verified = await verifyAccessToken(foreign);
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.reason).toBe('invalid');
  });
});

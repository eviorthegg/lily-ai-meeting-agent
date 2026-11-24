import { describe, expect, it } from 'vitest';
import { hash as argon2Hash } from '@node-rs/argon2';
import { getConfig } from '@lily/shared';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  WeakPasswordError,
  assertPasswordPolicy,
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './passwords.js';

const GOOD_PASSWORD = 'thunder-marmalade-ledger-47';

describe('password policy', () => {
  it('accepts a long passphrase with no character-class gymnastics', () => {
    expect(checkPasswordPolicy(GOOD_PASSWORD)).toEqual({ ok: true });
    expect(checkPasswordPolicy('all lowercase words and spaces')).toEqual({ ok: true });
  });

  it('rejects anything under the minimum length', () => {
    const result = checkPasswordPolicy('a'.repeat(PASSWORD_MIN_LENGTH - 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_short');
  });

  it('accepts exactly the minimum length', () => {
    expect(checkPasswordPolicy('abcdefghijkl'.slice(0, PASSWORD_MIN_LENGTH)).ok).toBe(true);
  });

  it('caps length so a large body cannot be turned into CPU time', () => {
    const result = checkPasswordPolicy('x'.repeat(PASSWORD_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_long');
  });

  it('rejects common breached passwords that are long enough to pass the length check', () => {
    for (const breached of ['passwordpassword', 'qwertyuiopasdfgh', '1234567890123']) {
      const result = checkPasswordPolicy(breached);
      expect(result.ok, breached).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('commonly_breached');
    }
  });

  it('matches the breach list case-insensitively', () => {
    const result = checkPasswordPolicy('PasswordPassword');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('commonly_breached');
  });

  it('throws a typed error from assertPasswordPolicy', () => {
    expect(() => assertPasswordPolicy('short')).toThrow(WeakPasswordError);
    expect(() => assertPasswordPolicy(GOOD_PASSWORD)).not.toThrow();
  });
});

describe('hashing', () => {
  it('produces an argon2id hash using the configured parameters', async () => {
    const { memoryCostKib, timeCost, parallelism } = getConfig().auth.argon2;
    const stored = await hashPassword(GOOD_PASSWORD);

    expect(stored.startsWith('$argon2id$v=19$')).toBe(true);
    expect(stored).toContain(`m=${memoryCostKib},t=${timeCost},p=${parallelism}`);

    // The password must not be recoverable from, or visible in, what is stored.
    expect(stored).not.toContain(GOOD_PASSWORD);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword(GOOD_PASSWORD);
    const b = await hashPassword(GOOD_PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, GOOD_PASSWORD)).toBe(true);
    expect(await verifyPassword(b, GOOD_PASSWORD)).toBe(true);
  });

  it('refuses to hash a password the policy rejects', async () => {
    // Enforced in hashPassword itself, so no route can bypass it by forgetting
    // to call the checker first.
    await expect(hashPassword('short')).rejects.toThrow(WeakPasswordError);
    await expect(hashPassword('passwordpassword')).rejects.toThrow(WeakPasswordError);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const stored = await hashPassword(GOOD_PASSWORD);
    expect(await verifyPassword(stored, GOOD_PASSWORD)).toBe(true);
    expect(await verifyPassword(stored, `${GOOD_PASSWORD}x`)).toBe(false);
    expect(await verifyPassword(stored, '')).toBe(false);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A corrupt row must look like a failed login, not a 500.
    expect(await verifyPassword('', GOOD_PASSWORD)).toBe(false);
    expect(await verifyPassword('not-a-hash', GOOD_PASSWORD)).toBe(false);
    expect(await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$trunc', GOOD_PASSWORD)).toBe(false);
    expect(await verifyPassword('$2b$12$abcdefghijklmnopqrstuv', GOOD_PASSWORD)).toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a hash produced with the current configuration', async () => {
    expect(needsRehash(await hashPassword(GOOD_PASSWORD))).toBe(false);
  });

  it('is true when the configured parameters are higher than the stored ones', async () => {
    const { memoryCostKib, timeCost, parallelism } = getConfig().auth.argon2;

    // Each of these is a hash written under a weaker setting than config now
    // demands — exactly what an old row looks like after a cost increase.
    const weakerMemory = await argon2Hash(GOOD_PASSWORD, {
      memoryCost: Math.floor(memoryCostKib / 2),
      timeCost,
      parallelism,
    });
    const weakerTime = await argon2Hash(GOOD_PASSWORD, {
      memoryCost: memoryCostKib,
      timeCost: timeCost - 1,
      parallelism,
    });

    expect(needsRehash(weakerMemory)).toBe(true);
    expect(needsRehash(weakerTime)).toBe(true);

    // Still verifiable — the migration happens on the next successful login, so
    // the old hash has to keep working until then.
    expect(await verifyPassword(weakerMemory, GOOD_PASSWORD)).toBe(true);
  });

  it('does not walk an existing hash down when config is lowered', async () => {
    const { memoryCostKib, timeCost, parallelism } = getConfig().auth.argon2;

    const stronger = await argon2Hash(GOOD_PASSWORD, {
      memoryCost: memoryCostKib * 2,
      timeCost: timeCost + 1,
      parallelism,
    });

    expect(needsRehash(stronger)).toBe(false);
  });

  it('is true for a hash from another scheme or a corrupt row', () => {
    expect(needsRehash('$2b$12$KIXQ0V4kZ2Kf0zvJqkQ8Ae')).toBe(true);
    expect(needsRehash('not-a-hash-at-all')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });

  it('is true for a non-id argon2 variant', async () => {
    // argon2i is weaker against GPU cracking; an imported hash using it should
    // migrate to argon2id on next login.
    const argon2i = await argon2Hash(GOOD_PASSWORD, {
      memoryCost: getConfig().auth.argon2.memoryCostKib,
      timeCost: getConfig().auth.argon2.timeCost,
      parallelism: getConfig().auth.argon2.parallelism,
      algorithm: 1,
    });

    expect(argon2i.startsWith('$argon2i$')).toBe(true);
    expect(needsRehash(argon2i)).toBe(true);
  });

  it('is true for an older argon2 version', () => {
    expect(needsRehash('$argon2id$v=16$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
  });
});

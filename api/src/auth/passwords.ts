import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { getConfig } from '@lily/shared';

/**
 * Password hashing and policy.
 *
 * Argon2id via `@node-rs/argon2`, with parameters from `config.auth.argon2` so a
 * cost increase is a config change rather than a code change — and so
 * `needsRehash` has something to compare against.
 *
 * The variant and version are the library defaults (argon2id, v=19) rather than
 * an explicit `algorithm:`/`version:` option. `@node-rs/argon2` declares those as
 * ambient `const enum`s, which `isolatedModules` forbids importing; the defaults
 * are what we want anyway, and `needsRehash` re-checks the variant on every login
 * so a default that ever changed would migrate rather than go unnoticed.
 */

/**
 * Length is the only knob that reliably buys entropy, so it is the only hard
 * requirement here. No character-class rules and no expiry: both push users
 * toward predictable mutations of one weak password, which is how the entries in
 * COMMON_BREACHED_PASSWORDS below got there. (NIST SP 800-63B, §5.1.1.)
 *
 * These are module constants rather than config because `config.auth` has no
 * password-length knob and `packages/shared` is outside this change.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Upper bound so a multi-megabyte body cannot be turned into CPU time. Well above
 * any real passphrase, and above the 64 characters 800-63B asks be accepted.
 */
export const PASSWORD_MAX_LENGTH = 256;

/**
 * A deliberately small, embedded list of passwords that appear at the top of
 * public breach corpora. This is not a substitute for a full breached-credential
 * check — it is the cheap half of one, and it catches the case that matters most
 * in practice: a new account whose password is a name-brand guess.
 *
 * Entries are compared case-insensitively, so they are stored lowercase.
 */
const COMMON_BREACHED_PASSWORDS: ReadonlySet<string> = new Set([
  '123456',
  '123456789',
  '12345678',
  '1234567890',
  '12345678901',
  '123456789012',
  '1234567890123',
  '111111111111',
  '000000000000',
  'password',
  'password1',
  'password123',
  'password1234',
  'passw0rd123',
  'passwordpassword',
  'qwerty',
  'qwerty123456',
  'qwertyuiop',
  'qwertyuiop123',
  'qwertyuiopasd',
  'qwertyuiopasdfgh',
  'asdfghjkl123',
  '1q2w3e4r5t6y',
  '1qaz2wsx3edc',
  'zaq12wsxcde3',
  'iloveyou',
  'iloveyou1234',
  'letmein',
  'letmein123456',
  'welcome',
  'welcome123456',
  'welcometothejungle',
  'administrator',
  'administrator1',
  'admin123456',
  'abc123456789',
  'monkey123456',
  'football123456',
  'baseball123456',
  'dragon123456',
  'sunshine12345',
  'princess12345',
  'trustno1trustno1',
  'changeme12345',
  'secretpassword',
  'mypassword123',
  'thisismypassword',
  'correcthorsebatterystaple',
]);

export type PasswordRejection = 'too_short' | 'too_long' | 'commonly_breached';

export type PasswordPolicyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PasswordRejection; readonly message: string };

export class WeakPasswordError extends Error {
  readonly reason: PasswordRejection;

  constructor(reason: PasswordRejection, message: string) {
    super(message);
    this.name = 'WeakPasswordError';
    this.reason = reason;
  }
}

/**
 * Normalisation for the breach comparison only. The password is hashed exactly as
 * typed — trimming or case-folding the stored value would silently shrink the
 * keyspace.
 */
function normalizeForComparison(password: string): string {
  return password.trim().toLowerCase();
}

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      reason: 'too_short',
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    };
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      reason: 'too_long',
      message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    };
  }

  if (COMMON_BREACHED_PASSWORDS.has(normalizeForComparison(password))) {
    return {
      ok: false,
      reason: 'commonly_breached',
      message: 'This password appears in known breach data. Choose a different one.',
    };
  }

  return { ok: true };
}

export function assertPasswordPolicy(password: string): void {
  const result = checkPasswordPolicy(password);
  if (!result.ok) throw new WeakPasswordError(result.reason, result.message);
}

/**
 * The policy is enforced here, not only at the route, so there is no code path
 * that can persist a hash for a password the policy rejects.
 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);

  const { memoryCostKib, timeCost, parallelism } = getConfig().auth.argon2;

  return argon2Hash(password, {
    memoryCost: memoryCostKib,
    timeCost,
    parallelism,
  });
}

/**
 * Verify a password against a stored PHC hash.
 *
 * Returns false rather than throwing on a malformed or truncated hash: a login
 * route must not distinguish "no such user" from "corrupt row" to the caller, and
 * an exception carrying the attempted password is exactly the sort of thing that
 * ends up in an error tracker.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(storedHash, password);
  } catch {
    return false;
  }
}

const PHC_ARGON2 = /^\$argon2(?<variant>id|i|d)\$v=(?<version>\d+)\$m=(?<m>\d+),t=(?<t>\d+),p=(?<p>\d+)\$/;

const ARGON2_CURRENT_VERSION = 19;

/**
 * Whether a stored hash was produced with weaker parameters than the ones in
 * force now. Call it on a successful login — that is the only moment the plaintext
 * is available to re-hash with, so it is the only moment a cost increase can
 * actually be applied to an existing account.
 *
 * Note the one-way comparison: parameters below config are upgraded, parameters
 * above config are left alone. Lowering `config.auth.argon2` (to fit a smaller
 * Lambda, say) must not walk every existing hash *down* to the new cost.
 */
export function needsRehash(storedHash: string): boolean {
  const groups = PHC_ARGON2.exec(storedHash)?.groups;

  // Unparseable, or some other scheme entirely (an imported bcrypt hash, a
  // truncated row) — re-hash it into the current format on next login.
  if (groups === undefined) return true;

  const { variant, version, m, t, p } = groups;
  if (variant === undefined || version === undefined || m === undefined || t === undefined || p === undefined) {
    return true;
  }

  if (variant !== 'id') return true;
  if (Number(version) < ARGON2_CURRENT_VERSION) return true;

  const { memoryCostKib, timeCost, parallelism } = getConfig().auth.argon2;

  return Number(m) < memoryCostKib || Number(t) < timeCost || Number(p) < parallelism;
}

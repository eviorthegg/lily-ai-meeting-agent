import { getConfig } from '@lily/shared';

/**
 * Failed-attempt throttling with exponential backoff.
 *
 * The threat is credential stuffing against a known address, so the counter is
 * keyed on the identifier being attacked rather than on the caller's IP: an
 * attacker rotates addresses freely and a per-IP counter would only inconvenience
 * the one user behind a shared NAT. IP is folded in as a secondary key so that a
 * single hostile client cannot walk an entire user list unimpeded either.
 *
 * State is per-process and in memory. That is honest for a single local API and
 * for a small deployment; a horizontally scaled one would move this to the
 * database or to a shared cache, which is why the interface is a class with a
 * narrow surface rather than a module of free functions over a global map.
 *
 * Two properties matter more than the exact numbers:
 *
 *   - The delay grows geometrically, so ten attempts cost minutes rather than
 *     milliseconds while a user who mistypes once pays 500ms.
 *   - A success clears the counter, so a legitimate user is never punished for
 *     an attacker having hammered their address — the block is on *failures*,
 *     and proving you know the password ends it.
 */

export interface AttemptDecision {
  readonly allowed: boolean;
  /** Milliseconds until the next attempt is permitted. Zero when allowed. */
  readonly retryAfterMs: number;
  readonly attempts: number;
  /** Whether the client should be shown a challenge before trying again. */
  readonly captchaRequired: boolean;
}

interface Entry {
  attempts: number;
  blockedUntil: number;
  lastFailureAt: number;
}

const ALLOWED: AttemptDecision = {
  allowed: true,
  retryAfterMs: 0,
  attempts: 0,
  captchaRequired: false,
};

export class AttemptLimiter {
  readonly #entries = new Map<string, Entry>();

  /**
   * Entries are dropped once a full `maxDelayMs` has passed with no failure, so
   * the map cannot grow without bound from one-off typos, and yesterday's
   * mistake does not count toward today's backoff.
   */
  #prune(now: number): void {
    const ttl = getConfig().auth.lockout.maxDelayMs * 2;
    for (const [key, entry] of this.#entries) {
      if (now - entry.lastFailureAt > ttl) this.#entries.delete(key);
    }
  }

  /** Whether an attempt may proceed right now. Does not record anything. */
  check(key: string, now: Date = new Date()): AttemptDecision {
    const entry = this.#entries.get(key);
    if (entry === undefined) return ALLOWED;

    const { captchaAfterAttempts } = getConfig().auth.lockout;
    const remaining = entry.blockedUntil - now.getTime();

    if (remaining <= 0) {
      return {
        allowed: true,
        retryAfterMs: 0,
        attempts: entry.attempts,
        captchaRequired: entry.attempts >= captchaAfterAttempts,
      };
    }

    return {
      allowed: false,
      retryAfterMs: remaining,
      attempts: entry.attempts,
      captchaRequired: entry.attempts >= captchaAfterAttempts,
    };
  }

  /** Record a failure and return the penalty it earned. */
  fail(key: string, now: Date = new Date()): AttemptDecision {
    const stamp = now.getTime();
    this.#prune(stamp);

    const { baseDelayMs, maxDelayMs, maxFailedAttempts, captchaAfterAttempts } =
      getConfig().auth.lockout;

    const entry = this.#entries.get(key) ?? { attempts: 0, blockedUntil: 0, lastFailureAt: 0 };
    entry.attempts += 1;
    entry.lastFailureAt = stamp;

    // Geometric, capped. At the attempt ceiling the penalty is pinned at the
    // maximum rather than continuing to double into an effective permanent lock —
    // a lockout an attacker can trigger on someone else's account is a denial of
    // service dressed as a security control.
    const growth = Math.min(entry.attempts - 1, 30);
    const delay =
      entry.attempts >= maxFailedAttempts
        ? maxDelayMs
        : Math.min(baseDelayMs * 2 ** growth, maxDelayMs);

    entry.blockedUntil = stamp + delay;
    this.#entries.set(key, entry);

    return {
      allowed: false,
      retryAfterMs: delay,
      attempts: entry.attempts,
      captchaRequired: entry.attempts >= captchaAfterAttempts,
    };
  }

  /** Clear the counter. Called on a successful authentication. */
  succeed(key: string): void {
    this.#entries.delete(key);
  }

  /** Test seam. Never called by a handler. */
  reset(): void {
    this.#entries.clear();
  }
}

/** Password logins. */
export const loginLimiter = new AttemptLimiter();

/** Email verification and MFA code entry — same shape of guess, same defence. */
export const codeLimiter = new AttemptLimiter();

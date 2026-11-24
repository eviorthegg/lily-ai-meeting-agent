import { getConfig } from '@lily/shared';
import type { Role, UserDoc } from '../db/schema.js';

/**
 * Who must have MFA.
 *
 * The policy is `config.auth.mfa.mandatoryForRoles` and it is evaluated here,
 * server-side, against the role on the user's own database record. Note what is
 * absent: there is no parameter on any function in this file through which a
 * request body could supply a role, and no "skip" or "enforce" flag a caller
 * could pass. A client can influence this decision only by first changing its own
 * row in `users`, which is the thing MFA is protecting in the first place.
 */

/**
 * Every role the system defines — see `Role` in `../db/schema.ts`. Used to detect
 * a value that is outside the union at runtime, which the type alone cannot.
 */
const KNOWN_ROLES: readonly string[] = ['owner', 'admin', 'manager', 'employee'];

export function mfaRequiredFor(role: Role): boolean {
  // Fail closed. A role that has appeared from somewhere the type system did not
  // see — a stale document, a hand-edited row, a future role added without
  // revisiting this list — is treated as privileged rather than waved through.
  if (!KNOWN_ROLES.includes(role)) return true;

  return getConfig().auth.mfa.mandatoryForRoles.includes(role);
}

/** The part of a user this decision reads. Loaded from the database, never from a request. */
export type MfaSubject = Pick<UserDoc, 'role' | 'mfa'>;

export function mfaRequiredForUser(user: MfaSubject): boolean {
  return mfaRequiredFor(user.role);
}

export type MfaGateResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'enrollment_required' };

/**
 * Whether this user may proceed past the login boundary.
 *
 * A privileged user who has not enrolled is not offered a reduced experience —
 * they are stopped, and the only route forward is enrolment.
 */
export function mfaGate(user: MfaSubject): MfaGateResult {
  if (mfaRequiredForUser(user) && !user.mfa.enrolled) {
    return { allowed: false, reason: 'enrollment_required' };
  }
  return { allowed: true };
}

export class MfaEnrollmentRequiredError extends Error {
  constructor(role: Role) {
    super(`Role "${role}" cannot access the dashboard without MFA enrolment.`);
    this.name = 'MfaEnrollmentRequiredError';
  }
}

export function assertMfaEnrolled(user: MfaSubject): void {
  if (!mfaGate(user).allowed) throw new MfaEnrollmentRequiredError(user.role);
}

import { describe, expect, it } from 'vitest';
import { getConfig } from '@lily/shared';
import type { Role, UserMfa } from '../db/schema.js';
import {
  MfaEnrollmentRequiredError,
  assertMfaEnrolled,
  mfaGate,
  mfaRequiredFor,
  mfaRequiredForUser,
} from './mfa-policy.js';

function mfa(enrolled: boolean): UserMfa {
  return {
    enrolled,
    totpSecretEncrypted: null,
    backupCodeHashes: [],
    enrolledAt: enrolled ? new Date() : null,
    lastVerifiedAt: null,
  };
}

describe('mfaRequiredFor', () => {
  it('is mandatory for the privileged roles', () => {
    expect(mfaRequiredFor('owner')).toBe(true);
    expect(mfaRequiredFor('admin')).toBe(true);
    expect(mfaRequiredFor('manager')).toBe(true);
  });

  it('is not mandatory for employees', () => {
    expect(mfaRequiredFor('employee')).toBe(false);
  });

  it('tracks config rather than a hardcoded list', () => {
    const mandatory = getConfig().auth.mfa.mandatoryForRoles;
    for (const role of ['owner', 'admin', 'manager', 'employee'] as const) {
      expect(mfaRequiredFor(role)).toBe(mandatory.includes(role));
    }
  });

  it('fails closed for a role outside the known set', () => {
    // A stale document or a role added without revisiting this policy must be
    // treated as privileged, not waved through.
    expect(mfaRequiredFor('superuser' as Role)).toBe(true);
    expect(mfaRequiredFor('' as Role)).toBe(true);
  });
});

describe('mfaGate', () => {
  it('blocks a privileged user who has not enrolled', () => {
    for (const role of ['owner', 'admin', 'manager'] as const) {
      const result = mfaGate({ role, mfa: mfa(false) });
      expect(result.allowed, role).toBe(false);
      if (result.allowed) continue;
      expect(result.reason).toBe('enrollment_required');
    }
  });

  it('admits a privileged user who has enrolled', () => {
    expect(mfaGate({ role: 'owner', mfa: mfa(true) }).allowed).toBe(true);
  });

  it('admits an employee either way', () => {
    expect(mfaGate({ role: 'employee', mfa: mfa(false) }).allowed).toBe(true);
    expect(mfaGate({ role: 'employee', mfa: mfa(true) }).allowed).toBe(true);
  });

  it('reads the role from the user record only', () => {
    // The gate takes a UserDoc subset and nothing else: there is no argument
    // through which a request body could assert a role or ask to skip the check.
    const enrolledAdmin = { role: 'admin' as const, mfa: mfa(true) };
    const barefacedAdmin = { role: 'admin' as const, mfa: mfa(false) };

    expect(mfaRequiredForUser(enrolledAdmin)).toBe(true);
    expect(mfaGate(enrolledAdmin).allowed).toBe(true);
    expect(mfaGate(barefacedAdmin).allowed).toBe(false);
  });

  it('throws a typed error from assertMfaEnrolled', () => {
    expect(() => assertMfaEnrolled({ role: 'admin', mfa: mfa(false) })).toThrow(
      MfaEnrollmentRequiredError,
    );
    expect(() => assertMfaEnrolled({ role: 'employee', mfa: mfa(false) })).not.toThrow();
  });
});

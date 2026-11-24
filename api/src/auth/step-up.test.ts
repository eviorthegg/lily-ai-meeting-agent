import { describe, expect, it } from 'vitest';
import { getConfig } from '@lily/shared';
import {
  STEP_UP_ACTIONS,
  StepUpRequiredError,
  assertStepUp,
  requireStepUp,
  requiresStepUp,
  stepUpExpiresAt,
  type StepUpSession,
} from './step-up.js';

const GRACE_MS = getConfig().auth.mfa.stepUpGraceSec * 1_000;
const NOW = new Date('2026-07-25T12:00:00.000Z');

function verifiedMsAgo(ms: number): StepUpSession {
  return { mfaVerifiedAt: new Date(NOW.getTime() - ms) };
}

describe('step-up grace', () => {
  it('does not require step-up just inside the grace window', () => {
    expect(requireStepUp(verifiedMsAgo(GRACE_MS - 1), NOW)).toBe(false);
  });

  it('requires step-up exactly at the boundary', () => {
    // The grace is spent at `stepUpGraceSec`, not one millisecond after it.
    expect(requireStepUp(verifiedMsAgo(GRACE_MS), NOW)).toBe(true);
  });

  it('requires step-up just outside the grace window', () => {
    expect(requireStepUp(verifiedMsAgo(GRACE_MS + 1), NOW)).toBe(true);
  });

  it('does not require step-up for a verification that just happened', () => {
    expect(requireStepUp(verifiedMsAgo(0), NOW)).toBe(false);
  });

  it('requires step-up when MFA has never been verified on this session', () => {
    expect(requireStepUp({ mfaVerifiedAt: null }, NOW)).toBe(true);
  });

  it('requires step-up when the verification is dated in the future', () => {
    // A clock that moved backwards must not read as "very recently verified".
    expect(requireStepUp(verifiedMsAgo(-60_000), NOW)).toBe(true);
  });

  it('requires step-up on a revoked session regardless of recent verification', () => {
    expect(
      requireStepUp({ mfaVerifiedAt: new Date(NOW.getTime() - 1_000), revokedAt: NOW }, NOW),
    ).toBe(true);
  });

  it('requires step-up once the session has passed its absolute expiry', () => {
    expect(
      requireStepUp(
        {
          mfaVerifiedAt: new Date(NOW.getTime() - 1_000),
          revokedAt: null,
          absoluteExpiresAt: new Date(NOW.getTime() - 1),
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('reports when the grace lapses', () => {
    const session = verifiedMsAgo(0);
    expect(stepUpExpiresAt(session)?.getTime()).toBe(NOW.getTime() + GRACE_MS);
    expect(stepUpExpiresAt({ mfaVerifiedAt: null })).toBeNull();
  });
});

describe('step-up actions', () => {
  it('covers every action the brief names', () => {
    expect([...STEP_UP_ACTIONS]).toEqual([
      'employee.add',
      'employee.remove',
      'token.rotate',
      'policy.change',
      'billing.change',
      'audit.export',
      'install_token.issue',
    ]);
  });

  it('recognises only the listed actions', () => {
    expect(requiresStepUp('billing.change')).toBe(true);
    expect(requiresStepUp('meeting.start')).toBe(false);
    expect(requiresStepUp('')).toBe(false);
  });

  it('throws a typed error when the grace has lapsed', () => {
    expect(() => assertStepUp('audit.export', verifiedMsAgo(GRACE_MS), NOW)).toThrow(
      StepUpRequiredError,
    );
    expect(() => assertStepUp('audit.export', verifiedMsAgo(0), NOW)).not.toThrow();
  });
});

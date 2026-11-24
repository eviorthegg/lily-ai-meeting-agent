import { getConfig } from '@lily/shared';
import type { SessionDoc } from '../db/schema.js';

/**
 * Step-up re-authentication.
 *
 * Holding a valid session is enough to use the product. It is not enough to
 * change who can use it, what it is allowed to do, or who is paying — those need
 * a fresh MFA challenge, because the threat is a session that is genuine but
 * unattended or hijacked, and a long-lived session proves nothing about who is
 * currently at the keyboard.
 */

/**
 * The actions that require a fresh challenge.
 *
 * Each of these either grants someone access, removes a control, or exports the
 * record of what happened — the four things an attacker with a live session would
 * actually want.
 */
export const STEP_UP_ACTIONS = [
  'employee.add',
  'employee.remove',
  'token.rotate',
  'policy.change',
  'billing.change',
  'audit.export',
  'install_token.issue',
] as const;

export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export function requiresStepUp(action: string): action is StepUpAction {
  return (STEP_UP_ACTIONS as readonly string[]).includes(action);
}

/**
 * The part of a session this decision reads. A full `SessionDoc` satisfies it;
 * so does the subset a handler has already loaded.
 */
export type StepUpSession = Pick<SessionDoc, 'mfaVerifiedAt'> &
  Partial<Pick<SessionDoc, 'revokedAt' | 'absoluteExpiresAt'>>;

/** Whether a fresh MFA challenge is needed before the action may proceed. */
export function requireStepUp(session: StepUpSession, now: Date): boolean {
  const { revokedAt, absoluteExpiresAt, mfaVerifiedAt } = session;

  if (revokedAt !== null && revokedAt !== undefined) return true;
  if (absoluteExpiresAt !== undefined && absoluteExpiresAt.getTime() <= now.getTime()) return true;
  if (mfaVerifiedAt === null) return true;

  const graceMs = getConfig().auth.mfa.stepUpGraceSec * 1_000;
  const elapsed = now.getTime() - mfaVerifiedAt.getTime();

  // Negative elapsed means the verification is dated in the future — a clock that
  // moved backwards, or a value that was written by something other than this
  // code. Either way it must not be read as "very recently verified".
  //
  // The boundary is exclusive: at exactly `stepUpGraceSec` the grace is spent.
  return elapsed < 0 || elapsed >= graceMs;
}

/** When the current grace lapses, or null if there is nothing to lapse. */
export function stepUpExpiresAt(session: StepUpSession): Date | null {
  const { mfaVerifiedAt } = session;
  if (mfaVerifiedAt === null) return null;
  return new Date(mfaVerifiedAt.getTime() + getConfig().auth.mfa.stepUpGraceSec * 1_000);
}

export class StepUpRequiredError extends Error {
  readonly action: StepUpAction;

  constructor(action: StepUpAction) {
    super(`"${action}" requires a fresh MFA challenge.`);
    this.name = 'StepUpRequiredError';
    this.action = action;
  }
}

export function assertStepUp(action: StepUpAction, session: StepUpSession, now: Date): void {
  if (requireStepUp(session, now)) throw new StepUpRequiredError(action);
}

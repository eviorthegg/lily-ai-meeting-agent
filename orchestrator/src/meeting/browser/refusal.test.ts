/**
 * Reading the refusal off the page.
 *
 * The case that motivated this: a Zoom join on 2026-07-25 failed on the
 * `inCallMarker` selector, and the error said the selector table was almost
 * certainly out of date. It was not. The page said "Automated bots aren't
 * allowed to join this meeting", and the camera the failure was being blamed on
 * was present and working. These tests pin the distinctions that message got
 * wrong — including the one where the honest answer is "refused, reason not
 * stated".
 */

import { describe, expect, it } from 'vitest';

import { detectRefusal } from './refusal.js';

describe('a vendor that names automation is quoted, not paraphrased', () => {
  it('recognises the Zoom bot notice', () => {
    const refusal = detectRefusal(
      '<div>Enter Meeting Info</div><div>Automated bots aren\'t allowed to join this meeting.</div>',
    );

    expect(refusal?.kind).toBe('automation-refused');
    expect(refusal?.quote).toContain('automated bots');
  });

  it('tells the reader NOT to edit the selector table', () => {
    const refusal = detectRefusal("Automated bots aren't allowed to join this meeting.");
    // The whole point: the previous message sent people to fix working code.
    expect(refusal?.meaning).toMatch(/do not edit it/i);
  });

  it('records that a real camera did not change the outcome', () => {
    // Guards the conclusion itself. Someone re-reading this in six months
    // should not have to relaunch an EC2 host to rule the camera back out.
    const refusal = detectRefusal("Automated bots aren't allowed to join this meeting.");
    expect(refusal?.meaning).toMatch(/camera/i);
  });

  it('survives the typographic apostrophe some builds ship', () => {
    // U+2019 rather than ASCII. Matching only one silently disables the phrase,
    // which fails exactly like the bug this module exists to prevent.
    const refusal = detectRefusal('Automated bots aren’t allowed to join this meeting.');
    expect(refusal?.kind).toBe('automation-refused');
  });

  it('is case- and whitespace-insensitive', () => {
    const refusal = detectRefusal('AUTOMATED   BOTS\n  AREN\'T ALLOWED\tTO JOIN THIS MEETING');
    expect(refusal?.kind).toBe('automation-refused');
  });
});

describe('an unexplained refusal is not reported as bot detection', () => {
  it('classifies the Meet string as access-denied, not automation-refused', () => {
    // Meet shows this for an expired code, a meeting that has not started, and
    // a refused participant alike. Calling it bot detection would be the same
    // unverified-cause mistake in a new place.
    const refusal = detectRefusal("You can't join this video call");

    expect(refusal?.kind).toBe('access-denied');
    expect(refusal?.kind).not.toBe('automation-refused');
  });

  it('says out loud that it does not prove bot detection', () => {
    const refusal = detectRefusal("You can't join this video call");
    expect(refusal?.meaning).toMatch(/does not by itself prove/i);
  });
});

describe('null means "nothing recognised", never "not refused"', () => {
  it('returns null for an ordinary page', () => {
    expect(detectRefusal('<html><body><h1>Meeting</h1><button>Leave</button></body></html>')).toBe(
      null,
    );
  });

  it('does not fire on incidental words', () => {
    // A page that merely mentions bots or joining is not a refusal. A false
    // positive here would tell someone their selectors are fine when they are
    // not, which is the failure this module must not introduce.
    expect(detectRefusal('Our bots documentation explains how to join a meeting.')).toBe(null);
    expect(detectRefusal('Allowed participants can join this meeting at any time.')).toBe(null);
  });

  it('returns null on empty input rather than throwing', () => {
    expect(detectRefusal('')).toBe(null);
  });
});

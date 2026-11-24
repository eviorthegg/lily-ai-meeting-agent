/**
 * Reading the refusal the page already printed.
 *
 * ===========================================================================
 * WHY
 * ===========================================================================
 * When a selector does not match, `SelectorFailureError` used to say:
 *
 *     NOT FOUND — nothing in the DOM matched. This is almost certainly a
 *     vendor UI change. Update the "inCallMarker" entry ...
 *
 * On 2026-07-25 that message was emitted for a Zoom join where the page said,
 * in plain English, in the middle of the screen:
 *
 *     Automated bots aren't allowed to join this meeting.
 *
 * Nothing was wrong with the selectors. Someone acting on that message would
 * have gone and "fixed" a correct SELECTORS table. An error that names a cause
 * it has not checked is worse than one that admits it does not know, because it
 * sends the next person somewhere specific and wrong.
 *
 * So: before blaming the selector table, look at the page.
 *
 * ===========================================================================
 * WHY VERBATIM STRINGS AND NOTHING CLEVERER
 * ===========================================================================
 * Every phrase here is one that was OBSERVED, on a real join, on the date in
 * its comment. There is no scoring, no keyword soup, no "looks like a block
 * page" heuristic — the same reasoning that removed the fuzzy transcript
 * detector from the data-policy guard applies here.
 *
 * The asymmetry that makes this safe is the direction of the failure. This runs
 * only on a path that has ALREADY failed, and only to choose the wording of an
 * error. A miss costs nothing: the caller falls back to the old message. A
 * false positive would cost something real — it would tell someone their
 * selectors are fine when they are not — which is exactly why nothing is
 * guessed and every phrase is quoted from a page we actually saw.
 *
 * Adding one is fine. Add the exact text, and say where and when you saw it.
 * ===========================================================================
 */

/**
 * What the page refused, as far as the page itself said.
 *
 * `automation-refused` means the vendor named automation. `access-denied` means
 * the join was refused WITHOUT saying why — an expired link, a meeting that has
 * not started and a bot block can all land here, so it must not be reported as
 * bot detection.
 */
export type RefusalKind = 'automation-refused' | 'access-denied' | 'sign-in-required';

export interface Refusal {
  readonly kind: RefusalKind;
  /** The matched text, so the error can quote the page rather than paraphrase. */
  readonly quote: string;
  /** What this does and does not prove. Goes straight into the error message. */
  readonly meaning: string;
}

interface Phrase {
  readonly needle: string;
  readonly kind: RefusalKind;
  readonly meaning: string;
}

const PHRASES: readonly Phrase[] = [
  {
    // Zoom web client, us04web.zoom.us, observed 2026-07-25 on an EC2 host
    // where Chrome DID have a working camera ("Lily Camera", 640x360). The
    // refusal is therefore not about a missing camera.
    needle: "automated bots aren't allowed to join this meeting",
    kind: 'automation-refused',
    meaning:
      'Zoom identified the browser as automated and refused the join. This is not a selector ' +
      'problem and not a missing-camera problem — it was reproduced with a real camera device ' +
      'present. The SELECTORS table is fine; do not edit it. Joining Zoom this way needs a ' +
      'sanctioned path (Zoom Meeting SDK / an approved app), not a change here.',
  },
  {
    // Same page as above, alongside the bot notice: the primary button reads
    // "Sign in to join" rather than "Join".
    needle: 'sign in to join this meeting',
    kind: 'sign-in-required',
    meaning:
      'The vendor is demanding an authenticated account before it will admit this participant. ' +
      'Often shown together with a bot notice, so check for one above before concluding the ' +
      'meeting merely requires sign-in.',
  },
  {
    // Google Meet, observed 2026-07-25 (and earlier in the same investigation).
    // DELIBERATELY 'access-denied': Meet shows this same string for an expired
    // code, a meeting that has not started, and a refused participant. It does
    // NOT prove bot detection, and must never be reported as if it did.
    needle: "you can't join this video call",
    kind: 'access-denied',
    meaning:
      'Meet refused the join without giving a reason. This string is shown for an expired or ' +
      'mistyped code, a meeting that has not started, a call that requires an invite, AND for a ' +
      'refused participant — so it does not by itself prove bot detection. Confirm the link is ' +
      'live in a normal browser before drawing any conclusion.',
  },
];

/**
 * Normalise the punctuation vendors actually ship.
 *
 * Zoom's copy uses a typographic apostrophe (U+2019) in some builds and ASCII
 * in others, and matching the wrong one silently disables the phrase — a
 * failure that looks exactly like the bug this module exists to prevent.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ');
}

/**
 * The refusal a page is displaying, or `null`.
 *
 * `null` means "nothing recognised", never "not refused" — the caller must fall
 * back to its ordinary diagnosis rather than treating this as an all-clear.
 */
export function detectRefusal(pageText: string): Refusal | null {
  const haystack = normalise(pageText);
  for (const phrase of PHRASES) {
    if (haystack.includes(normalise(phrase.needle))) {
      return { kind: phrase.kind, quote: phrase.needle, meaning: phrase.meaning };
    }
  }
  return null;
}

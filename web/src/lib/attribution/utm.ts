/**
 * Campaign attribution.
 *
 * Shape matches `UtmAttribution` in api/src/db/schema.ts, with `capturedAt` as
 * an ISO string rather than a Date because it crosses JSON on the way to the
 * org record.
 *
 * First touch is written once and then never overwritten; last touch is
 * rewritten on every landing that carries campaign parameters. Both travel with
 * the visitor through email verification and org creation, which is the whole
 * point — a signup that completes three days after the ad click still attributes
 * to the ad.
 *
 * Consent note: this is first-party only. Nothing here is transmitted to a
 * third party, and it is read at exactly one moment — when the visitor creates
 * an org, to stamp their own record. A visitor who never signs up leaves
 * nothing behind but a localStorage key on their own machine.
 */

export interface Attribution {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  gclid: string | null;
  fbclid: string | null;
  referrer: string | null;
  landingPath: string | null;
  capturedAt: string;
}

export interface AttributionPair {
  firstTouch: Attribution | null;
  lastTouch: Attribution | null;
}

const FIRST_KEY = 'lily.attribution.first';
const LAST_KEY = 'lily.attribution.last';

/** Long enough for a considered B2B purchase; short enough to stay honest. */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Attribution is best-effort. It must never block a signup. */
  }
}

/** Guards against a hostile or oversized query string being stored verbatim. */
function clean(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().slice(0, 200);
  return trimmed === '' ? null : trimmed;
}

function referrerOrigin(): string | null {
  const raw = document.referrer;
  if (raw === '') return null;
  try {
    const url = new URL(raw);
    // Same-site navigation is not a referral. Only the origin is kept: the full
    // referring URL can contain someone else's query parameters.
    if (url.hostname === window.location.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function read(key: string): Attribution | null {
  const raw = safeRead(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Attribution;
    if (typeof candidate.capturedAt !== 'string') return null;
    if (Date.now() - new Date(candidate.capturedAt).getTime() > MAX_AGE_MS) return null;
    return candidate;
  } catch {
    return null;
  }
}

/** True when the landing carries anything worth recording as a new touch. */
function isMeaningful(a: Attribution): boolean {
  return (
    a.source !== null ||
    a.medium !== null ||
    a.campaign !== null ||
    a.term !== null ||
    a.content !== null ||
    a.gclid !== null ||
    a.fbclid !== null ||
    a.referrer !== null
  );
}

/**
 * Only the first call of a page session may seed an empty first touch.
 *
 * A client-side route change is not a landing. Without this, navigating to
 * /onboarding immediately after CreateOrg clears attribution would write a
 * fresh, meaningless first touch — landingPath "/onboarding", every campaign
 * field null — and the clear would silently undo itself.
 */
let landingRecorded = false;

/**
 * Reads the current URL and records a touch. Safe to call on every navigation:
 * a page view with no campaign parameters and no external referrer is ignored
 * rather than overwriting last touch with an empty record.
 */
export function captureAttribution(search: string = window.location.search): AttributionPair {
  const params = new URLSearchParams(search);

  const touch: Attribution = {
    source: clean(params.get('utm_source')),
    medium: clean(params.get('utm_medium')),
    campaign: clean(params.get('utm_campaign')),
    term: clean(params.get('utm_term')),
    content: clean(params.get('utm_content')),
    gclid: clean(params.get('gclid')),
    fbclid: clean(params.get('fbclid')),
    referrer: referrerOrigin(),
    landingPath: window.location.pathname,
    capturedAt: new Date().toISOString(),
  };

  const existingFirst = read(FIRST_KEY);
  const isLanding = !landingRecorded;
  landingRecorded = true;

  if (isMeaningful(touch)) {
    if (existingFirst === null) safeWrite(FIRST_KEY, JSON.stringify(touch));
    safeWrite(LAST_KEY, JSON.stringify(touch));
  } else if (existingFirst === null && isLanding) {
    // A direct visit is still a first touch — it just has no campaign on it.
    // Only on a genuine landing, never on an in-app navigation.
    safeWrite(FIRST_KEY, JSON.stringify(touch));
  }

  return getAttribution();
}

export function getAttribution(): AttributionPair {
  return { firstTouch: read(FIRST_KEY), lastTouch: read(LAST_KEY) };
}

/** Cleared after the org record has been stamped; there is no reason to keep it. */
export function clearAttribution(): void {
  try {
    window.localStorage.removeItem(FIRST_KEY);
    window.localStorage.removeItem(LAST_KEY);
  } catch {
    /* no-op */
  }
}

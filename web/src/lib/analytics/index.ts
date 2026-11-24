import { allows, subscribe } from './consent';
import { assertSafeProps, type EventName, type EventProps } from './events';
import { ga4Event, ga4PageView, loadGa4 } from './ga4';
import { capture, capturePageView, disablePosthog, enablePosthog, identify, resetIdentity } from './posthog';

/**
 * The single entry point every call site uses.
 *
 * Consent is enforced here rather than in each vendor module, so there is one
 * place to read to answer "can this fire yet". Vendors are *activated* by the
 * subscriber below — GA4's tag is not fetched, and PostHog will not transmit,
 * until the analytics category flips to true.
 */

let started = false;

function applyConsent(): void {
  if (allows('analytics')) {
    loadGa4(); // idempotent; this is the only call site
    enablePosthog();
  } else {
    disablePosthog();
    // GA4 cannot be un-injected once loaded. It is never injected without
    // consent in the first place, and a withdrawal is followed by a reload
    // (see CookieBanner) so the page returns to a state with no tag at all.
  }
}

/** Called once from main.tsx. Wires consent changes to vendor activation. */
export function startAnalytics(): void {
  if (started) return;
  started = true;
  applyConsent();
  subscribe(applyConsent);
}

export function track(event: EventName, props: EventProps = {}): void {
  if (!allows('analytics')) return;
  assertSafeProps(event, props);
  capture(event, props);
  ga4Event(event, props);
}

export function pageView(path: string): void {
  if (!allows('analytics')) return;
  capturePageView(path);
  ga4PageView(path);
}

export function identifyUser(userId: string): void {
  if (!allows('analytics')) return;
  identify(userId);
}

export function forgetUser(): void {
  resetIdentity();
}

export type { EventName, EventProps };

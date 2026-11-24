import { posthog as posthogEnv } from '@/config/env';
import { getAnonymousId } from './consent';
import type { EventName, EventProps } from './events';

/**
 * PostHog capture, hand-rolled against the public ingest endpoint.
 *
 * Deliberately not posthog-js. That library autocaptures clicks, inputs, page
 * views and — with session replay — DOM content, all of which are on by default
 * and have to be remembered off. For a product whose central promise is that
 * meeting content never leaves the machine, "we remembered to disable it" is
 * the wrong guarantee. This module can only send an event from the closed
 * `EventName` union with scalar properties, because there is no other code path.
 *
 * What is given up: feature flags, session replay, autocapture, surveys. None
 * of those are wanted here.
 */

const ENDPOINT_PATH = '/i/v0/e/';

let identifiedUserId: string | null = null;
let enabled = false;

/** Called by the consent subscriber once the analytics category is granted. */
export function enablePosthog(): void {
  enabled = true;
}

export function disablePosthog(): void {
  enabled = false;
  identifiedUserId = null;
}

/**
 * Associates subsequent events with the account. The id is the backend's user
 * id — never an email, which would put a personal identifier in a third-party
 * store for no analytical gain.
 */
export function identify(userId: string): void {
  identifiedUserId = userId;
}

export function resetIdentity(): void {
  identifiedUserId = null;
}

function distinctId(): string {
  return identifiedUserId ?? getAnonymousId();
}

function send(payload: Record<string, unknown>): void {
  if (!enabled || !posthogEnv.enabled || posthogEnv.key === null) return;

  const url = `${posthogEnv.host.replace(/\/$/, '')}${ENDPOINT_PATH}`;
  const body = JSON.stringify({ ...payload, api_key: posthogEnv.key });

  // sendBeacon survives the page unload that follows a CTA click; without it the
  // last event before a navigation is routinely lost.
  try {
    if (typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return;
    }
  } catch {
    /* fall through to fetch */
  }

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    mode: 'cors',
  }).catch(() => {
    // Analytics must never surface an error to a visitor or break a flow.
  });
}

export function capture(event: EventName, props: EventProps): void {
  send({
    event,
    distinct_id: distinctId(),
    properties: { ...props, $lib: 'lily-web' },
    timestamp: new Date().toISOString(),
  });
}

export function capturePageView(path: string): void {
  // $current_url is omitted on purpose: query strings on this site can carry an
  // invite token, and a token does not belong in an analytics vendor's store.
  send({
    event: '$pageview',
    distinct_id: distinctId(),
    properties: { $pathname: path, $lib: 'lily-web' },
    timestamp: new Date().toISOString(),
  });
}

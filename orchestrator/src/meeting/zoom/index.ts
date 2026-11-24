/**
 * Zoom.
 *
 * ===========================================================================
 * WHAT CHANGED, AND WHY
 * ===========================================================================
 * This used to be a stub in front of the **Zoom Meeting SDK for Linux** — a
 * native C++ distribution, not on npm, obtainable only after a Zoom
 * Marketplace app is approved by a human for raw data access. That route is
 * abandoned. The approval is manual, the SDK needs a Node binding built against
 * it, and none of it is reachable from a build pipeline.
 *
 * Lily now joins the **web client** (`/wc/join/`) in a real browser, as a
 * guest, with a name that says she is an AI. The machinery is entirely in
 * `../browser/` and everything below is a thin construction site: pick the Zoom
 * driver, hand it to `BrowserMeetingAdapter`.
 *
 * `buildZoomSdkSignature` is kept. It is a correct HS256 JWT over Zoom's
 * documented claim set and it is unit tested; anyone who does obtain Meeting
 * SDK approval will want it, and deleting working, tested code because the
 * current product does not call it is how a codebase loses the only piece
 * somebody later needs.
 *
 * ===========================================================================
 * THE RISK, STATED
 * ===========================================================================
 * Zoom's terms restrict automated access to the service. Driving the web client
 * is outside them. That has been weighed and accepted at the product level; see
 * `orchestrator/README.md`. It is not re-argued here, but it is also not
 * hidden — `ZoomDriver.termsRisk` carries it and the adapter logs it once at
 * construction.
 * ===========================================================================
 */

import { createHmac } from 'node:crypto';

import type { LilyConfig } from '@lily/shared/config';

import type { EmployeeProfile } from '../../types.js';
import type { AdapterPreflight } from '../adapter.js';
import type { BoardTaskRow } from '../local/page.js';
import { BrowserMeetingAdapter } from '../browser/adapter.js';
import { ZoomDriver, toWebClientUrl } from '../browser/drivers/zoom.js';
import { browserPreflight, systemProbe, type HostProbe } from '../browser/xvfb.js';
import { envValue } from '../requirements.js';

/**
 * Can this host join a Zoom meeting?
 *
 * The answer no longer involves Zoom at all — no key, no secret, no approval.
 * It is entirely about whether the machine has a browser, a display server and
 * a sound card, which is a question an operator can act on in one command.
 */
export function zoomPreflight(probe: HostProbe = systemProbe): AdapterPreflight {
  return browserPreflight('zoom', probe);
}

// ---------------------------------------------------------------------------
// Kept from the SDK route: the join signature
// ---------------------------------------------------------------------------

export interface ZoomSignatureInput {
  readonly sdkKey: string;
  readonly sdkSecret: string;
  readonly meetingNumber: string;
  /** 0 = attendee, 1 = host. A meeting bot joins as an attendee. */
  readonly role: 0 | 1;
  readonly issuedAt: Date;
  readonly expiresInSec: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Build the Meeting SDK join signature.
 *
 * A real HS256 JWT over Zoom's documented claim set — `appKey` and `sdkKey`
 * carry the same value, and `tokenExp` must be at least 30 minutes out or Zoom
 * rejects the join. Unused by the browser path; correct, tested, and here for
 * whoever does get SDK approval.
 */
export function buildZoomSdkSignature(input: ZoomSignatureInput): string {
  const iat = Math.floor(input.issuedAt.getTime() / 1000);
  const exp = iat + input.expiresInSec;

  if (input.expiresInSec < 1800) {
    throw new Error(
      'Zoom rejects a Meeting SDK signature whose tokenExp is under 30 minutes from iat.',
    );
  }

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      appKey: input.sdkKey,
      sdkKey: input.sdkKey,
      mn: input.meetingNumber,
      role: input.role,
      iat,
      exp,
      tokenExp: exp,
    }),
  );

  const signature = createHmac('sha256', input.sdkSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ZoomMeetingAdapterOptions {
  readonly meetingId: string;
  /** A join link, or a bare meeting number. Both are normalised to /wc/join/. */
  readonly meetingUrl: string;
  readonly config: LilyConfig;
  readonly directory: readonly EmployeeProfile[];
  readonly taskView?: () => readonly BoardTaskRow[];
  readonly probe?: HostProbe;
}

/** A bare meeting number is what a person reads out; accept it. */
export function zoomMeetingUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d{9,12}$/.test(trimmed)) {
    const host = envValue('LILY_ZOOM_HOST') ?? 'zoom.us';
    const passcode = envValue('LILY_ZOOM_PASSCODE');
    const query = passcode === null ? '' : `?pwd=${encodeURIComponent(passcode)}`;
    return `https://${host}/wc/join/${trimmed}${query}`;
  }
  return toWebClientUrl(trimmed);
}

/**
 * Zoom, through the browser.
 *
 * Construction fails when the *host* cannot run a browser meeting — no Chrome,
 * no Xvfb, no PulseAudio, or not Linux — with each missing item named. That is
 * the same contract the SDK stub had, for a different and far more fixable set
 * of reasons.
 */
export function createZoomMeetingAdapter(
  options: ZoomMeetingAdapterOptions,
): BrowserMeetingAdapter {
  return new BrowserMeetingAdapter({
    meetingId: options.meetingId,
    meetingUrl: zoomMeetingUrl(options.meetingUrl),
    driver: new ZoomDriver(),
    config: options.config,
    directory: options.directory,
    ...(options.taskView === undefined ? {} : { taskView: options.taskView }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
  });
}

/** Credentials, if they happen to be present. Only the SDK route needs them. */
export function zoomCredentials(): { sdkKey: string; sdkSecret: string } | null {
  const sdkKey = envValue('LILY_ZOOM_SDK_KEY');
  const sdkSecret = envValue('LILY_ZOOM_SDK_SECRET');
  if (sdkKey === null || sdkSecret === null) return null;
  return { sdkKey, sdkSecret };
}

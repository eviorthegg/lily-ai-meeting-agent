/**
 * Google Meet.
 *
 * ===========================================================================
 * WHAT CHANGED, AND WHY
 * ===========================================================================
 * This file used to throw unconditionally, on the reasoning that Google
 * publishes no bot-participant API and that browser automation was out. The
 * first half is still true — the Meet REST API manages spaces and post-call
 * artefacts, the Meet Media API is a gated preview for *receiving* media, and
 * the Add-ons SDK runs inside a human's browser session. None of them puts a
 * participant in a live call.
 *
 * The second half is a product decision and it has been made the other way.
 * Lily joins the web client as a guest, in a real browser, the way a person on
 * a borrowed laptop does.
 *
 * ===========================================================================
 * THE RISK, STATED
 * ===========================================================================
 * Google's Terms of Service restrict automated access outside their published
 * interfaces, and this is outside them. That risk has been weighed and accepted
 * at the product level; it is documented in `orchestrator/README.md` and
 * carried in `MeetDriver.termsRisk`, which the adapter logs once at
 * construction. It is not re-argued here and it is not hidden.
 *
 * Two of the three original objections were technical rather than legal, and
 * both are answered by how the adapter runs rather than by wishing them away:
 *
 *   - **Detection.** Headless is detected, so the adapter does not use it: real
 *     Google Chrome, headful, inside Xvfb. See `../browser/xvfb.ts`.
 *   - **Consent.** The gate rests on knowing which human spoke, so the adapter
 *     reads Meet's own active-speaker marking out of the DOM and resolves it
 *     against the roster — reporting `null` whenever the name is unknown or
 *     ambiguous, which denies. See `../browser/speaker.ts`.
 *
 * Guest joins land in "asking to be let in". That is surfaced as a `lobby`
 * state with its own timeout and its own message, not treated as a hang.
 * ===========================================================================
 */

import type { LilyConfig } from '@lily/shared/config';

import type { EmployeeProfile } from '../../types.js';
import type { AdapterPreflight } from '../adapter.js';
import type { BoardTaskRow } from '../local/page.js';
import { BrowserMeetingAdapter } from '../browser/adapter.js';
import { MeetDriver } from '../browser/drivers/meet.js';
import { browserPreflight, systemProbe, type HostProbe } from '../browser/xvfb.js';

export function meetPreflight(probe: HostProbe = systemProbe): AdapterPreflight {
  return browserPreflight('meet', probe);
}

export interface MeetMeetingAdapterOptions {
  readonly meetingId: string;
  /** `https://meet.google.com/abc-defg-hij`. */
  readonly meetingUrl: string;
  readonly config: LilyConfig;
  readonly directory: readonly EmployeeProfile[];
  readonly taskView?: () => readonly BoardTaskRow[];
  readonly probe?: HostProbe;
}

export function createMeetMeetingAdapter(
  options: MeetMeetingAdapterOptions,
): BrowserMeetingAdapter {
  if (options.meetingUrl.trim() === '') {
    throw new Error(
      'A Google Meet join URL is required (LILY_MEETING_URL), e.g. ' +
        'https://meet.google.com/abc-defg-hij. Meet takes no meeting number.',
    );
  }
  return new BrowserMeetingAdapter({
    meetingId: options.meetingId,
    meetingUrl: options.meetingUrl,
    driver: new MeetDriver(),
    config: options.config,
    directory: options.directory,
    ...(options.taskView === undefined ? {} : { taskView: options.taskView }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
  });
}

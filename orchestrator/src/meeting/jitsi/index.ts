/**
 * Jitsi Meet.
 *
 * The conflict-free platform, and therefore the one to develop and test
 * against. Jitsi is open source, guests are explicitly allowed, and joining
 * programmatically breaks nobody's terms — so there is no accepted risk hanging
 * over a test run and CI can point at a self-hosted instance without asking
 * anyone's permission.
 *
 * Everything the other three drivers do, this one does with the same shared
 * machinery. If a change works here and breaks there, the difference is a
 * selector table, which is exactly where it should be.
 */

import type { LilyConfig } from '@lily/shared/config';

import type { EmployeeProfile } from '../../types.js';
import type { AdapterPreflight } from '../adapter.js';
import type { BoardTaskRow } from '../local/page.js';
import { BrowserMeetingAdapter } from '../browser/adapter.js';
import { JitsiDriver } from '../browser/drivers/jitsi.js';
import { browserPreflight, systemProbe, type HostProbe } from '../browser/xvfb.js';

export function jitsiPreflight(probe: HostProbe = systemProbe): AdapterPreflight {
  return browserPreflight('jitsi', probe);
}

export interface JitsiMeetingAdapterOptions {
  readonly meetingId: string;
  /** A full room URL, or a bare room name to open on `LILY_JITSI_HOST`. */
  readonly meetingUrl: string;
  readonly config: LilyConfig;
  readonly directory: readonly EmployeeProfile[];
  readonly taskView?: () => readonly BoardTaskRow[];
  readonly probe?: HostProbe;
}

/**
 * A bare room name becomes a URL on the configured host.
 *
 * `LILY_JITSI_HOST` defaults to the public instance, which is right for a demo
 * and wrong for production: a self-hosted server is the recommended deployment
 * and is a one-variable change.
 */
export function jitsiRoomUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const host = process.env['LILY_JITSI_HOST'] ?? 'https://meet.jit.si';
  const base = host.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(trimmed)}`;
}

export function createJitsiMeetingAdapter(
  options: JitsiMeetingAdapterOptions,
): BrowserMeetingAdapter {
  if (options.meetingUrl.trim() === '') {
    throw new Error(
      'A Jitsi room is required (LILY_MEETING_URL). Either a full URL such as ' +
        'https://meet.jit.si/LilyStandup, or a bare room name to open on LILY_JITSI_HOST.',
    );
  }
  return new BrowserMeetingAdapter({
    meetingId: options.meetingId,
    meetingUrl: jitsiRoomUrl(options.meetingUrl),
    driver: new JitsiDriver(),
    config: options.config,
    directory: options.directory,
    ...(options.taskView === undefined ? {} : { taskView: options.taskView }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
  });
}

/**
 * The platform entry points, after the move to the browser.
 *
 * What these assert is the property that survived the rewrite: an adapter that
 * cannot work fails at **construction**, with the specific missing items named.
 * What changed is *why* it fails. It used to be vendor approvals nobody could
 * grant; now it is packages an operator can install in one command, which is a
 * far better failure to have.
 *
 * They also pin the things that must not quietly regress: the URL rewrites,
 * that Jitsi is the only driver with nothing to disclose, and that the Zoom
 * signature — kept from the abandoned SDK route — is still a valid JWT.
 */

import { describe, expect, it } from 'vitest';

import { buildConfig } from '@lily/shared/config';

import { MeetingAdapterUnavailableError } from './adapter.js';
import { allDrivers, driverForUrl } from './browser/drivers/index.js';
import { toWebClientUrl } from './browser/drivers/zoom.js';
import { toAnonymousJoinUrl } from './browser/drivers/teams.js';
import { bareLinuxProbe, readyLinuxProbe } from './browser/testing.js';
import { createJitsiMeetingAdapter, jitsiPreflight, jitsiRoomUrl } from './jitsi/index.js';
import { createMeetMeetingAdapter, meetPreflight } from './meet/index.js';
import { createTeamsMeetingAdapter, teamsPreflight } from './teams/index.js';
import {
  buildZoomSdkSignature,
  createZoomMeetingAdapter,
  zoomMeetingUrl,
  zoomPreflight,
} from './zoom/index.js';

const CONFIG = buildConfig('local');
const DIRECTORY = [
  {
    employeeId: 'emp_1',
    name: 'Sarah Chen',
    aliases: [],
    jobDescription: 'auth',
    agentKind: null,
    capabilities: [],
    daemonEnrolled: false,
  },
];

describe('every platform fails at construction on a host that cannot run a browser', () => {
  const cases = [
    {
      name: 'jitsi',
      build: () =>
        createJitsiMeetingAdapter({
          meetingId: 'mtg_1',
          meetingUrl: 'https://meet.jit.si/LilyStandup',
          config: CONFIG,
          directory: DIRECTORY,
          probe: bareLinuxProbe(),
        }),
    },
    {
      name: 'meet',
      build: () =>
        createMeetMeetingAdapter({
          meetingId: 'mtg_1',
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
          config: CONFIG,
          directory: DIRECTORY,
          probe: bareLinuxProbe(),
        }),
    },
    {
      name: 'zoom',
      build: () =>
        createZoomMeetingAdapter({
          meetingId: 'mtg_1',
          meetingUrl: 'https://acme.zoom.us/j/86123456789?pwd=secret',
          config: CONFIG,
          directory: DIRECTORY,
          probe: bareLinuxProbe(),
        }),
    },
    {
      name: 'teams',
      build: () =>
        createTeamsMeetingAdapter({
          meetingId: 'mtg_1',
          joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x',
          config: CONFIG,
          directory: DIRECTORY,
          probe: bareLinuxProbe(),
        }),
    },
  ] as const;

  for (const platform of cases) {
    it(`${platform.name} names what is missing rather than failing mid-join`, () => {
      let thrown: unknown;
      try {
        platform.build();
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBeInstanceOf(MeetingAdapterUnavailableError);
      const message = (thrown as Error).message;
      expect(message).toContain('Google Chrome');
      expect(message).toContain('Xvfb');
      expect(message).toContain('provision-browser-host.sh');
    });
  }

  it('a missing meeting URL is caught before the host is even checked', () => {
    // "You did not tell me which meeting" is not a provisioning problem and
    // should not be reported as one.
    expect(() =>
      createMeetMeetingAdapter({
        meetingId: 'mtg_1',
        meetingUrl: '   ',
        config: CONFIG,
        directory: DIRECTORY,
        probe: readyLinuxProbe(),
      }),
    ).toThrow(/join URL is required/);
  });
});

describe('preflight is now about the machine, not about vendor approvals', () => {
  it('reports a provisioned Linux host as ready', () => {
    const probe = readyLinuxProbe();
    for (const check of [
      jitsiPreflight(probe),
      meetPreflight(probe),
      zoomPreflight(probe),
      teamsPreflight(probe),
    ]) {
      expect(check.ready).toBe(true);
      expect(check.missing).toHaveLength(0);
      expect(check.blockers).toHaveLength(0);
    }
  });

  it('reports the operating system as a blocker, and packages as missing', () => {
    const windows = { ...bareLinuxProbe(), platform: 'win32' as const };
    const check = jitsiPreflight(windows);

    expect(check.ready).toBe(false);
    // A blocker is something no environment variable fixes. On Windows that is
    // the OS itself; the packages are merely absent.
    expect(check.blockers.join(' ')).toContain('Linux only');
    expect(check.missing.join(' ')).toContain('Xvfb');
  });

  it('carries the platform through, so a caller can report which one it asked about', () => {
    expect(zoomPreflight(readyLinuxProbe()).platform).toBe('zoom');
    expect(jitsiPreflight(readyLinuxProbe()).platform).toBe('jitsi');
  });
});

describe('the terms position is in the code, not only in the README', () => {
  it('marks Jitsi as the one platform with nothing to disclose', () => {
    const jitsi = allDrivers().find((driver) => driver.id === 'jitsi');
    expect(jitsi?.termsRisk).toBeNull();
  });

  it('makes every other driver carry its accepted risk', () => {
    for (const driver of allDrivers()) {
      if (driver.id === 'jitsi') continue;
      expect(driver.termsRisk).toBeTruthy();
      expect(driver.termsRisk).toMatch(/terms/i);
      // And it says the decision was made, not that it is pending.
      expect(driver.termsRisk).toMatch(/Accepted at the product level/);
    }
  });
});

describe('picking a driver from a link', () => {
  it('recognises each platform by its host', () => {
    expect(driverForUrl('https://meet.google.com/abc-defg-hij')?.id).toBe('meet');
    expect(driverForUrl('https://acme.zoom.us/j/86123456789')?.id).toBe('zoom');
    expect(driverForUrl('https://teams.microsoft.com/l/meetup-join/x')?.id).toBe('teams');
    expect(driverForUrl('https://meet.jit.si/LilyStandup')?.id).toBe('jitsi');
  });

  it('returns null for a platform nobody wrote a driver for', () => {
    // Guessing would point a Jitsi driver at Webex and produce a selector
    // failure instead of "I do not support this".
    expect(driverForUrl('https://acme.webex.com/meet/x')).toBeNull();
  });
});

describe('URL normalisation', () => {
  it('rewrites a Zoom link to the web client, keeping the tenant subdomain', () => {
    expect(toWebClientUrl('https://acme.zoom.us/j/86123456789?pwd=abc')).toBe(
      'https://acme.zoom.us/wc/join/86123456789?pwd=abc',
    );
  });

  it('leaves an already-web-client Zoom link alone in substance', () => {
    expect(toWebClientUrl('https://zoom.us/wc/join/86123456789')).toBe(
      'https://zoom.us/wc/join/86123456789',
    );
  });

  it('turns a spoken Zoom meeting number into a web client URL', () => {
    expect(zoomMeetingUrl('86123456789')).toBe('https://zoom.us/wc/join/86123456789');
  });

  it('asks Teams for the anonymous path explicitly', () => {
    expect(toAnonymousJoinUrl('https://teams.microsoft.com/l/meetup-join/x')).toContain('anon=true');
  });

  it('tells Teams not to hand off to the desktop app', () => {
    // A meetup-join link is an app LAUNCHER link. Without these the browser
    // shows an "Open Microsoft Teams?" interstitial with the join UI behind it,
    // and on some builds that prompt is a native dialog — not in the DOM, so
    // not clickable by the driver at all. These keep the flow in the browser.
    const url = toAnonymousJoinUrl('https://teams.microsoft.com/l/meetup-join/x');

    expect(url).toContain('launchAgent=join_only');
    expect(url).toContain('type=meetup-join');
    expect(url).toContain('suppressPrompt=true');
    expect(url).toContain('msLaunch=false');
    expect(url).toContain('directDl=false');
  });

  it('preserves the parameters the organiser sent', () => {
    // meetup-join links carry required context — the thread id, the tenant,
    // the organiser oid. Dropping any of them makes the link unjoinable, so
    // the rewrite must only ever ADD.
    const url = toAnonymousJoinUrl(
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0' +
        '?context=%7b%22Tid%22%3a%22t-1%22%2c%22Oid%22%3a%22o-1%22%7d',
    );

    expect(url).toContain('context=');
    expect(url).toContain('Tid');
    expect(url).toContain('meeting_abc');
  });

  it('returns a malformed URL untouched rather than throwing', () => {
    // The join URL comes from a user. A bad one should fail later with a
    // navigation error naming the URL, not here with a URL parse error.
    expect(toAnonymousJoinUrl('not a url')).toBe('not a url');
  });

  it('turns a bare Jitsi room name into a URL on the configured host', () => {
    expect(jitsiRoomUrl('LilyStandup')).toBe('https://meet.jit.si/LilyStandup');
    expect(jitsiRoomUrl('https://jitsi.acme.internal/LilyStandup')).toBe(
      'https://jitsi.acme.internal/LilyStandup',
    );
  });
});

describe('every driver keeps its selectors in one table', () => {
  it('declares what each selector is for, so a failure message can say it', () => {
    for (const driver of allDrivers()) {
      const entries = Object.entries(driver.selectors);
      expect(entries.length).toBeGreaterThan(8);
      for (const [name, entry] of entries) {
        expect(entry.selector, `${driver.id}.${name} has no selector`).not.toBe('');
        expect(entry.what, `${driver.id}.${name} has no explanation`).not.toBe('');
      }
    }
  });

  it('declares the four selectors the shared join sequence depends on', () => {
    for (const driver of allDrivers()) {
      for (const required of ['nameInput', 'joinButton', 'inCallMarker', 'leaveButton']) {
        expect(driver.selectors[required], `${driver.id} is missing ${required}`).toBeDefined();
      }
    }
  });
});

describe('the part of the Zoom SDK route worth keeping', () => {
  it('builds a Meeting SDK signature that is a real HS256 JWT', () => {
    const jwt = buildZoomSdkSignature({
      sdkKey: 'sdk_key_value',
      sdkSecret: 'sdk_secret_value',
      meetingNumber: '1234567890',
      role: 0,
      issuedAt: new Date('2026-07-25T10:00:00.000Z'),
      expiresInSec: 7200,
    });

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));

    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(payload.mn).toBe('1234567890');
    expect(payload.role).toBe(0);
    expect(payload.appKey).toBe(payload.sdkKey);
    expect(payload.tokenExp).toBe(payload.exp);
    expect(payload.exp - payload.iat).toBe(7200);
  });

  it('refuses a token lifetime Zoom would reject', () => {
    expect(() =>
      buildZoomSdkSignature({
        sdkKey: 'k',
        sdkSecret: 's',
        meetingNumber: '1',
        role: 0,
        issuedAt: new Date(),
        expiresInSec: 60,
      }),
    ).toThrow(/30 minutes/);
  });
});

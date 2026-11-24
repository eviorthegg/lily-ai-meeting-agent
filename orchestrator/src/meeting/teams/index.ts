/**
 * Microsoft Teams.
 *
 * ===========================================================================
 * WHAT CHANGED, AND WHY
 * ===========================================================================
 * This used to be a stub in front of Graph calling, and the blocker that made
 * it a stub has not gone away: `Microsoft.Skype.Bots.Media` is Windows-only
 * .NET with no Node binding, so even with tenant admin consent for
 * `Calls.JoinGroupCall.All` and `Calls.AccessMedia.All` and Microsoft's media
 * bot review passed, this Linux Node process could not terminate Teams media.
 * That was an architecture port, not a missing key, and it is why the SDK route
 * is abandoned rather than deferred.
 *
 * Lily now joins the **web client's anonymous guest path** — the same one a
 * person without the desktop app takes. No app registration, no admin consent,
 * no review.
 *
 * `acquireGraphToken` is kept: it is real, standard OAuth2, correct and
 * independent of any of this. Anyone building the Graph route later will want
 * it, and it costs nothing to keep.
 *
 * ===========================================================================
 * THE ONE THING A CUSTOMER CONTROLS
 * ===========================================================================
 * Tenant policy can forbid anonymous join outright ("Anonymous users can join a
 * meeting" in the Teams meeting policy). When it does, the driver detects the
 * refusal explicitly and says so, rather than reporting a missing name field —
 * because "your admin has switched this off" and "Microsoft renamed a selector"
 * go to different people.
 *
 * ===========================================================================
 * THE RISK, STATED
 * ===========================================================================
 * Microsoft's terms restrict automated access to the service. Accepted at the
 * product level; see `orchestrator/README.md` and `TeamsDriver.termsRisk`.
 * ===========================================================================
 */

import type { LilyConfig } from '@lily/shared/config';

import type { EmployeeProfile } from '../../types.js';
import type { AdapterPreflight } from '../adapter.js';
import type { BoardTaskRow } from '../local/page.js';
import { BrowserMeetingAdapter } from '../browser/adapter.js';
import { TeamsDriver } from '../browser/drivers/teams.js';
import { browserPreflight, systemProbe, type HostProbe } from '../browser/xvfb.js';
import { envValue } from '../requirements.js';

export function teamsPreflight(probe: HostProbe = systemProbe): AdapterPreflight {
  return browserPreflight('teams', probe);
}

// ---------------------------------------------------------------------------
// Kept from the Graph route
// ---------------------------------------------------------------------------

export interface GraphToken {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

/**
 * OAuth2 client-credentials against Entra ID.
 *
 * Real and complete. Unused by the browser path — the anonymous join needs no
 * token at all — and kept because it is correct and someone will want it.
 */
export async function acquireGraphToken(options: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<GraphToken> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(
    `https://login.microsoftonline.com/${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  );

  if (!response.ok) {
    // Deliberately not echoing the body: an Entra error response can contain
    // the client id and correlation identifiers.
    throw new Error(`Entra ID token request failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('Entra ID token response did not contain an access_token.');
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
  return { accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface TeamsMeetingAdapterOptions {
  readonly meetingId: string;
  /** A `https://teams.microsoft.com/l/meetup-join/...` link. */
  readonly joinUrl: string;
  readonly config: LilyConfig;
  readonly directory: readonly EmployeeProfile[];
  readonly taskView?: () => readonly BoardTaskRow[];
  readonly probe?: HostProbe;
}

export function createTeamsMeetingAdapter(
  options: TeamsMeetingAdapterOptions,
): BrowserMeetingAdapter {
  if (options.joinUrl.trim() === '') {
    throw new Error(
      'A Teams meetup-join URL is required (LILY_MEETING_URL), e.g. ' +
        'https://teams.microsoft.com/l/meetup-join/19%3ameeting_...',
    );
  }
  return new BrowserMeetingAdapter({
    meetingId: options.meetingId,
    meetingUrl: options.joinUrl,
    driver: new TeamsDriver(),
    config: options.config,
    directory: options.directory,
    ...(options.taskView === undefined ? {} : { taskView: options.taskView }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
  });
}

export function teamsCredentials(): {
  tenantId: string;
  clientId: string;
  clientSecret: string;
} | null {
  const tenantId = envValue('LILY_TEAMS_TENANT_ID');
  const clientId = envValue('LILY_TEAMS_CLIENT_ID');
  const clientSecret = envValue('LILY_TEAMS_CLIENT_SECRET');
  if (tenantId === null || clientId === null || clientSecret === null) return null;
  return { tenantId, clientId, clientSecret };
}

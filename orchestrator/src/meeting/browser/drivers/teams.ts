/**
 * Microsoft Teams, joined anonymously through the web client.
 *
 * ===========================================================================
 * WHY THE WEB CLIENT
 * ===========================================================================
 * The Graph calling route needs tenant admin consent for
 * `Calls.JoinGroupCall.All` and `Calls.AccessMedia.All`, Microsoft's review to
 * publish a media bot, and — the one that ends it — `Microsoft.Skype.Bots.Media`,
 * a Windows-only .NET component with no Node binding. Even with every consent
 * granted, this Linux Node process cannot terminate Teams media. That is a
 * platform port, not a missing key.
 *
 * The anonymous web join needs none of it. A meetup-join link opens in a
 * browser, offers "Continue on this browser", asks for a name, and puts the
 * guest in the lobby. That is the same path a person on a phone without the app
 * takes.
 *
 * ===========================================================================
 * TEAMS-SPECIFIC AWKWARDNESS
 * ===========================================================================
 *   - **The app-vs-browser interstitial.** The link's default is to launch the
 *     desktop app. `Continue on this browser` is in `dismiss` and is the first
 *     thing clicked.
 *   - **Tenant policy can forbid anonymous join entirely.** When it does, the
 *     page says so rather than showing a name field, and the failure is a
 *     missing `nameInput` — which is exactly the message the selector reporting
 *     produces. That is a customer configuration answer, not a code fix, and
 *     `anonymousBlocked` is checked first so the message says which.
 *   - Teams renames `data-tid` values less often than Meet renames classes, so
 *     they are preferred throughout.
 * ===========================================================================
 */

import type { MeetingAdapterCapabilities } from '../../adapter.js';
import { JoinStalledError } from '../driver.js';
import type { JoinContext, PageContext, PlatformDriver, SelectorTable } from '../driver.js';
import { firstMeaningful, revealToolbar, runStandardJoin } from './common.js';

const SELECTORS: SelectorTable = {
  continueInBrowser: {
    selector:
      '[data-tid="joinOnWeb"], button:has-text("Continue on this browser"), a:has-text("Continue on this browser")',
    what: 'the "use the web app instead of the desktop app" choice',
    required: false,
  },
  cookieAccept: {
    selector: 'button:has-text("Accept"), #onetrust-accept-btn-handler',
    what: 'the cookie wall Microsoft shows in some regions',
    required: false,
  },
  anonymousBlocked: {
    selector:
      'text=/anonymous users are not allowed|not allowed to join|Your organization.s policy/i',
    what: 'the message shown when tenant policy forbids anonymous join — a customer setting, not a bug here',
    required: false,
  },
  nameInput: {
    selector:
      '[data-tid="prejoin-display-name-input"], input#displayName, input[placeholder*="name" i]',
    what: 'the guest name field on the pre-join screen',
    required: true,
  },
  joinButton: {
    selector: '[data-tid="prejoin-join-button"], button:has-text("Join now")',
    what: 'the button that enters the meeting',
    required: true,
  },
  lobbyIndicator: {
    selector:
      '[data-tid="lobby-screen"], text=/Someone in the meeting should let you in soon|When the meeting starts/i',
    what: 'the Teams lobby — someone in the meeting has to admit the guest',
    required: false,
  },
  deniedIndicator: {
    selector: 'text=/Sorry, but you were denied access|didn.t let you in/i',
    what: 'the message shown when the request is refused',
    required: false,
  },
  inCallMarker: {
    selector: '[data-tid="call-controls"], #call-controls, [data-tid="hangup-button"]',
    what: 'the in-call control bar; its presence is the definition of "joined"',
    required: true,
  },
  speakingIndicator: {
    selector:
      '[data-tid="participant-speaking"] [data-tid="roster-participant-name"], ' +
      '[data-tid="voice-level-stream-outline"] ~ * [data-tid="displayName"], ' +
      '[aria-label*="is speaking" i]',
    what: 'the name attached to whichever tile Teams is outlining as the speaker. The fragile selector in this driver',
    required: false,
  },
  participantNames: {
    selector: '[data-tid="roster-participant-name"], [data-tid="displayName"]',
    what: 'display names in the roster',
    required: false,
  },
  chatToggle: {
    selector: '[data-tid="chat-button"], [aria-label*="chat" i]',
    what: 'opens the meeting chat',
    required: true,
  },
  chatInput: {
    selector:
      '[data-tid="ckeditor"], div[contenteditable="true"][role="textbox"], [data-tid="newMessageBody"]',
    what: 'the chat message box',
    required: true,
  },
  leaveButton: {
    selector: '[data-tid="hangup-button"], #hangup-button, [aria-label*="Leave" i]',
    what: 'hang up',
    required: true,
  },
  muteButton: {
    selector: '[data-tid="toggle-mute"][aria-label*="Mute" i], [aria-label="Mute microphone"]',
    what: 'mute the microphone',
    required: false,
  },
  unmuteButton: {
    selector: '[data-tid="toggle-mute"][aria-label*="Unmute" i], [aria-label="Unmute microphone"]',
    what: 'unmute the microphone',
    required: false,
  },
  raiseHandButton: {
    selector: '[data-tid="raisehands-button"], [aria-label*="Raise" i]',
    what: 'raise hand',
    required: false,
  },
  lowerHandButton: {
    selector: '[data-tid="raisehands-button"][aria-pressed="true"], [aria-label*="Lower" i]',
    what: 'lower hand',
    required: false,
  },
  startShareButton: {
    selector: '[data-tid="share-button"], [aria-label*="Share content" i]',
    what: 'start sharing content',
    required: false,
  },
  stopShareButton: {
    selector: '[data-tid="stop-sharing-button"], [aria-label*="Stop sharing" i]',
    what: 'stop sharing content',
    required: false,
  },
  removedDialog: {
    selector: 'text=/You.ve been removed from the meeting|removed you from the meeting/i',
    what: 'the screen shown after a host removes this participant',
    required: false,
  },
  endedDialog: {
    selector: 'text=/The meeting has ended|Call ended|You left the meeting/i',
    what: 'the screen shown when the meeting is over',
    required: false,
  },
};

const CAPABILITIES: MeetingAdapterCapabilities = {
  audio: true,
  chat: true,
  screenshare: true,
  raiseHand: true,
  mute: true,
  roster: true,
};

/**
 * Turn a `meetup-join` link into one that stays in the browser.
 *
 * ===========================================================================
 * WHY FOUR PARAMETERS AND NOT JUST `anon`
 * ===========================================================================
 * A Teams meeting link is an **app-launcher link**, not a join link. Opened
 * plainly it tries to hand off to the desktop client, and what the browser is
 * left showing is an interstitial — "Open Microsoft Teams?" — with the actual
 * join UI behind it. `continueInBrowser` in the selector table exists to click
 * through that, which works but is a race: the interstitial is a native browser
 * dialog on some builds, and a native dialog is not in the DOM for Playwright
 * to click.
 *
 * Asking Teams not to attempt the handoff at all removes the race instead of
 * competing with it:
 *
 *   anon=true          Stop offering sign-in; take the guest path.
 *   type=meetup-join   Say which kind of link this is, so the web client routes
 *                      straight to the pre-join screen.
 *   launchAgent=join_only
 *                      Do not try to launch the desktop app.
 *   directDl=false     Do not offer the "download Teams" detour.
 *   msLaunch=false     Belt and braces with launchAgent on older builds.
 *   suppressPrompt=true
 *                      Skip the "Open Microsoft Teams?" prompt entirely.
 *
 * These are Microsoft's own documented launcher parameters, not a trick — the
 * same ones Teams itself puts on links when it wants the web experience.
 * `continueInBrowser` stays in `dismiss` regardless: it is `required: false`,
 * it costs a 2s probe, and it is the fallback for any build that ignores these.
 *
 * NOTE: untested against a live Teams meeting at the time of writing — no
 * tenant to test against. The URL shape is asserted in tests; the join is not.
 * ===========================================================================
 */
export function toAnonymousJoinUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.set('anon', 'true');
    parsed.searchParams.set('type', 'meetup-join');
    parsed.searchParams.set('launchAgent', 'join_only');
    parsed.searchParams.set('directDl', 'false');
    parsed.searchParams.set('msLaunch', 'false');
    parsed.searchParams.set('suppressPrompt', 'true');
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export class TeamsDriver implements PlatformDriver {
  readonly id = 'teams' as const;
  readonly platform = 'teams' as const;
  readonly label = 'Microsoft Teams (web client, anonymous join)';
  readonly capabilities = CAPABILITIES;
  readonly selectors = SELECTORS;
  readonly termsRisk =
    "Microsoft's terms restrict automated access to the service, and tenant policy may forbid " +
    'anonymous join outright. Accepted at the product level; see orchestrator/README.md.';

  matches(url: string): boolean {
    return /(^|\.)teams\.microsoft\.com$|(^|\.)teams\.live\.com$/i.test(safeHost(url));
  }

  joinUrl(rawUrl: string, _botDisplayName: string): string {
    return toAnonymousJoinUrl(rawUrl);
  }

  async join(ctx: JoinContext): Promise<void> {
    // The interstitial has to go before anything else can be found, and the
    // policy check has to happen before the name field is declared missing —
    // "your tenant forbids this" and "Microsoft renamed a field" are different
    // problems for different people.
    ctx.state.to('navigating', 'goto');
    await ctx.page.goto(ctx.url, {
      timeout: ctx.timeouts.navigateMs,
      waitUntil: 'domcontentloaded',
    });
    await ctx.clickIfPresent('cookieAccept', ctx.timeouts.probeMs);
    await ctx.clickIfPresent('continueInBrowser', ctx.timeouts.interactionMs);

    if (await ctx.present('anonymousBlocked', ctx.timeouts.probeMs)) {
      throw new JoinStalledError({
        driverId: this.id,
        joinState: ctx.state.state,
        stall: ctx.state.describeStall(),
        debugPaths: [],
        guidance:
          'This tenant forbids anonymous meeting join. That is a Teams admin setting ' +
          '(Meeting policy → "Anonymous users can join a meeting"), not something this adapter ' +
          'can work around. Ask the customer to allow it, or run the meeting somewhere else.',
      });
    }

    await runStandardJoin(ctx, {
      dismiss: [],
      nameInput: 'nameInput',
      preJoin: [],
      joinButton: 'joinButton',
      lobbyIndicator: 'lobbyIndicator',
      inCallMarker: 'inCallMarker',
      deniedIndicator: 'deniedIndicator',
    });
  }

  async activeSpeaker(ctx: PageContext): Promise<string | null> {
    return firstMeaningful(await ctx.textsOf('speakingIndicator'));
  }

  async participantNames(ctx: PageContext): Promise<readonly string[]> {
    const texts = await ctx.textsOf('participantNames');
    return texts.map((text) => text.replace(/\s+/g, ' ').trim()).filter((text) => text !== '');
  }

  async wasRemoved(ctx: PageContext): Promise<boolean> {
    return ctx.present('removedDialog', ctx.timeouts.probeMs / 4);
  }

  async hasEnded(ctx: PageContext): Promise<boolean> {
    return ctx.present('endedDialog', ctx.timeouts.probeMs / 4);
  }

  async postChat(ctx: PageContext, message: string): Promise<void> {
    if (!(await ctx.present('chatInput', ctx.timeouts.probeMs))) {
      // Teams collapses its control bar on idle like the rest of them.
      await revealToolbar(ctx);
      await ctx.click('chat', 'chatToggle');
      await ctx.waitFor('chat', 'chatInput', 'visible', ctx.timeouts.interactionMs);
    }
    await ctx.fill('chat', 'chatInput', message);
    await ctx.submit('chat', 'chatInput');
  }

  async setMuted(ctx: PageContext, muted: boolean): Promise<void> {
    await revealToolbar(ctx);
    await ctx.clickIfPresent(muted ? 'muteButton' : 'unmuteButton', ctx.timeouts.probeMs);
  }

  async setHandRaised(ctx: PageContext, raised: boolean): Promise<void> {
    await revealToolbar(ctx);
    await ctx.clickIfPresent(raised ? 'raiseHandButton' : 'lowerHandButton', ctx.timeouts.probeMs);
  }

  async startScreenshare(ctx: PageContext): Promise<void> {
    await revealToolbar(ctx);
    await ctx.click('screenshare', 'startShareButton');
  }

  async stopScreenshare(ctx: PageContext): Promise<void> {
    await revealToolbar(ctx);
    await ctx.clickIfPresent('stopShareButton', ctx.timeouts.interactionMs);
  }

  async leave(ctx: PageContext): Promise<void> {
    await revealToolbar(ctx);
    await ctx.clickIfPresent('leaveButton', ctx.timeouts.interactionMs);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

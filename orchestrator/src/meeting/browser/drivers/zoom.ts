/**
 * Zoom, joined through the **web client** — not the native SDK.
 *
 * ===========================================================================
 * WHY THE WEB CLIENT
 * ===========================================================================
 * The Meeting SDK route is abandoned. It needs a Marketplace app approved by a
 * human at Zoom for raw data access, plus a native C++ Linux distribution that
 * is not on npm and must have a Node binding built against it. Both of those
 * are gates somebody else controls.
 *
 * The web client is the same meeting, reachable with a URL. A shared Zoom link
 * points at the native app; `/wc/join/` is the browser path, and `joinUrl`
 * below does that rewrite so callers can pass whatever the organiser sent them.
 *
 * ===========================================================================
 * DISCLOSED, NOT BURIED
 * ===========================================================================
 * Zoom's terms restrict automated access to the service. This is outside them,
 * the risk has been weighed and accepted at the product level, and `termsRisk`
 * carries it into the log at construction so no deployment can claim it did not
 * know. See orchestrator/README.md.
 *
 * ===========================================================================
 * ZOOM-SPECIFIC AWKWARDNESS
 * ===========================================================================
 *   - Two consent walls before the meeting: a cookie banner and a terms
 *     acknowledgement. Both are in `dismiss` and both are optional, because
 *     which of them appears depends on region and on the account.
 *   - The passcode may be in the URL as `pwd=` or may be a second field. The
 *     URL form is preserved; the field is filled when a passcode was supplied
 *     and the field is on screen.
 *   - The web client renders into nested iframes on some builds. The selectors
 *     below assume Playwright's default of piercing into frames for `text=` and
 *     CSS lookups, which it does for same-origin frames.
 * ===========================================================================
 */

import type { MeetingAdapterCapabilities } from '../../adapter.js';
import type { JoinContext, PageContext, PlatformDriver, SelectorTable } from '../driver.js';
import { firstMeaningful, revealToolbar, runStandardJoin } from './common.js';

const SELECTORS: SelectorTable = {
  cookieAccept: {
    selector: '#onetrust-accept-btn-handler, button:has-text("Accept Cookies")',
    what: 'the OneTrust cookie wall',
    required: false,
  },
  termsAgree: {
    selector: 'button:has-text("I Agree"), #wc_agree1, button:has-text("Agree")',
    what: 'the terms acknowledgement Zoom shows before the pre-join screen',
    required: false,
  },
  nameInput: {
    selector: '#input-for-name, input#inputname, input[aria-label="Your Name"]',
    what: 'the guest name field on the pre-join screen',
    required: true,
  },
  passcodeInput: {
    selector: '#input-for-pwd, input#inputpasscode, input[type="password"]',
    what: 'the meeting passcode field, when the passcode was not in the URL',
    required: false,
  },
  joinButton: {
    selector: '.preview-join-button, button:has-text("Join"), #joinBtn',
    what: 'the button that enters the meeting',
    required: true,
  },
  lobbyIndicator: {
    selector:
      'text=/Please wait, the meeting host will let you in soon|waiting room|Waiting for the host/i',
    what: 'the Zoom waiting room — a host has to admit the guest',
    required: false,
  },
  deniedIndicator: {
    selector: 'text=/host has denied|You have been removed|removed you from/i',
    what: 'the message shown when the host refuses entry',
    required: false,
  },
  inCallMarker: {
    selector: '#wc-container-right, .footer__leave-btn, [aria-label="Leave"], #wc-footer',
    what: 'the in-call chrome; its presence is the definition of "joined"',
    required: true,
  },
  speakingIndicator: {
    selector:
      '.speaker-active-container__video-frame .video-avatar__avatar-name, ' +
      '.gallery-video-container__video-frame--active .video-avatar__avatar-name, ' +
      '.speaker-bar-container__video-frame--active .video-avatar__avatar-name',
    what: 'the name overlay on the tile Zoom marks active. The most fragile selector here: the active class differs between speaker view and gallery view',
    required: false,
  },
  participantsToggle: {
    selector: '[aria-label*="participants" i], .footer-button__participants-icon',
    what: 'opens the participants pane, which is where names are readable',
    required: false,
  },
  participantNames: {
    selector: '.participants-item__display-name, .video-avatar__avatar-name',
    what: 'display names in the participants pane or on the tiles',
    required: false,
  },
  chatToggle: {
    selector: '[aria-label*="chat" i], .footer-button__chat-icon',
    what: 'opens the chat pane',
    required: true,
  },
  chatInput: {
    selector: '.chat-box__chat-textarea textarea, #wc-container-right textarea, textarea[aria-label*="chat" i]',
    what: 'the chat message box',
    required: true,
  },
  leaveButton: {
    selector: '.footer__leave-btn, [aria-label="Leave"], button:has-text("Leave")',
    what: 'hang up',
    required: true,
  },
  leaveConfirm: {
    selector: '.leave-meeting-options__btn--danger, button:has-text("Leave Meeting")',
    what: 'the confirmation Zoom asks for after clicking Leave',
    required: false,
  },
  muteButton: {
    selector: '[aria-label^="mute my microphone" i], .footer-button__button[aria-label*="Mute" i]',
    what: 'mute the microphone',
    required: false,
  },
  unmuteButton: {
    selector: '[aria-label^="unmute my microphone" i], .footer-button__button[aria-label*="Unmute" i]',
    what: 'unmute the microphone',
    required: false,
  },
  reactionsToggle: {
    selector: '[aria-label*="Reactions" i], .footer-button__reactions-icon',
    what: 'the reactions menu, which is where raise hand lives in the web client',
    required: false,
  },
  raiseHandButton: {
    selector: '[aria-label="Raise Hand"], button:has-text("Raise Hand")',
    what: 'raise hand',
    required: false,
  },
  lowerHandButton: {
    selector: '[aria-label="Lower Hand"], button:has-text("Lower Hand")',
    what: 'lower hand',
    required: false,
  },
  startShareButton: {
    selector: '[aria-label*="Share Screen" i], .footer-button__share-icon',
    what: 'start screen sharing',
    required: false,
  },
  stopShareButton: {
    selector: '[aria-label*="Stop Share" i], button:has-text("Stop Share")',
    what: 'stop screen sharing',
    required: false,
  },
  removedDialog: {
    selector: 'text=/You have been removed by the host|The host has removed you/i',
    what: 'the message shown after a host removes this participant',
    required: false,
  },
  endedDialog: {
    selector: 'text=/This meeting has been ended by host|Meeting has ended/i',
    what: 'the message shown when the meeting is over',
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
 * Rewrite a Zoom link to the web client.
 *
 * `https://acme.zoom.us/j/86123456789?pwd=abc` →
 * `https://acme.zoom.us/wc/join/86123456789?pwd=abc`
 *
 * The custom subdomain is preserved: enterprise tenants have their own, and
 * hard-coding `zoom.us` would silently drop people onto the wrong host.
 */
export function toWebClientUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  const match = /^\/(?:j|wc\/join|wc)\/(\d+)/.exec(parsed.pathname);
  if (match === null) return rawUrl;
  const meetingNumber = match[1];
  if (meetingNumber === undefined) return rawUrl;

  parsed.pathname = `/wc/join/${meetingNumber}`;
  return parsed.toString();
}

export class ZoomDriver implements PlatformDriver {
  readonly id = 'zoom' as const;
  readonly platform = 'zoom' as const;
  readonly label = 'Zoom (web client, /wc/join)';
  readonly capabilities = CAPABILITIES;
  readonly selectors = SELECTORS;
  readonly termsRisk =
    "Zoom's terms restrict automated access to the service. Joining the web client with a driven " +
    'browser is outside them. Accepted at the product level; see orchestrator/README.md.';

  matches(url: string): boolean {
    return /(^|\.)zoom\.us$|(^|\.)zoom\.com$/i.test(safeHost(url));
  }

  joinUrl(rawUrl: string, _botDisplayName: string): string {
    return toWebClientUrl(rawUrl);
  }

  async join(ctx: JoinContext): Promise<void> {
    await runStandardJoin(ctx, {
      dismiss: ['cookieAccept', 'termsAgree'],
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
      // Zoom's footer hides on idle like everyone else's.
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
    // Raise hand lives behind the reactions menu in the web client.
    await revealToolbar(ctx);
    await ctx.clickIfPresent('reactionsToggle', ctx.timeouts.probeMs);
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
    await ctx.clickIfPresent('leaveConfirm', ctx.timeouts.probeMs);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

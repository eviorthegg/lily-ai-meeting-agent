/**
 * Google Meet, joined as a guest through the web client.
 *
 * ===========================================================================
 * DISCLOSED, NOT BURIED
 * ===========================================================================
 * Google's Terms of Service restrict automated access to their services outside
 * the published interfaces, and there is no published interface for a bot
 * participant — the Meet REST API manages spaces and post-call artefacts, the
 * Meet Media API is a gated preview for *receiving* media, and the Add-ons SDK
 * runs inside a human's browser session. Driving the web client is outside all
 * three.
 *
 * That risk has been weighed and accepted at the product level. It is stated
 * here and in the README rather than left for someone to discover, and it is
 * carried in `termsRisk` so the adapter logs it at construction. If the answer
 * ever changes, this is the file that has to change with it.
 *
 * ===========================================================================
 * THE TWO THINGS THAT MAKE MEET HARDER THAN THE REST
 * ===========================================================================
 * 1. **Detection.** Meet is the platform most sensitive to headless and
 *    instrumented browsers. That is why the adapter runs headful Chrome in
 *    Xvfb and prefers Google's branded Chrome build over Chromium — see
 *    xvfb.ts. A Meet-only failure with everything else working is the first
 *    thing to check against.
 *
 * 2. **Obfuscated class names.** Meet ships generated CSS classes that change
 *    between releases, so anything class-based here is on borrowed time. The
 *    selectors below prefer, in order: `data-*` attributes, `aria-label`, then
 *    generated classes as a last resort. `speakingIndicator` is the one that
 *    has no good option and it is flagged as such.
 *
 * A guest join lands in "Asking to be let in". That is a **state**, not a hang,
 * and it is surfaced as `lobby` with its own timeout and its own message —
 * because the fix is a person clicking admit, not an engineer reading a stack
 * trace.
 * ===========================================================================
 */

import type { MeetingAdapterCapabilities } from '../../adapter.js';
import type { JoinContext, PageContext, PlatformDriver, SelectorTable } from '../driver.js';
import { firstMeaningful, revealToolbar, runStandardJoin } from './common.js';

const SELECTORS: SelectorTable = {
  cookieAccept: {
    selector: 'button[aria-label*="Accept all" i], button:has-text("Accept all")',
    what: 'the consent wall Google shows in some regions',
    required: false,
  },
  dismissDeviceDialog: {
    selector: 'button:has-text("Continue without microphone and camera"), [aria-label="Dismiss"]',
    what: 'the "no devices found" dialog, which appears when PulseAudio came up late',
    required: false,
  },
  nameInput: {
    // The exact-match `aria-label="Your name"` is kept only for older builds:
    // as of 2026-07-25 the live page labels this field "What's your name?", so
    // that clause matches nothing and the ONLY thing still selecting the field
    // is `jsname="YPqjbf"` — an obfuscated Google identifier that rotates
    // without notice. Verified on a real join: this selector matched exactly 1
    // element, and it was the jsname doing all the work.
    //
    // The substring clause is therefore the durable one, and it is first.
    selector:
      'input[aria-label*="your name" i], input[placeholder*="your name" i], ' +
      'input[aria-label="Your name"], input[jsname="YPqjbf"]',
    what: 'the guest name field',
    required: true,
  },
  joinButton: {
    selector:
      'button:has-text("Ask to join"), button:has-text("Join now"), [jsname="Qx7uuf"], [aria-label="Ask to join"]',
    what: 'the button that requests entry to the meeting',
    required: true,
  },
  lobbyIndicator: {
    selector:
      'text=/Asking to be let in|Someone will let you in soon|Waiting for someone to let you in/i',
    what: 'the "asking to be let in" screen — a person has to click admit',
    required: false,
  },
  deniedIndicator: {
    selector: 'text=/You can\'t join this call|no one responded to your request|denied your request/i',
    what: 'the message shown when the request is refused or times out on Google\'s side',
    required: false,
  },
  inCallMarker: {
    selector: '[data-meeting-code], [aria-label*="Leave call" i], [jsname="CQylAd"]',
    what: 'the in-call layout; its presence is the definition of "joined"',
    required: true,
  },
  speakingIndicator: {
    selector:
      '[data-participant-id]:has(div[class*="IisKdb"]) [class*="notranslate"], ' +
      '[data-participant-id][data-is-speaking="true"] [class*="notranslate"], ' +
      '[data-participant-id]:has([aria-label*="speaking" i]) [data-self-name]',
    what: 'the name on the tile Meet is animating as the speaker. THE fragile selector in this driver: Meet has no stable attribute for it and the class names are generated',
    required: false,
  },
  participantNames: {
    selector:
      '[role="listitem"][data-participant-id] [class*="notranslate"], [data-self-name], [data-participant-id] [jsname="rEjxCb"]',
    what: 'display names in the people panel or on the tiles',
    required: false,
  },
  chatToggle: {
    selector: '[aria-label="Chat with everyone"], button[aria-label*="chat" i]',
    what: 'opens the chat panel',
    required: true,
  },
  chatInput: {
    selector: 'textarea[aria-label="Send a message"], textarea[placeholder*="Send a message" i]',
    what: 'the chat message box',
    required: true,
  },
  chatSend: {
    selector: 'button[aria-label="Send a message"], button[aria-label="Send message"]',
    what: 'the chat send button',
    required: false,
  },
  leaveButton: {
    selector: '[aria-label*="Leave call" i], [jsname="CQylAd"]',
    what: 'hang up',
    required: true,
  },
  muteButton: {
    selector: '[aria-label*="Turn off microphone" i]',
    what: 'mute the microphone',
    required: false,
  },
  unmuteButton: {
    selector: '[aria-label*="Turn on microphone" i]',
    what: 'unmute the microphone',
    required: false,
  },
  raiseHandButton: {
    selector: '[aria-label*="Raise hand" i]',
    what: 'raise hand',
    required: false,
  },
  lowerHandButton: {
    selector: '[aria-label*="Lower hand" i]',
    what: 'lower hand',
    required: false,
  },
  startShareButton: {
    selector: '[aria-label*="Present now" i]',
    what: 'start presenting',
    required: false,
  },
  stopShareButton: {
    selector: '[aria-label*="Stop presenting" i], button:has-text("Stop presenting")',
    what: 'stop presenting',
    required: false,
  },
  removedDialog: {
    selector: 'text=/You\'ve been removed from the meeting|removed you from the meeting/i',
    what: 'the screen shown after a host removes this participant',
    required: false,
  },
  endedDialog: {
    selector: 'text=/The call ended|You left the meeting|Meeting ended/i',
    what: 'the screen shown when the call is over',
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

export class MeetDriver implements PlatformDriver {
  readonly id = 'meet' as const;
  readonly platform = 'meet' as const;
  readonly label = 'Google Meet (web client, guest join)';
  readonly capabilities = CAPABILITIES;
  readonly selectors = SELECTORS;
  readonly termsRisk =
    "Google's Terms of Service restrict automated access outside their published interfaces, " +
    'and no published interface exists for a bot participant. Accepted at the product level; ' +
    'see orchestrator/README.md.';

  matches(url: string): boolean {
    return /(^|\.)meet\.google\.com$/i.test(safeHost(url));
  }

  joinUrl(rawUrl: string, _botDisplayName: string): string {
    // Meet takes no name in the URL — the guest field is the only route, which
    // is why `nameInput` is required rather than a convenience here.
    return rawUrl;
  }

  async join(ctx: JoinContext): Promise<void> {
    await runStandardJoin(ctx, {
      dismiss: ['cookieAccept', 'dismissDeviceDialog'],
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
      // Meet fades its bottom bar out too. Same fix, same reason.
      await revealToolbar(ctx);
      await ctx.click('chat', 'chatToggle');
      await ctx.waitFor('chat', 'chatInput', 'visible', ctx.timeouts.interactionMs);
    }
    await ctx.fill('chat', 'chatInput', message);
    if (!(await ctx.clickIfPresent('chatSend', ctx.timeouts.probeMs))) {
      await ctx.submit('chat', 'chatInput');
    }
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

/**
 * Jitsi Meet — the honest target.
 *
 * ===========================================================================
 * WHY THIS ONE IS FIRST
 * ===========================================================================
 * Jitsi is open source, guests are explicitly allowed, and joining
 * programmatically conflicts with nobody's terms of service. That makes it the
 * only platform this adapter can be *developed* against without an accepted
 * risk hanging over every test run, and the only one CI can point at.
 *
 * It is also the platform whose DOM is knowable: the source is public, and the
 * UI carries `data-testid` attributes that exist precisely so automation can
 * find things. Where a `data-testid` exists it is used, because it is the one
 * class of selector a project has committed to keeping.
 *
 * Self-hosted Jitsi is the recommended deployment for anyone who wants Lily in
 * meetings without the terms question at all — same driver, different host.
 *
 * ===========================================================================
 * ON THE SELECTORS BELOW
 * ===========================================================================
 * Each entry is a comma-separated fallback chain, most specific first, because
 * Jitsi's markup differs between releases and between the hosted meet.jit.si
 * and a self-hosted build. A chain absorbs a rename without a code change; when
 * one stops matching entirely, the failure names this table and this file.
 * ===========================================================================
 */

import type { MeetingAdapterCapabilities } from '../../adapter.js';
import type { PageContext, PlatformDriver, SelectorTable, JoinContext } from '../driver.js';
import { firstMeaningful, revealToolbar, runStandardJoin } from './common.js';

const SELECTORS: SelectorTable = {
  nameInput: {
    selector:
      '#premeeting-name-input, input[name="displayName"], .prejoin-input input, input[placeholder*="name" i]',
    what: 'the guest name field on the pre-join screen',
    required: true,
  },
  joinButton: {
    selector:
      '[data-testid="prejoin.joinMeeting"], [aria-label="Join meeting"], .prejoin-preview button.primary',
    what: 'the button that enters the meeting from the pre-join screen',
    required: true,
  },
  cameraOffBeforeJoin: {
    selector: '[data-testid="prejoin.videoDisable"], .prejoin-preview [aria-label*="camera" i]',
    what: 'pre-join camera toggle; only clicked when the avatar video mode is off',
    required: false,
  },
  lobbyIndicator: {
    selector:
      '[data-testid="lobby.joiningMessage"], .lobby-screen, [class*="lobby-screen"], [data-testid="lobby.knockingParticipantList"]',
    what: 'the "waiting for a moderator" screen',
    required: false,
  },
  deniedIndicator: {
    selector: '[data-testid="lobby.joinRejectedMessage"], [class*="lobby"] [class*="rejected"]',
    what: 'the message shown when a moderator refuses the join request',
    required: false,
  },
  inCallMarker: {
    selector: '#largeVideoContainer, .videocontainer, #videoconference_page, #new-toolbox',
    what: 'the in-call layout; its presence is the definition of "joined"',
    required: true,
  },
  dominantSpeakerName: {
    selector:
      '.videocontainer.dominant-speaker span.displayname, .dominant-speaker [class*="displayname"], #dominantSpeakerName',
    what: 'the display name on the tile Jitsi marks as the dominant speaker — the single most load-bearing selector in this driver',
    required: false,
  },
  participantNames: {
    selector: 'span.displayname, [data-testid="participantsPane"] [class*="participant-name"]',
    what: 'display names of everyone with a tile or a participants-pane row',
    required: false,
  },
  chatToggle: {
    selector: '[data-testid="toolbar.chat"], [aria-label="Open chat"], [aria-label="Chat"]',
    what: 'opens the chat panel',
    required: true,
  },
  chatInput: {
    selector: '#chat-input textarea, textarea#usermsg, .chat-input-container textarea',
    what: 'the chat message box',
    required: true,
  },
  leaveButton: {
    selector: '[data-testid="toolbox.leave"], [aria-label*="Leave the meeting" i], .hangup-button',
    what: 'hang up',
    required: true,
  },
  muteButton: {
    selector: '[data-testid="toolbar.mute"], [aria-label*="Mute microphone" i]',
    what: 'mute the microphone',
    required: false,
  },
  unmuteButton: {
    selector: '[data-testid="toolbar.unmute"], [aria-label*="Unmute microphone" i]',
    what: 'unmute the microphone',
    required: false,
  },
  raiseHandButton: {
    selector: '[data-testid="toolbar.raiseHand"], [aria-label*="Raise your hand" i]',
    what: 'raise hand',
    required: false,
  },
  lowerHandButton: {
    selector: '[data-testid="toolbar.lowerYourHand"], [aria-label*="Lower your hand" i]',
    what: 'lower hand',
    required: false,
  },
  startShareButton: {
    selector: '[data-testid="toolbar.startScreenSharing"], [aria-label*="Start sharing" i]',
    what: 'start screen sharing',
    required: false,
  },
  stopShareButton: {
    selector: '[data-testid="toolbar.stopScreenSharing"], [aria-label*="Stop sharing" i]',
    what: 'stop screen sharing',
    required: false,
  },
  removedDialog: {
    selector: '[data-testid="dialog.kickTitle"], [class*="kicked"]',
    what: 'the dialog shown after a moderator removes this participant',
    required: false,
  },
  endedDialog: {
    selector:
      '[data-testid="dialog.conferenceDisconnectTitle"], [data-testid="dialog.sessTerminatedReason"], .premeeting-screen [class*="ended"]',
    what: 'the dialog shown when the conference itself has finished',
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

export class JitsiDriver implements PlatformDriver {
  readonly id = 'jitsi' as const;
  readonly platform = 'jitsi' as const;
  readonly label = 'Jitsi Meet (meet.jit.si or self-hosted)';
  readonly capabilities = CAPABILITIES;
  readonly selectors = SELECTORS;
  /** The one platform with nothing to disclose. */
  readonly termsRisk = null;

  matches(url: string): boolean {
    return /(^|\.)jit\.si$|jitsi/i.test(safeHost(url)) || /\/jitsi\//i.test(url);
  }

  /**
   * Jitsi takes configuration in the URL fragment.
   *
   * `userInfo.displayName` pre-fills the name field, which means the driver's
   * name-entry step is a confirmation rather than the only chance to get it
   * right — and the participant list is correct even if the pre-join screen is
   * skipped by a server-side setting.
   */
  joinUrl(rawUrl: string, botDisplayName: string): string {
    const [base, existingHash] = rawUrl.split('#');
    const settings = [
      `userInfo.displayName=${encodeURIComponent(`"${botDisplayName}"`)}`,
      'config.startWithAudioMuted=false',
      'config.disableDeepLinking=true',
      // Nothing here should ever be recorded by the client.
      'config.localRecording.enabled=false',
    ];
    const hash = existingHash === undefined || existingHash === '' ? settings.join('&') : `${existingHash}&${settings.join('&')}`;
    return `${base ?? rawUrl}#${hash}`;
  }

  async join(ctx: JoinContext): Promise<void> {
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
    return firstMeaningful(await ctx.textsOf('dominantSpeakerName'));
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
      // The toolbar is hidden by now — nothing has moved the pointer since the
      // call settled — so `chatToggle` is present and not hittable until this.
      await revealToolbar(ctx);
      await ctx.click('chat', 'chatToggle');
      await ctx.waitFor('chat', 'chatInput', 'visible', ctx.timeouts.interactionMs);
    }
    await ctx.fill('chat', 'chatInput', message);
    // Jitsi sends on Enter; not every build has a separate send button.
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

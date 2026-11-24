/**
 * The meeting platform, behind one door.
 *
 * Nothing downstream of this interface knows whether Lily is in a Zoom call, a
 * Teams call, or the local simulated room. That is not tidiness for its own
 * sake: the platform layer is the part of this system most likely to be ripped
 * out and replaced — Zoom needs an approved SDK app, Teams needs Microsoft's
 * media-bot review, Google Meet has no first-party bot API at all — and the
 * orchestration logic must survive all of that unchanged.
 *
 * Consequences of that, which implementations must respect:
 *
 *   - `capabilities` is honest. A platform that cannot carry audio says so,
 *     and the session picks a brain that works over text rather than pretending
 *     a microphone exists.
 *   - Unsupported operations reject with `MeetingAdapterUnsupportedError`.
 *     They never resolve as if they had worked.
 *   - Anything requiring a credential we do not have fails at *construction*,
 *     with a message naming exactly what is missing. Discovering that mid-call
 *     means a room full of people watching a bot that cannot speak.
 */

import type {
  AudioStream,
  HeardUtterance,
  Participant,
  SpeechOutput,
} from '../types.js';

/**
 * `jitsi` is here because the browser adapter has to report an honest platform
 * and Jitsi is the one it is developed and tested against. Adding a member is
 * the only change this file has taken for that adapter — the `MeetingAdapter`
 * interface below is untouched, and deliberately so.
 */
export type MeetingPlatform = 'local' | 'zoom' | 'meet' | 'teams' | 'jitsi';

export interface MeetingAdapterCapabilities {
  /** Can carry PCM audio in and out. False for the local text room. */
  readonly audio: boolean;
  /** Has a text channel Lily can post to. */
  readonly chat: boolean;
  readonly screenshare: boolean;
  readonly raiseHand: boolean;
  readonly mute: boolean;
  /** Can report who is in the room. */
  readonly roster: boolean;
}

export interface MeetingJoinResult {
  readonly meetingId: string;
  readonly joinedAt: Date;
  readonly participants: readonly Participant[];
}

export type MeetingEndReason =
  | 'meeting_ended'
  | 'empty_room'
  | 'silence'
  | 'max_duration'
  | 'kicked'
  | 'error';

export type Unsubscribe = () => void;

export interface MeetingAdapter {
  readonly platform: MeetingPlatform;
  readonly capabilities: MeetingAdapterCapabilities;

  join(): Promise<MeetingJoinResult>;
  leave(reason: MeetingEndReason): Promise<void>;

  /**
   * Say something.
   *
   * Text output on an audio platform is the adapter's problem to synthesise or
   * to route to chat; the caller does not branch on platform.
   */
  speak(output: SpeechOutput): Promise<void>;

  /** Stop mid-utterance. Called on barge-in, within `config.realtime.bargeInCutoffMs`. */
  stopSpeaking(): Promise<void>;

  /** Null when `capabilities.audio` is false. */
  getAudioStream(): AudioStream | null;

  postChat(message: string): Promise<void>;
  startScreenshare(url: string): Promise<void>;
  stopScreenshare(): Promise<void>;
  raiseHand(): Promise<void>;
  lowerHand(): Promise<void>;
  mute(): Promise<void>;
  unmute(): Promise<void>;

  getParticipants(): Promise<readonly Participant[]>;

  onParticipantJoin(handler: (participant: Participant) => void): Unsubscribe;
  onParticipantLeave(handler: (participant: Participant) => void): Unsubscribe;

  /**
   * Something was said.
   *
   * Typed text in the local room, recognised speech on a real platform. The
   * payload is transient by contract: handlers may classify it and hand it to a
   * dispatch, and must not store or log it.
   */
  onUtterance(handler: (utterance: HeardUtterance) => void): Unsubscribe;

  /** The platform ended the call, or Lily was removed from it. */
  onMeetingEnd(handler: (reason: MeetingEndReason) => void): Unsubscribe;

  /** Live work-in-progress under Lily's avatar, where the platform supports it. */
  setStatus(status: { state: string; note?: string } | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

/**
 * A platform cannot be used because something concrete is absent.
 *
 * Carries the list of missing items so the message is actionable rather than
 * "failed to join". Thrown from the constructor, before anyone schedules a
 * meeting against an adapter that was never going to work.
 */
export class MeetingAdapterUnavailableError extends Error {
  override readonly name = 'MeetingAdapterUnavailableError';
  readonly platform: MeetingPlatform;
  readonly missing: readonly string[];

  constructor(platform: MeetingPlatform, missing: readonly string[], guidance: string) {
    super(
      `The ${platform} meeting adapter cannot be constructed.\n` +
        `Missing:\n${missing.map((item) => `  - ${item}`).join('\n')}\n\n${guidance}`,
    );
    this.platform = platform;
    this.missing = missing;
  }
}

export class MeetingAdapterUnsupportedError extends Error {
  override readonly name = 'MeetingAdapterUnsupportedError';

  constructor(platform: MeetingPlatform, operation: string) {
    super(`The ${platform} meeting adapter does not support ${operation}.`);
  }
}

/**
 * A preflight result, so a caller can ask "would this work?" without
 * constructing an adapter and catching.
 */
export interface AdapterPreflight {
  readonly platform: MeetingPlatform;
  readonly ready: boolean;
  readonly missing: readonly string[];
  /** Requirements that no environment variable can satisfy — approvals, reviews. */
  readonly blockers: readonly string[];
}

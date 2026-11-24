/**
 * The brain contract.
 *
 * ===========================================================================
 * WHAT A BRAIN IS AND IS NOT ALLOWED TO BE
 * ===========================================================================
 * A brain is Lily's *senses and voice*. It turns audio or text into an
 * utterance, and turns a line into speech.
 *
 * It is not her judgement. Deciding whether a sentence was addressed to Lily,
 * whether to touch someone's machine, who may approve what, and what gets
 * recorded — none of that lives in a brain. All of it lives in
 * `MeetingSession`, reached through `BrainHooks`, and both implementations
 * call the same hooks in the same order.
 *
 * That split is what makes `TextBrain` a real implementation rather than a
 * mock. It is not a simplified copy of the realtime path; it is the realtime
 * path with the model's ears and mouth removed. If a classification bug exists,
 * both brains have it, and the text tests catch it.
 * ===========================================================================
 */

import type { Classification } from '../classify.js';
import type { AudioFrame, HeardUtterance, LilyUtterance, SpeechOutput } from '../types.js';

export type BrainKind = 'realtime' | 'text';

export interface BrainPerson {
  readonly employeeId: string;
  readonly name: string;
  readonly jobDescription: string;
  readonly capabilities: readonly string[];
  readonly daemonEnrolled: boolean;
}

export interface BrainContext {
  readonly meetingId: string;
  readonly botDisplayName: string;
  readonly people: readonly BrainPerson[];
}

/**
 * The orchestration surface, implemented once by `MeetingSession`.
 *
 * Note what is absent: there is no hook that lets a brain dispatch a task, deny
 * a permission or write a task directly. The only way to affect the meeting is
 * `apply`, and `apply` takes a `Classification` that came from `classify`.
 */
export interface BrainHooks {
  context(): BrainContext;

  /** The one classifier. Neither brain may substitute its own. */
  classify(utterance: HeardUtterance): Classification;

  /** Everything that follows from a classification. */
  apply(utterance: HeardUtterance, classification: Classification): Promise<void>;

  meterAudioSec(seconds: number): void;
  meterReasoningTokens(tokens: number): void;
  meterTtsChars(chars: number): void;
}

/**
 * Who the *platform* says is talking right now.
 *
 * Supplied by the adapter, not inferred by the brain. No speech-to-speech model
 * diarizes a mixed meeting stream reliably, and guessing is not an option here:
 * the permission gate only accepts the owning employee's own spoken "yes", so a
 * mis-attributed utterance is a mis-granted permission on somebody's machine.
 *
 * `employeeId` is null for a guest, an unknown name or an ambiguous one, and
 * null denies. That is the safe direction and it is the only direction an
 * uncertain answer is allowed to take.
 */
export interface SpeakerHint {
  readonly participantId: string;
  readonly employeeId: string | null;
  readonly displayName: string;
}

export interface LilyBrain {
  readonly kind: BrainKind;
  /** True when the brain cannot function on a `capabilities.audio === false` adapter. */
  readonly requiresAudio: boolean;

  attach(hooks: BrainHooks): void;
  start(): Promise<void>;

  /** A complete utterance from the room. */
  hear(utterance: HeardUtterance): Promise<void>;
  /** Raw audio, for brains that consume it. Ignored by `TextBrain`. */
  hearAudio(frame: AudioFrame): Promise<void>;
  /**
   * The active speaker changed, or fell to nobody.
   *
   * Whatever transcript arrives next belongs to this person. Brains that do not
   * transcribe ignore it.
   */
  noteSpeaker(speaker: SpeakerHint | null): void;

  /** Turn one of Lily's lines into something the adapter can emit. */
  render(line: LilyUtterance): Promise<SpeechOutput>;

  /** Cut the current output. */
  bargeIn(): Promise<void>;

  stop(): Promise<void>;
}

export class BrainUnavailableError extends Error {
  override readonly name = 'BrainUnavailableError';

  constructor(kind: BrainKind, missing: readonly string[], guidance: string) {
    super(
      `The ${kind} brain cannot start.\n` +
        `Missing:\n${missing.map((item) => `  - ${item}`).join('\n')}\n\n${guidance}`,
    );
  }
}

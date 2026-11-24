/**
 * The deterministic brain.
 *
 * Runs the identical classification, dispatch and permission logic as the
 * realtime brain, over typed text instead of speech. What it removes is the
 * model, not the reasoning: `hear()` here and `hear()` in `RealtimeBrain` make
 * the same two calls in the same order, and everything either of them can do to
 * the meeting goes through `hooks.apply`.
 *
 * That is what makes the whole product runnable with no OpenAI key, no spend,
 * and a deterministic CI — and it is why the classification tests are worth
 * anything: they exercise the same path production takes.
 */

import { log } from '../util/log.js';
import type { AudioFrame, HeardUtterance, LilyUtterance, SpeechOutput } from '../types.js';
import type { BrainHooks, LilyBrain, SpeakerHint } from './types.js';

export class TextBrain implements LilyBrain {
  readonly kind = 'text' as const;
  readonly requiresAudio = false;

  #hooks: BrainHooks | null = null;

  attach(hooks: BrainHooks): void {
    this.#hooks = hooks;
  }

  async start(): Promise<void> {
    const hooks = this.#requireHooks();
    const context = hooks.context();
    log.info('brain.started', {
      kind: this.kind,
      meetingId: context.meetingId,
      peopleCount: context.people.length,
    });
  }

  async hear(utterance: HeardUtterance): Promise<void> {
    const hooks = this.#requireHooks();
    const classification = hooks.classify(utterance);
    await hooks.apply(utterance, classification);
  }

  async hearAudio(_frame: AudioFrame): Promise<void> {
    // No audio path. The session never calls this, because `requiresAudio` is
    // false and the local adapter reports `capabilities.audio === false`.
  }

  noteSpeaker(_speaker: SpeakerHint | null): void {
    // Typed text already carries its author. There is nothing to attribute.
  }

  async render(line: LilyUtterance): Promise<SpeechOutput> {
    // Counted as TTS characters even though nothing is synthesised locally, so
    // the local stage produces the same metering shape a deployed one does.
    this.#requireHooks().meterTtsChars(line.text.length);
    return { kind: 'text', text: line.text };
  }

  async bargeIn(): Promise<void> {
    // A text line is atomic — there is no partially-emitted output to cut.
  }

  async stop(): Promise<void> {
    this.#hooks = null;
  }

  #requireHooks(): BrainHooks {
    const hooks = this.#hooks;
    if (hooks === null) throw new Error('TextBrain.attach() must be called before use.');
    return hooks;
  }
}

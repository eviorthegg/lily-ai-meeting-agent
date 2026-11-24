/**
 * When Lily talks.
 *
 * A meeting assistant that answers the instant it has an answer is worse than
 * one that is slightly slow: it talks over people, and a room learns very
 * quickly to stop talking near it. So every line Lily produces goes through
 * here, and here waits for a gap.
 *
 * Three rules:
 *
 *   1. Wait for a pause. `config.realtime.turnDetection.silenceDurationMs` of
 *      nobody speaking is the gap; the queue drains into it by priority.
 *   2. Do not interrupt. Lily speaks when she is addressed by name, asked
 *      directly, or raising a pending permission — the caller decides which of
 *      those applies by choosing a priority, and `ambient` lines are dropped if
 *      the moment passes rather than surfacing thirty seconds late.
 *   3. Stop when talked over, within `config.realtime.bargeInCutoffMs`.
 */

import { newMessageId } from './util/ids.js';
import type { Clock, TimerHandle, Timers } from './util/clock.js';
import { systemClock, systemTimers } from './util/clock.js';
import type { LilyUtterance, SpeechPriority } from './types.js';

const PRIORITY_ORDER: Record<SpeechPriority, number> = {
  permission: 0,
  answer: 1,
  ack: 2,
  wrapup: 3,
  ambient: 4,
};

export interface SpeechSchedulerOptions {
  /** `config.realtime.turnDetection.silenceDurationMs`. */
  readonly pauseMs: number;
  /** `config.realtime.bargeInCutoffMs`. */
  readonly bargeInCutoffMs: number;
  readonly speak: (line: LilyUtterance) => Promise<void>;
  readonly stopSpeaking: () => Promise<void>;
  /** How stale an `ambient` line may get before it is dropped. */
  readonly ambientTtlMs?: number;
  readonly clock?: Clock;
  readonly timers?: Timers;
}

interface QueueEntry {
  readonly line: LilyUtterance;
  readonly queuedAt: number;
  readonly resolve: (spoken: boolean) => void;
}

export class SpeechScheduler {
  readonly #options: SpeechSchedulerOptions;
  readonly #clock: Clock;
  readonly #timers: Timers;
  readonly #queue: QueueEntry[] = [];

  #speaking = false;
  #pumping = false;
  #lastRoomSpeechAt: number;
  #retry: TimerHandle | null = null;
  #bargeIn: TimerHandle | null = null;
  #closed = false;
  #bargeInCount = 0;

  constructor(options: SpeechSchedulerOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? systemTimers;
    // Starts long ago so the very first line does not wait for a pause that
    // has, in the only sense that matters, already happened.
    this.#lastRoomSpeechAt = this.#clock.now() - options.pauseMs;
  }

  get isSpeaking(): boolean {
    return this.#speaking;
  }

  get pendingCount(): number {
    return this.#queue.length;
  }

  /** How many times Lily has been cut off. Useful signal that she is too eager. */
  get bargeInCount(): number {
    return this.#bargeInCount;
  }

  /** Someone in the room said something. Resets the pause window. */
  noteRoomSpeech(): void {
    this.#lastRoomSpeechAt = this.#clock.now();

    if (this.#speaking && this.#bargeIn === null) {
      // Rule 3. Cancelled below if she finishes on her own first.
      this.#bargeIn = this.#timers.after(this.#options.bargeInCutoffMs, () => {
        this.#bargeIn = null;
        if (!this.#speaking) return;
        this.#bargeInCount += 1;
        void this.#options.stopSpeaking();
      });
    }
  }

  /**
   * Queue a line. Resolves true when it was spoken, false when it was dropped.
   *
   * Callers that need to know when their words actually reached the room — the
   * permission relay, whose approval window opens on delivery — await this.
   */
  say(
    text: string,
    priority: SpeechPriority,
    options: { mustDeliver?: boolean } = {},
  ): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);

    const line: LilyUtterance = {
      id: newMessageId(),
      text,
      priority,
      mustDeliver: options.mustDeliver ?? priority !== 'ambient',
    };

    return new Promise<boolean>((resolve) => {
      this.#queue.push({ line, queuedAt: this.#clock.now(), resolve });
      void this.#pump();
    });
  }

  /**
   * Say something without waiting for a gap.
   *
   * Exactly two callers are legitimate: the join announcement, which must land
   * before anyone speaks, and the goodbye. Everything else waits its turn.
   */
  async sayImmediately(text: string, priority: SpeechPriority = 'ambient'): Promise<void> {
    if (this.#closed) return;
    const line: LilyUtterance = { id: newMessageId(), text, priority, mustDeliver: true };
    this.#speaking = true;
    try {
      await this.#options.speak(line);
    } finally {
      this.#speaking = false;
      this.#clearBargeIn();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#retry !== null) this.#timers.cancel(this.#retry);
    this.#retry = null;
    this.#clearBargeIn();

    while (this.#queue.length > 0) {
      const entry = this.#queue.shift();
      entry?.resolve(false);
    }
  }

  // -------------------------------------------------------------------------

  #clearBargeIn(): void {
    if (this.#bargeIn !== null) {
      this.#timers.cancel(this.#bargeIn);
      this.#bargeIn = null;
    }
  }

  async #pump(): Promise<void> {
    if (this.#pumping || this.#speaking || this.#closed) return;
    if (this.#queue.length === 0) return;

    const waited = this.#clock.now() - this.#lastRoomSpeechAt;
    if (waited < this.#options.pauseMs) {
      // Rule 1. Come back when the room has actually stopped.
      if (this.#retry === null) {
        this.#retry = this.#timers.after(this.#options.pauseMs - waited, () => {
          this.#retry = null;
          void this.#pump();
        });
      }
      return;
    }

    this.#pumping = true;
    try {
      for (;;) {
        this.#dropStale();
        const entry = this.#takeNext();
        if (entry === null) break;

        this.#speaking = true;
        try {
          await this.#options.speak(entry.line);
          entry.resolve(true);
        } catch {
          entry.resolve(false);
        } finally {
          this.#speaking = false;
          this.#clearBargeIn();
        }

        // Someone jumped in while she was talking: yield the floor rather than
        // steamrolling into the next queued line.
        if (this.#clock.now() - this.#lastRoomSpeechAt < this.#options.pauseMs) break;
      }
    } finally {
      this.#pumping = false;
    }

    if (this.#queue.length > 0) void this.#pump();
  }

  #dropStale(): void {
    const ttl = this.#options.ambientTtlMs ?? 30_000;
    const now = this.#clock.now();

    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      const entry = this.#queue[i];
      if (entry === undefined) continue;
      if (entry.line.mustDeliver) continue;
      if (now - entry.queuedAt <= ttl) continue;
      this.#queue.splice(i, 1);
      entry.resolve(false);
    }
  }

  #takeNext(): QueueEntry | null {
    if (this.#queue.length === 0) return null;

    let bestIndex = 0;
    let best = this.#queue[0];
    if (best === undefined) return null;

    for (let i = 1; i < this.#queue.length; i += 1) {
      const candidate = this.#queue[i];
      if (candidate === undefined) continue;
      const better =
        PRIORITY_ORDER[candidate.line.priority] < PRIORITY_ORDER[best.line.priority] ||
        (PRIORITY_ORDER[candidate.line.priority] === PRIORITY_ORDER[best.line.priority] &&
          candidate.queuedAt < best.queuedAt);
      if (better) {
        best = candidate;
        bestIndex = i;
      }
    }

    this.#queue.splice(bestIndex, 1);
    return best;
  }
}

/**
 * Metering Lily, and only Lily.
 *
 * ===========================================================================
 * WHAT IS AND IS NOT BILLABLE
 * ===========================================================================
 * Billable — Lily's own consumption, all of it incurred by us:
 *   realtime audio seconds, her reasoning tokens, TTS characters, web searches,
 *   and the wall-clock seconds the orchestrator instance is alive.
 *
 * NOT billable, ever — the employee's agent:
 *   Claude Code, Codex or Cursor running on someone's laptop against their own
 *   subscription. We do not pay for those tokens, we cannot see them, and a
 *   customer must never be charged for them. A dispatched task that occupies a
 *   developer's machine for four minutes of heavy work adds exactly zero here.
 *
 * The distinction is enforced structurally rather than by convention:
 * `noteDispatch()` and `noteDispatchComplete()` exist, take no cost arguments,
 * and increment only a non-billable counter. There is no method on this class
 * that can add employee-side consumption to a bill, so the mistake is not
 * available to make.
 * ===========================================================================
 */

import { log } from './util/log.js';
import type { Clock, TimerHandle, Timers } from './util/clock.js';
import { systemClock, systemTimers } from './util/clock.js';

/** Matches `UsageEventDoc.breakdown` in api/src/db/schema.ts. */
export interface UsageBreakdown {
  readonly realtimeAudioSec: number;
  readonly ec2Sec: number;
  readonly ttsChars: number;
  readonly searchCalls: number;
  readonly reasoningTokens: number;
}

export interface UsageSlice {
  readonly at: Date;
  /** Normalised Lily tokens for this slice. */
  readonly tokens: number;
  readonly breakdown: UsageBreakdown;
  readonly final: boolean;
  /**
   * How many tasks were dispatched to employee agents during this slice.
   * Reported for product analytics. Contributes nothing to `tokens` — see the
   * header.
   */
  readonly dispatchedTaskCount: number;
}

export interface UsageSink {
  record(slice: UsageSlice): void | Promise<void>;
}

/**
 * Conversion into the single "Lily token" unit the plan allowance is denominated
 * in. Coefficients live together so margin can be re-tuned in one place.
 *
 * These belong in `config.billing` alongside the plan allowances once that
 * section exists in `packages/shared` — flagged in the orchestrator README
 * rather than added here, since shared is another agent's scope.
 */
export const USAGE_WEIGHTS = {
  perRealtimeAudioSec: 1,
  perEc2Sec: 0.05,
  perThousandTtsChars: 0.5,
  perSearchCall: 5,
  perThousandReasoningTokens: 1,
} as const;

export function normaliseTokens(breakdown: UsageBreakdown): number {
  const total =
    breakdown.realtimeAudioSec * USAGE_WEIGHTS.perRealtimeAudioSec +
    breakdown.ec2Sec * USAGE_WEIGHTS.perEc2Sec +
    (breakdown.ttsChars / 1000) * USAGE_WEIGHTS.perThousandTtsChars +
    breakdown.searchCalls * USAGE_WEIGHTS.perSearchCall +
    (breakdown.reasoningTokens / 1000) * USAGE_WEIGHTS.perThousandReasoningTokens;

  return Math.round(total * 1000) / 1000;
}

export interface UsageMeterOptions {
  readonly sink: UsageSink;
  /** `config.meeting.usageFlushIntervalSec`. */
  readonly flushIntervalSec: number;
  readonly clock?: Clock;
  readonly timers?: Timers;
}

const EMPTY: UsageBreakdown = {
  realtimeAudioSec: 0,
  ec2Sec: 0,
  ttsChars: 0,
  searchCalls: 0,
  reasoningTokens: 0,
};

export class UsageMeter {
  readonly #sink: UsageSink;
  readonly #clock: Clock;
  readonly #timers: Timers;
  readonly #flushIntervalSec: number;
  readonly #startedAt: number;

  #interval: TimerHandle | null = null;
  #lastFlushAt: number;
  #current: UsageBreakdown = EMPTY;
  #dispatched = 0;
  #dispatchedTotal = 0;
  #closed = false;

  constructor(options: UsageMeterOptions) {
    this.#sink = options.sink;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? systemTimers;
    this.#flushIntervalSec = options.flushIntervalSec;
    this.#startedAt = this.#clock.now();
    this.#lastFlushAt = this.#startedAt;
  }

  /**
   * Start the periodic flush.
   *
   * The interval exists so a crashed orchestrator loses at most one interval of
   * usage rather than a whole meeting — an EC2 instance that dies at minute 58
   * of an hour-long call must not silently zero the bill.
   */
  start(): void {
    if (this.#interval !== null) return;
    this.#interval = this.#timers.every(this.#flushIntervalSec * 1000, () => {
      void this.flush(false);
    });
  }

  addRealtimeAudioSec(seconds: number): void {
    if (seconds <= 0) return;
    this.#current = { ...this.#current, realtimeAudioSec: this.#current.realtimeAudioSec + seconds };
  }

  addReasoningTokens(tokens: number): void {
    if (tokens <= 0) return;
    this.#current = { ...this.#current, reasoningTokens: this.#current.reasoningTokens + tokens };
  }

  addTtsChars(chars: number): void {
    if (chars <= 0) return;
    this.#current = { ...this.#current, ttsChars: this.#current.ttsChars + chars };
  }

  addSearchCall(count = 1): void {
    if (count <= 0) return;
    this.#current = { ...this.#current, searchCalls: this.#current.searchCalls + count };
  }

  /**
   * A task went out to an employee's own agent.
   *
   * Takes no duration and no token count, and there is deliberately no overload
   * that does. Whatever that machine spends is the employee's own bill.
   */
  noteDispatch(): void {
    this.#dispatched += 1;
    this.#dispatchedTotal += 1;
  }

  /** Symmetry with `noteDispatch`, and equally free. */
  noteDispatchComplete(): void {
    // Intentionally empty. It exists so the call site reads as metered and a
    // future reader does not "fix" the asymmetry by adding a cost here.
  }

  get dispatchedTaskCount(): number {
    return this.#dispatchedTotal;
  }

  /** Billable seconds of instance runtime so far. */
  get runtimeSec(): number {
    return Math.max(0, Math.round((this.#clock.now() - this.#startedAt) / 1000));
  }

  async flush(final: boolean): Promise<UsageSlice> {
    const now = this.#clock.now();
    const ec2Sec = Math.max(0, Math.round((now - this.#lastFlushAt) / 1000));
    this.#lastFlushAt = now;

    const breakdown: UsageBreakdown = { ...this.#current, ec2Sec };
    const slice: UsageSlice = {
      at: this.#clock.date(),
      tokens: normaliseTokens(breakdown),
      breakdown,
      final,
      dispatchedTaskCount: this.#dispatched,
    };

    this.#current = EMPTY;
    this.#dispatched = 0;

    try {
      await this.#sink.record(slice);
    } catch (cause) {
      // A failed flush must not take the meeting down. The next interval
      // re-reports its own slice; at worst one interval is lost, which is the
      // bound the design already accepts.
      log.error('usage.flush_failed', {
        final,
        error: cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200),
      });
    }

    return slice;
  }

  /** Stop the timer and emit the final slice. */
  async close(): Promise<UsageSlice> {
    if (this.#interval !== null) {
      this.#timers.cancel(this.#interval);
      this.#interval = null;
    }
    if (this.#closed) return this.flush(true);
    this.#closed = true;
    return this.flush(true);
  }
}

/** Keeps slices in memory. Used by the local stage and by tests. */
export class InMemoryUsageSink implements UsageSink {
  readonly slices: UsageSlice[] = [];

  record(slice: UsageSlice): void {
    this.slices.push(slice);
  }

  get totalTokens(): number {
    return Math.round(this.slices.reduce((sum, slice) => sum + slice.tokens, 0) * 1000) / 1000;
  }
}

/**
 * Injected time.
 *
 * Every deadline in this package (permission windows, silence timeouts, the
 * max-duration cap, the usage flush interval) reads the clock through here
 * rather than calling `Date.now()` or `setTimeout` directly. A test can then
 * drive a 45-second approval window to its expiry in microseconds and assert
 * the denial deterministically, instead of sleeping or relying on fake-timer
 * monkey-patching that also freezes the WebSocket layer.
 */

export interface Clock {
  now(): number;
  date(): Date;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
};

export type TimerHandle = { readonly __timer: unique symbol };

export interface Timers {
  after(ms: number, fn: () => void): TimerHandle;
  every(ms: number, fn: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export const systemTimers: Timers = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    // Timers must not hold the process open: the orchestrator exits when the
    // meeting ends, not when the last stray interval happens to fire.
    t.unref?.();
    return t as unknown as TimerHandle;
  },
  every(ms, fn) {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t as unknown as TimerHandle;
  },
  cancel(handle) {
    clearTimeout(handle as unknown as NodeJS.Timeout);
    clearInterval(handle as unknown as NodeJS.Timeout);
  },
};

/** Drives `Clock` and `Timers` from an explicit cursor. Tests only. */
export class ManualClock implements Clock, Timers {
  #now: number;
  #seq = 0;
  readonly #pending = new Map<
    number,
    { at: number; every: number | null; fn: () => void }
  >();

  constructor(startMs = Date.parse('2026-07-25T10:00:00.000Z')) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  date(): Date {
    return new Date(this.#now);
  }

  after(ms: number, fn: () => void): TimerHandle {
    const id = ++this.#seq;
    this.#pending.set(id, { at: this.#now + ms, every: null, fn });
    return id as unknown as TimerHandle;
  }

  every(ms: number, fn: () => void): TimerHandle {
    const id = ++this.#seq;
    this.#pending.set(id, { at: this.#now + ms, every: ms, fn });
    return id as unknown as TimerHandle;
  }

  cancel(handle: TimerHandle): void {
    this.#pending.delete(handle as unknown as number);
  }

  /** Advance time, firing every callback whose deadline is crossed, in order. */
  advance(ms: number): void {
    const target = this.#now + ms;

    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;

      for (const [id, entry] of this.#pending) {
        if (entry.at <= target && entry.at < nextAt) {
          nextAt = entry.at;
          nextId = id;
        }
      }

      if (nextId === null) break;

      const entry = this.#pending.get(nextId);
      if (entry === undefined) break;

      this.#now = entry.at;
      if (entry.every === null) {
        this.#pending.delete(nextId);
      } else {
        entry.at = this.#now + entry.every;
      }
      entry.fn();
    }

    this.#now = target;
  }
}

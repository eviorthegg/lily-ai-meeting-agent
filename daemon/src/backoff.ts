/**
 * Reconnect backoff.
 *
 * Every employee daemon in an org reconnects at once when the WebSocket tier is
 * redeployed, so plain exponential backoff would produce a synchronised thundering
 * herd on a cold API Gateway. Jitter is what actually spreads the reconnects;
 * the exponential part only stops a single client hammering.
 */

export interface BackoffOptions {
  /** Delay for the first retry, before any exponential growth. */
  readonly baseMs?: number;
  /** Hard ceiling. The delay never exceeds this, however many attempts have failed. */
  readonly maxMs?: number;
  readonly factor?: number;
  /** Seam for tests. Defaults to Math.random. */
  readonly random?: () => number;
}

const DEFAULTS = {
  baseMs: 1_000,
  // A daemon that has been offline for half a minute is not urgent, but a laptop
  // coming out of sleep should not wait minutes to reappear in the meeting.
  maxMs: 30_000,
  factor: 2,
} as const;

export class Backoff {
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #factor: number;
  readonly #random: () => number;
  #attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.#baseMs = options.baseMs ?? DEFAULTS.baseMs;
    this.#maxMs = options.maxMs ?? DEFAULTS.maxMs;
    this.#factor = options.factor ?? DEFAULTS.factor;
    this.#random = options.random ?? Math.random;
  }

  get attempt(): number {
    return this.#attempt;
  }

  /**
   * Delay before the next connect attempt, in ms.
   *
   * Full jitter (`random() * capped`) rather than equal jitter: it spreads a herd
   * across the whole window instead of clustering the second half of it. The
   * floor of `baseMs / 2` keeps a flapping server from turning into a tight loop
   * when `random()` returns something near zero.
   */
  next(): number {
    const uncapped = this.#baseMs * Math.pow(this.#factor, this.#attempt);
    const capped = Math.min(uncapped, this.#maxMs);
    this.#attempt += 1;
    return Math.max(Math.floor(this.#random() * capped), Math.floor(this.#baseMs / 2));
  }

  /** Called after a connection is established, so the next outage starts cheap again. */
  reset(): void {
    this.#attempt = 0;
  }
}

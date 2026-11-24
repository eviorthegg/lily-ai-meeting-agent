/**
 * The join state machine.
 *
 * ===========================================================================
 * WHY AN EXPLICIT MACHINE RATHER THAN A SEQUENCE OF AWAITS
 * ===========================================================================
 * Joining a meeting through a web client is a sequence of things that can each
 * stall forever: the page never loads, the name field never appears, the host
 * never admits the guest, the call UI never renders. A straight line of
 * `await page.click(...)` reports all four of those the same way — a timeout
 * with a stack trace pointing at Playwright.
 *
 * That is useless at 9am when a standup is waiting. "Stalled in `lobby` for
 * 92s" is a host who has not clicked admit. "Stalled in `name-entry`" is a
 * vendor who renamed a field. Those are different problems with different
 * owners, and the difference has to survive into the error message.
 *
 * So every step declares which state it is entering before it does anything,
 * the machine records when that happened, and any failure can name the state it
 * was in. The states are the ones the brief fixes:
 *
 *     navigating → name-entry → lobby → admitted → in-call → left
 *
 * plus `idle` before the first step and `failed` as the terminal error state.
 * Platforms skip states — Jitsi with a pre-filled name goes straight from
 * `navigating` to `admitted` — so forward skips are legal and backward moves
 * are not.
 * ===========================================================================
 */

import type { Clock } from '../../util/clock.js';
import { systemClock } from '../../util/clock.js';

export type JoinState =
  | 'idle'
  | 'navigating'
  | 'name-entry'
  | 'lobby'
  | 'admitted'
  | 'in-call'
  | 'left'
  | 'failed';

/** Ordered, so "forward only" is a comparison rather than a table of pairs. */
const PROGRESSION: readonly JoinState[] = [
  'idle',
  'navigating',
  'name-entry',
  'lobby',
  'admitted',
  'in-call',
];

/**
 * States reachable from anywhere.
 *
 * `left` from any state because teardown must always be recordable — including
 * after a failure, since the browser still has to be closed and the fact that
 * it was is worth having in the history.
 */
const TERMINAL: readonly JoinState[] = ['left', 'failed'];

export function isTerminal(state: JoinState): boolean {
  return TERMINAL.includes(state);
}

export interface JoinStateEntry {
  readonly state: JoinState;
  readonly at: Date;
  /** Short, non-content note: a step name, never anything a person said. */
  readonly note: string | null;
}

export class JoinStateError extends Error {
  override readonly name = 'JoinStateError';
  readonly from: JoinState;
  readonly to: JoinState;

  constructor(from: JoinState, to: JoinState) {
    super(
      `Illegal join transition ${from} → ${to}. ` +
        `The join sequence moves forward through ${PROGRESSION.join(' → ')} ` +
        `and may end in left or failed from any state.`,
    );
    this.from = from;
    this.to = to;
  }
}

export class JoinStateMachine {
  readonly #clock: Clock;
  readonly #history: JoinStateEntry[] = [];
  #state: JoinState = 'idle';
  #enteredAt: number;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
    this.#enteredAt = clock.now();
    this.#history.push({ state: 'idle', at: clock.date(), note: null });
  }

  get state(): JoinState {
    return this.#state;
  }

  get history(): readonly JoinStateEntry[] {
    return this.#history;
  }

  /** How long the machine has been sitting in its current state. */
  get elapsedMs(): number {
    return Math.max(0, this.#clock.now() - this.#enteredAt);
  }

  /** True once the meeting is genuinely joined and running. */
  get inCall(): boolean {
    return this.#state === 'in-call';
  }

  /**
   * Enter a state.
   *
   * Re-entering the current state is a no-op rather than an error: a driver
   * that polls the lobby should not have to track whether it already announced
   * it, and a history full of twenty `lobby` entries tells nobody anything.
   */
  to(next: JoinState, note: string | null = null): void {
    if (next === this.#state) return;
    if (!this.canGoTo(next)) throw new JoinStateError(this.#state, next);

    this.#state = next;
    this.#enteredAt = this.#clock.now();
    this.#history.push({ state: next, at: this.#clock.date(), note });
  }

  canGoTo(next: JoinState): boolean {
    if (isTerminal(this.#state)) {
      // A failure still has to be able to record its teardown.
      return this.#state === 'failed' && next === 'left';
    }
    if (isTerminal(next)) return true;

    const from = PROGRESSION.indexOf(this.#state);
    const to = PROGRESSION.indexOf(next);
    return from >= 0 && to > from;
  }

  /**
   * The sentence a stall should produce.
   *
   * Deliberately phrased around *where*, because that is the part that tells
   * whoever reads it whose problem this is.
   */
  describeStall(): string {
    const seconds = Math.round(this.elapsedMs / 1000);
    switch (this.#state) {
      case 'navigating':
        return `stalled in "navigating" for ${seconds}s — the meeting page never finished loading`;
      case 'name-entry':
        return `stalled in "name-entry" for ${seconds}s — the guest-name field never appeared or never accepted input`;
      case 'lobby':
        return `stalled in "lobby" for ${seconds}s — waiting to be admitted; nobody in the meeting has let the guest in`;
      case 'admitted':
        return `stalled in "admitted" for ${seconds}s — admitted, but the in-call UI never rendered`;
      case 'in-call':
        return `in call for ${seconds}s`;
      case 'idle':
        return `stalled in "idle" for ${seconds}s — join() was never started`;
      case 'left':
        return `left the meeting ${seconds}s ago`;
      case 'failed':
        return `failed ${seconds}s ago`;
    }
  }

  /** A compact, content-free trail for a log line. */
  trail(): string {
    return this.#history.map((entry) => entry.state).join('>');
  }
}

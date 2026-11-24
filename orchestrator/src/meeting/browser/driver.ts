/**
 * The platform driver contract, and the failure mode it is built around.
 *
 * ===========================================================================
 * THE ONE THING THAT MATTERS HERE
 * ===========================================================================
 * These drivers are built on other companies' DOM. Google, Zoom and Microsoft
 * ship UI changes on their own schedule and owe us nothing; every selector in
 * this package has a finite lifetime. That is not a reason not to build it —
 * it is the reason to decide *now* how it breaks.
 *
 * So:
 *
 *   - **Every selector lives in one table per driver.** Never inline, never
 *     interpolated into a step. When Meet renames a class, the fix is one line
 *     in one object, found by reading the failure message.
 *   - **Every selector is used through a `JoinContext` helper**, so a failure
 *     is a `SelectorFailureError` naming the driver, the step, the selector's
 *     stable name, its current value and the join state — not a Playwright
 *     timeout naming a CSS string.
 *   - **A failing join captures a screenshot and the page HTML** to a debug
 *     directory on disk, so the next person can see what the page had actually
 *     become. Never to Mongo, never into a log line.
 *
 * A driver is therefore small on purpose: URLs, selectors, and the order to
 * click things in. Everything else — audio, video, speaker attribution,
 * lifecycle, consent — is the adapter's, shared across all platforms. Adding a
 * platform must mean writing one of these, not touching the adapter.
 * ===========================================================================
 */

import type { MeetingAdapterCapabilities, MeetingPlatform } from '../adapter.js';
import type { BrowserPage } from './page.js';
import type { Refusal } from './refusal.js';
import type { JoinState, JoinStateMachine } from './state.js';

// ---------------------------------------------------------------------------
// Selector tables
// ---------------------------------------------------------------------------

/**
 * One selector, with the two things a failure message needs: what it was for,
 * and how load-bearing it is.
 */
export interface SelectorEntry {
  /** Playwright selector. CSS, `text=`, `role=` — whatever survives longest. */
  readonly selector: string;
  /** Why this element is wanted, in a sentence a stranger can act on. */
  readonly what: string;
  /**
   * False when the join can continue without it. A "dismiss cookie banner"
   * button is optional; a "join" button is not, and the difference decides
   * whether a miss aborts or is shrugged off.
   */
  readonly required: boolean;
}

export type SelectorTable = Readonly<Record<string, SelectorEntry>>;

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * Why a selector step failed — and it is not one thing.
 *
 * These two need opposite fixes and used to produce the same message, which
 * sent people to edit a selector table that was already correct:
 *
 *   `not-found`        Nothing in the DOM matched. The vendor moved or renamed
 *                      something. Fix: the driver's SELECTORS table.
 *   `not-interactable` The element is *there* and would not take the click. An
 *                      auto-hiding toolbar, an overlay, something still
 *                      animating in. Fix: `revealToolbar`, or waiting — not the
 *                      selector, which is fine.
 *
 * Learned against a live meeting: Jitsi's toolbar hides itself after a few
 * seconds without pointer movement, so `chatToggle` resolved perfectly and
 * timed out on click, and the message blamed a UI change that had not happened.
 */
export type SelectorResolution = 'not-found' | 'not-interactable' | 'unknown';

/**
 * A selector did not match, or matched something that would not cooperate.
 *
 * Carries every field needed to fix it without reproducing it: which driver,
 * which step, which named selector, what that selector currently is, where the
 * state machine had got to, whether the element was even there, and where the
 * page evidence was written.
 */
export class SelectorFailureError extends Error {
  override readonly name = 'SelectorFailureError';
  readonly driverId: string;
  readonly step: string;
  readonly selectorName: string;
  readonly selector: string;
  readonly what: string;
  readonly joinState: JoinState;
  readonly resolution: SelectorResolution;
  /** How many elements the selector actually matched. -1 when unprobeable. */
  readonly matchCount: number;
  readonly debugPaths: readonly string[];
  /** The Playwright error underneath, kept so the message can be rebuilt. */
  readonly rootCause: unknown;
  /**
   * The refusal the page displayed, if any.
   *
   * Exposed as a field, not just prose in the message: callers need to tell "we
   * were refused" from "our selector rotted" without parsing English, and a
   * retry against a vendor that refused automation is pointless.
   */
  readonly refusal: Refusal | null;

  constructor(input: {
    driverId: string;
    step: string;
    selectorName: string;
    selector: string;
    what: string;
    joinState: JoinState;
    stall: string;
    resolution: SelectorResolution;
    matchCount: number;
    debugPaths: readonly string[];
    cause: unknown;
    /** What the page itself said, if it said anything recognised. */
    refusal: Refusal | null;
  }) {
    const evidence =
      input.debugPaths.length === 0
        ? 'No page evidence was captured (the page was already gone).'
        : `Page evidence written to:\n${input.debugPaths.map((p) => `  ${p}`).join('\n')}`;

    // What the page SAYS beats what we would otherwise guess. A vendor that has
    // printed "Automated bots aren't allowed to join this meeting" has told us
    // the cause, and blaming the selector table over the top of that sends the
    // next person to edit code that is not broken.
    const refusalNote =
      input.refusal === null
        ? null
        : `THE PAGE REFUSED THE JOIN — it displayed:\n` +
          `    "${input.refusal.quote}"\n` +
          `  ${input.refusal.meaning}`;

    const diagnosis =
      refusalNote !== null
        ? refusalNote
        : input.resolution === 'not-interactable'
        ? `FOUND BUT NOT INTERACTABLE — the selector matched ${input.matchCount} element(s) and the ` +
          `interaction still would not land. This is NOT a selector change; the table is fine. The ` +
          `usual causes are an auto-hiding toolbar (call revealToolbar() before touching it), an ` +
          `overlay or dialog on top, or an element still animating in.`
        : input.resolution === 'not-found'
          ? `NOT FOUND — nothing in the DOM matched. This is almost certainly a vendor UI change. ` +
            `Update the "${input.selectorName}" entry in the ${input.driverId} driver's SELECTORS ` +
            `table; every selector for this platform is in that one object.`
          : `The page could not be probed after the failure, so whether the element was present is ` +
            `unknown. Read the captured HTML below before editing the SELECTORS table.`;

    super(
      `[${input.driverId}] step "${input.step}" failed on selector ` +
        `"${input.selectorName}" (${input.what}).\n` +
        `  selector : ${input.selector}\n` +
        `  matched  : ${input.matchCount < 0 ? 'unprobeable' : String(input.matchCount)}\n` +
        `  state    : ${input.joinState} — ${input.stall}\n` +
        `  cause    : ${input.cause instanceof Error ? input.cause.message.split('\n')[0] : String(input.cause)}\n\n` +
        `${diagnosis}\n${evidence}`,
    );
    this.driverId = input.driverId;
    this.step = input.step;
    this.selectorName = input.selectorName;
    this.selector = input.selector;
    this.what = input.what;
    this.joinState = input.joinState;
    this.resolution = input.resolution;
    this.matchCount = input.matchCount;
    this.debugPaths = input.debugPaths;
    this.rootCause = input.cause;
    this.refusal = input.refusal;
  }
}

/** A join that never failed on a selector but never got where it was going. */
export class JoinStalledError extends Error {
  override readonly name = 'JoinStalledError';
  readonly joinState: JoinState;
  readonly debugPaths: readonly string[];

  constructor(input: {
    driverId: string;
    joinState: JoinState;
    stall: string;
    debugPaths: readonly string[];
    guidance: string;
  }) {
    super(
      `[${input.driverId}] join did not complete: ${input.stall}.\n${input.guidance}` +
        (input.debugPaths.length === 0
          ? ''
          : `\nPage evidence written to:\n${input.debugPaths.map((p) => `  ${p}`).join('\n')}`),
    );
    this.joinState = input.joinState;
    this.debugPaths = input.debugPaths;
  }
}

// ---------------------------------------------------------------------------
// Context handed to a driver
// ---------------------------------------------------------------------------

export interface StepTimeouts {
  /** Page load. */
  readonly navigateMs: number;
  /** A single click or fill. Short: a missing button should not cost a minute. */
  readonly interactionMs: number;
  /** How long to sit in the lobby before giving up on being admitted. */
  readonly lobbyMs: number;
  /** How long to wait for the in-call UI once admitted. */
  readonly inCallMs: number;
  /** Probe for an optional element. Very short — absence is the common case. */
  readonly probeMs: number;
}

/**
 * Everything a driver is allowed to touch.
 *
 * Note what is absent: no adapter, no audio, no roster. A driver cannot decide
 * who spoke, cannot emit an utterance and cannot end a meeting. It navigates,
 * it clicks, it reads names. That containment is what keeps four drivers from
 * becoming four half-adapters.
 */
export interface PageContext {
  readonly page: BrowserPage;
  readonly timeouts: StepTimeouts;
  readonly botDisplayName: string;
  /** Which driver this is, so shared helpers can name it in a failure. */
  readonly driverId: BrowserDriverId;
  /** The browser viewport, so `revealToolbar` knows where the video area is. */
  readonly viewport: { readonly width: number; readonly height: number };

  /** Click a named selector. Throws `SelectorFailureError` naming `step`. */
  click(step: string, selectorName: string): Promise<void>;
  /** Fill a named selector. `value` is a display name, never meeting content. */
  fill(step: string, selectorName: string, value: string): Promise<void>;
  /**
   * Commit a field with Enter.
   *
   * Separate from `fill` because several chat boxes have no send button and
   * because a driver must never have to reach past the table for a selector to
   * press a key into.
   */
  submit(step: string, selectorName: string): Promise<void>;
  /** Wait for a named selector to reach `state`. */
  waitFor(step: string, selectorName: string, state: 'visible' | 'hidden' | 'attached', timeoutMs: number): Promise<void>;
  /** True when the named selector currently matches something visible. */
  present(selectorName: string, timeoutMs: number): Promise<boolean>;
  /** Click it if it is there; say nothing if it is not. For banners and prompts. */
  clickIfPresent(selectorName: string, timeoutMs: number): Promise<boolean>;
  /** Text of every match of a named selector. Empty when it matches nothing. */
  textsOf(selectorName: string): Promise<readonly string[]>;
  /** An attribute of the first match, or null. */
  attributeOf(selectorName: string, attribute: string): Promise<string | null>;
  /** The first of several selectors to appear, or null if none did. */
  race(selectorNames: readonly string[], timeoutMs: number): Promise<string | null>;
  /**
   * Write a screenshot and the DOM right now, and return the paths.
   *
   * Exposed to shared join code because *when* evidence is captured decides
   * whether it is evidence at all. A Google Meet refusal was investigated three
   * times from a screenshot taken at the 60s selector timeout — by which point
   * Meet had redirected to its marketing site, so every capture showed the
   * aftermath and none showed the refusal. Capturing at the moment something
   * goes wrong is the difference between a diagnosis and a guess.
   */
  capture(label: string): Promise<readonly string[]>;
}

/** `PageContext` plus the state machine, handed to `join` only. */
export interface JoinContext extends PageContext {
  readonly state: JoinStateMachine;
  /** The URL the driver asked for, already normalised by `joinUrl`. */
  readonly url: string;
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export type BrowserDriverId = 'jitsi' | 'meet' | 'zoom' | 'teams';

export interface PlatformDriver {
  readonly id: BrowserDriverId;
  /** What the adapter reports as `MeetingAdapter.platform`. */
  readonly platform: MeetingPlatform;
  /** Human-readable, for the README and error messages. */
  readonly label: string;
  readonly capabilities: MeetingAdapterCapabilities;
  /** Every selector this driver uses. Nothing is inlined in a step. */
  readonly selectors: SelectorTable;
  /**
   * Whether this platform's terms restrict automated access.
   *
   * Surfaced rather than buried: the adapter logs it once at construction so a
   * deployment cannot claim it did not know. Jitsi is the honest target and is
   * the only driver where this is false.
   */
  readonly termsRisk: string | null;

  /** Does this driver own the URL? Used to pick a driver from a join link. */
  matches(url: string): boolean;

  /**
   * Rewrite the link into the one to actually open.
   *
   * Zoom's shared links point at the native client; the web client lives at a
   * different path. Meet and Jitsi take a display-name query parameter that
   * saves a whole DOM step.
   */
  joinUrl(rawUrl: string, botDisplayName: string): string;

  /** Navigate and get into the call, moving the state machine as it goes. */
  join(ctx: JoinContext): Promise<void>;

  /**
   * Who is speaking right now, by display name, or null.
   *
   * Null is a real answer, not a failure. The permission gate treats an
   * unidentified speaker as "not a known employee", which is the safe
   * direction, so a driver must never guess.
   */
  activeSpeaker(ctx: PageContext): Promise<string | null>;

  /** Display names currently in the participant list. */
  participantNames(ctx: PageContext): Promise<readonly string[]>;

  /** True when the DOM says the host removed us. */
  wasRemoved(ctx: PageContext): Promise<boolean>;

  /** True when the DOM says the meeting itself has ended. */
  hasEnded(ctx: PageContext): Promise<boolean>;

  postChat(ctx: PageContext, message: string): Promise<void>;
  setMuted(ctx: PageContext, muted: boolean): Promise<void>;
  setHandRaised(ctx: PageContext, raised: boolean): Promise<void>;
  /** Click the platform's share-screen control. Chrome auto-picks the window. */
  startScreenshare(ctx: PageContext): Promise<void>;
  stopScreenshare(ctx: PageContext): Promise<void>;
  leave(ctx: PageContext): Promise<void>;
}

/** Look a selector up, failing loudly when a driver names one that is not in its table. */
export function requireSelector(
  driverId: string,
  selectors: SelectorTable,
  name: string,
): SelectorEntry {
  const entry = selectors[name];
  if (entry === undefined) {
    throw new Error(
      `The ${driverId} driver asked for selector "${name}", which is not in its SELECTORS table. ` +
        `Every selector must be declared there — that is the whole point of the table.`,
    );
  }
  return entry;
}

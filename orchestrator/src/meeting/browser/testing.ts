/**
 * Test doubles for the browser adapter.
 *
 * ===========================================================================
 * WHY THESE ARE A REAL MODULE AND NOT BURIED IN A TEST FILE
 * ===========================================================================
 * The same reasoning as `ManualClock` in `util/clock.ts`, which this package
 * already relies on: a double that several test files need has to live
 * somewhere importable, and hiding it inside one of them means the others
 * either duplicate it or import a file whose `describe` blocks would run twice.
 *
 * The point of `FakeMeetingPage` is that the join sequences, the selector
 * failure reporting and the speaker attribution are testable with **no
 * browser, no display server, no network and no meeting**. CI must be able to
 * catch a broken join sequence; it must not be able to join a real call.
 *
 * The fake is driven by a driver's own `SelectorTable`, so a test says
 * `show('joinButton')` rather than repeating a CSS string. That means a test
 * cannot accidentally pass by asserting against a selector the driver no longer
 * uses: naming a selector that is not in the table throws.
 */

import { writeFileSync } from 'node:fs';

import { requireSelector, type SelectorTable } from './driver.js';
import type {
  BrowserLauncher,
  BrowserLocator,
  BrowserPage,
  BrowserSession,
  LaunchOptions,
  WaitState,
} from './page.js';
import type { HostProbe } from './xvfb.js';

/** A Linux host with everything installed. What the preflight wants to see. */
export function readyLinuxProbe(): HostProbe {
  return {
    platform: 'linux',
    which: (command) => `/usr/bin/${command}`,
    fileExists: (path) => path === '/usr/bin/google-chrome-stable' || path.startsWith('/dev/video'),
    canResolveModule: () => true,
  };
}

/** A Linux host with nothing installed. */
export function bareLinuxProbe(): HostProbe {
  return {
    platform: 'linux',
    which: () => null,
    fileExists: () => false,
    canResolveModule: () => false,
  };
}

export interface FakeElementState {
  visible: boolean;
  texts: readonly string[];
  attributes: Readonly<Record<string, string>>;
  /**
   * Present in the DOM but refusing the interaction.
   *
   * The auto-hiding-toolbar case, and the reason it has to be fakeable: it is
   * the failure mode that looks exactly like a vendor rename and is not one.
   * `revealToolbar` clears it, so a test can prove the wake-up actually works
   * rather than just that it was called.
   */
  hittable: boolean;
}

export interface RecordedClick {
  readonly name: string;
}

export interface RecordedFill {
  readonly name: string;
  readonly value: string;
}

/**
 * A page whose DOM is a table of named selectors.
 *
 * Everything a test wants to say — "the join button is there", "the lobby
 * screen appeared", "these five names are in the participant list" — is one
 * call, and everything the adapter did to it is recorded.
 */
export class FakeMeetingPage implements BrowserPage {
  readonly clicks: RecordedClick[] = [];
  readonly fills: RecordedFill[] = [];
  readonly typed: Array<{ selector: string; text: string }> = [];
  readonly navigations: string[] = [];
  readonly mouseMoves: Array<{ x: number; y: number }> = [];
  /** Names that were auto-hidden and became hittable after a pointer move. */
  readonly wokenByPointer: string[] = [];

  readonly #driverId: string;
  readonly #selectors: SelectorTable;
  /** selector string → the name it was declared under. */
  readonly #bySelector = new Map<string, string>();
  readonly #state = new Map<string, FakeElementState>();
  /** Names that a pointer move will make hittable. */
  readonly #autoHidden = new Set<string>();

  #url = 'about:blank';
  #closed = false;
  #html = '<!doctype html><html><body>fake</body></html>';

  constructor(driverId: string, selectors: SelectorTable) {
    this.#driverId = driverId;
    this.#selectors = selectors;
    for (const [name, entry] of Object.entries(selectors)) {
      this.#bySelector.set(entry.selector, name);
    }
  }

  // ---- test-facing controls ------------------------------------------------

  show(name: string, options: { texts?: readonly string[]; attributes?: Record<string, string> } = {}): this {
    requireSelector(this.#driverId, this.#selectors, name);
    this.#state.set(name, {
      visible: true,
      texts: options.texts ?? [],
      attributes: options.attributes ?? {},
      hittable: true,
    });
    return this;
  }

  /**
   * Present in the DOM, matched by its selector, and refusing clicks — until
   * the pointer moves. This is Jitsi's auto-hiding toolbar, reproduced.
   */
  showButAutoHidden(name: string): this {
    requireSelector(this.#driverId, this.#selectors, name);
    this.#state.set(name, { visible: true, texts: [], attributes: {}, hittable: false });
    this.#autoHidden.add(name);
    return this;
  }

  /**
   * Present and permanently unclickable — a modal on top of it, say.
   *
   * Unlike `showButAutoHidden`, moving the pointer does not help. This is the
   * case that must still produce "found but not interactable" rather than
   * sending someone to edit a selector table that is perfectly correct.
   */
  showButBlocked(name: string): this {
    requireSelector(this.#driverId, this.#selectors, name);
    this.#state.set(name, { visible: true, texts: [], attributes: {}, hittable: false });
    this.#autoHidden.delete(name);
    return this;
  }

  hide(name: string): this {
    requireSelector(this.#driverId, this.#selectors, name);
    this.#state.delete(name);
    return this;
  }

  setTexts(name: string, texts: readonly string[]): this {
    const current = this.#state.get(name);
    this.#state.set(name, {
      visible: current?.visible ?? true,
      texts,
      attributes: current?.attributes ?? {},
      hittable: current?.hittable ?? true,
    });
    return this;
  }

  setHtml(html: string): this {
    this.#html = html;
    return this;
  }

  clickedNames(): readonly string[] {
    return this.clicks.map((click) => click.name);
  }

  // ---- BrowserPage ---------------------------------------------------------

  async goto(url: string, _options: { timeout: number; waitUntil: 'domcontentloaded' | 'load' }): Promise<void> {
    this.navigations.push(url);
    this.#url = url;
  }

  url(): string {
    return this.#url;
  }

  async title(): Promise<string> {
    return 'fake page';
  }

  locator(selector: string): BrowserLocator {
    const name = this.#bySelector.get(selector) ?? null;
    return new FakeLocator(this, name);
  }

  async content(): Promise<string> {
    return this.#html;
  }

  async screenshot(options: { path: string | null; fullPage: boolean }): Promise<Buffer> {
    // A one-pixel PNG, so a debug capture that claims to have written a file
    // has actually written one.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    if (options.path !== null) writeFileSync(options.path, png);
    return png;
  }

  async type(selector: string, text: string, _options: { timeout: number }): Promise<void> {
    const name = this.#bySelector.get(selector) ?? null;
    const state = name === null ? undefined : this.#state.get(name);
    if (state === undefined || !state.visible) {
      throw new Error(`fake: nothing matches ${selector}`);
    }
    if (!state.hittable) throw new Error(`fake: ${selector} is present but not interactable`);
    this.typed.push({ selector, text });
  }

  async mouseMove(x: number, y: number): Promise<void> {
    this.mouseMoves.push({ x, y });
    // Pointer movement wakes an auto-hidden toolbar, exactly as the real thing
    // does. Without this the fake would only prove revealToolbar was *called*.
    for (const name of this.#autoHidden) {
      const state = this.#state.get(name);
      if (state === undefined || state.hittable) continue;
      this.#state.set(name, { ...state, hittable: true });
      this.wokenByPointer.push(name);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  isClosed(): boolean {
    return this.#closed;
  }

  // ---- internal ------------------------------------------------------------

  /** @internal */
  stateOf(name: string | null): FakeElementState | null {
    if (name === null) return null;
    return this.#state.get(name) ?? null;
  }

  /** @internal */
  record(kind: 'click' | 'fill', name: string, value: string): void {
    if (kind === 'click') this.clicks.push({ name });
    else this.fills.push({ name, value });
  }
}

class FakeLocator implements BrowserLocator {
  readonly #page: FakeMeetingPage;
  readonly #name: string | null;

  constructor(page: FakeMeetingPage, name: string | null) {
    this.#page = page;
    this.#name = name;
  }

  #require(action: string, needsHit: boolean): FakeElementState {
    const state = this.#page.stateOf(this.#name);
    if (state === null || !state.visible) {
      // The shape of a real Playwright timeout: the adapter turns this into a
      // SelectorFailureError, which is the behaviour under test.
      throw new Error(
        `fake: ${action} timed out; no element for "${this.#name ?? 'unregistered selector'}"`,
      );
    }
    if (needsHit && !state.hittable) {
      // What Playwright reports for an element covered, hidden or mid-animation:
      // a timeout on the *interaction*, not on the lookup. The distinction is
      // the whole point of `SelectorResolution`.
      throw new Error(
        `fake: ${action} timed out waiting for "${this.#name ?? '?'}" to be stable and visible`,
      );
    }
    return state;
  }

  async count(): Promise<number> {
    const state = this.#page.stateOf(this.#name);
    return state === null || !state.visible ? 0 : Math.max(1, state.texts.length);
  }

  first(): BrowserLocator {
    return this;
  }

  async click(_options: { timeout: number }): Promise<void> {
    this.#require('click', true);
    if (this.#name !== null) this.#page.record('click', this.#name, '');
  }

  async fill(value: string, _options: { timeout: number }): Promise<void> {
    this.#require('fill', true);
    if (this.#name !== null) this.#page.record('fill', this.#name, value);
  }

  async waitFor(options: { state: WaitState; timeout: number }): Promise<void> {
    const state = this.#page.stateOf(this.#name);
    const visible = state !== null && state.visible;
    const wanted = options.state === 'visible' || options.state === 'attached';
    // A hidden-but-present element is still `attached`, and Playwright's
    // `waitFor` does not care whether it can be clicked — only `click` does.
    if (wanted && !visible) this.#require('waitFor', false);
    if (!wanted && visible) throw new Error('fake: element is still there');
  }

  async textContent(_options: { timeout: number }): Promise<string | null> {
    const state = this.#page.stateOf(this.#name);
    return state?.texts[0] ?? null;
  }

  async allTextContents(): Promise<readonly string[]> {
    const state = this.#page.stateOf(this.#name);
    return state === null || !state.visible ? [] : state.texts;
  }

  async getAttribute(name: string, _options: { timeout: number }): Promise<string | null> {
    const state = this.#page.stateOf(this.#name);
    return state?.attributes[name] ?? null;
  }

  async isVisible(): Promise<boolean> {
    const state = this.#page.stateOf(this.#name);
    return state !== null && state.visible;
  }
}

/** One page, no windows, no browser. */
export class FakeBrowserSession implements BrowserSession {
  readonly page: BrowserPage;
  readonly extraPages: BrowserPage[] = [];
  closed = false;

  readonly #make: (url: string) => BrowserPage;

  constructor(page: BrowserPage, makeExtra: (url: string) => BrowserPage) {
    this.page = page;
    this.#make = makeExtra;
  }

  async newPage(url: string): Promise<BrowserPage> {
    const page = this.#make(url);
    this.extraPages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeBrowserLauncher implements BrowserLauncher {
  readonly launches: LaunchOptions[] = [];
  readonly session: FakeBrowserSession;

  constructor(page: BrowserPage, makeExtra: (url: string) => BrowserPage = () => page) {
    this.session = new FakeBrowserSession(page, makeExtra);
  }

  async launch(options: LaunchOptions): Promise<BrowserSession> {
    this.launches.push(options);
    return this.session;
  }

  /** Every Chrome flag the adapter asked for, flattened. */
  get args(): readonly string[] {
    return this.launches.flatMap((launch) => [...launch.args]);
  }
}

/**
 * The browser surface this package actually uses.
 *
 * ===========================================================================
 * WHY THIS EXISTS RATHER THAN `import type { Page } from 'playwright-core'`
 * ===========================================================================
 * Two reasons, and neither is abstraction for its own sake.
 *
 * 1. **Tests.** The join sequences, the selector-failure reporting and the
 *    speaker mapping are the parts most likely to break, and they must be
 *    testable without a browser, a display server, or a meeting. A fake that
 *    implements Playwright's real `Page` is not practical — it has hundreds of
 *    members. A fake that implements the twelve methods below is fifty lines.
 *
 * 2. **Playwright is optional at runtime.** The orchestrator has to load on the
 *    Windows dev machine, where the local simulated room is the test path and
 *    there is no Chrome, no Xvfb and no PulseAudio. Nothing in this module
 *    imports `playwright-core` at module scope; the real driver is loaded
 *    dynamically from `launch.ts` only when a browser is actually wanted.
 *
 * Everything here is deliberately narrow. Adding a method means deciding it is
 * worth faking, which is the right pressure — a driver that needs page-level
 * JavaScript evaluation to find a button is a driver whose selector table is
 * wrong.
 * ===========================================================================
 */

export type WaitState = 'attached' | 'detached' | 'visible' | 'hidden';

/**
 * One matched element (or set of them).
 *
 * Options are required rather than optional throughout: `exactOptionalPropertyTypes`
 * makes "omit or pass a value, never pass undefined" the rule, and a required
 * timeout also stops a driver silently inheriting Playwright's 30s default in a
 * step where 30s is far too long.
 */
export interface BrowserLocator {
  count(): Promise<number>;
  first(): BrowserLocator;
  click(options: { timeout: number }): Promise<void>;
  fill(value: string, options: { timeout: number }): Promise<void>;
  waitFor(options: { state: WaitState; timeout: number }): Promise<void>;
  textContent(options: { timeout: number }): Promise<string | null>;
  /** Text of every match, document order. Used for participant lists. */
  allTextContents(): Promise<readonly string[]>;
  /** An attribute of the first match. Used where a name lives in aria-label. */
  getAttribute(name: string, options: { timeout: number }): Promise<string | null>;
  isVisible(): Promise<boolean>;
}

export interface BrowserPage {
  goto(url: string, options: { timeout: number; waitUntil: 'domcontentloaded' | 'load' }): Promise<void>;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): BrowserLocator;
  /** Full serialised DOM. Written to the debug directory on a join failure only. */
  content(): Promise<string>;
  /**
   * A PNG. Written to `path` when one is given, and always returned — the
   * avatar pipeline needs the bytes and the debug capture needs the file.
   */
  screenshot(options: { path: string | null; fullPage: boolean }): Promise<Buffer>;
  /** Keyboard input for pages that reject `fill` on a contenteditable. */
  type(selector: string, text: string, options: { timeout: number }): Promise<void>;
  /**
   * Move the pointer.
   *
   * Not a convenience. Every meeting client hides its toolbar after a few
   * seconds without pointer movement, and a hidden toolbar's buttons are in the
   * DOM and not hittable — which reads as a broken selector and is not one.
   * Real mouse movement is the only thing that wakes them.
   */
  mouseMove(x: number, y: number): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
}

/** A browser with at least one page. Closing it closes everything under it. */
export interface BrowserSession {
  readonly page: BrowserPage;
  /** A second window, for the screenshare surface. */
  newPage(url: string): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** `:99` — the Xvfb display this browser renders into. Empty on a real desktop. */
  readonly display: string;
  /** Absolute path to the Chrome binary. Never Chromium if Chrome is present. */
  readonly executablePath: string;
  /** Extra `--flag=value` arguments. Audio, video and screenshare are all flags. */
  readonly args: readonly string[];
  /** Ignored by the fake; the real launcher passes it to Playwright. */
  readonly timeoutMs: number;
  /** Omit to use the browser's own — see defaultUserAgent() in launch.ts. */
  readonly userAgent: string | undefined;
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface BrowserLauncher {
  launch(options: LaunchOptions): Promise<BrowserSession>;
}

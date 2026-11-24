/**
 * Chrome, launched the way a meeting client expects to be talked to.
 *
 * ===========================================================================
 * THE FLAGS, AND WHY EACH ONE IS THERE
 * ===========================================================================
 * Every flag below buys something specific. There is no "known good list"
 * copied from a gist, because a flag nobody can justify is a flag nobody can
 * safely remove when it starts causing a problem.
 *
 *   --use-fake-ui-for-media-stream        Auto-grants the microphone and camera
 *                                         permission prompt. Nobody is sitting
 *                                         there to click it. Note this grants
 *                                         *permission*; it does not substitute
 *                                         the device — see audio.ts on why
 *                                         --use-fake-device-for-media-stream is
 *                                         deliberately absent.
 *   --use-file-for-fake-video-capture     Only in static-card video mode. Feeds
 *                                         a looping y4m as the camera.
 *   --auto-select-desktop-capture-source  Answers the screen-picker dialog by
 *                                         window title, so getDisplayMedia can
 *                                         be called without a human.
 *   --autoplay-policy                     Meeting audio is not user-initiated
 *                                         here; without this some clients never
 *                                         start playback.
 *   --disable-blink-features=Automation…  Removes the single loudest automation
 *                                         signal. Not a cloak, and this file
 *                                         does not pretend to be one.
 *   --disable-dev-shm-usage               /dev/shm is 64MB in most containers
 *                                         and Chrome crashes on it.
 *   --no-first-run/--no-default-browser…  A first-run dialog covering the join
 *                                         button is a very silly way to fail.
 *
 * ===========================================================================
 * WHY playwright-core AND NOT playwright
 * ===========================================================================
 * `playwright` downloads Chromium, Firefox and WebKit on install — hundreds of
 * megabytes we do not want, of a browser we do not want. This needs *Google
 * Chrome*, from Google's own apt repository, because Meet gates behaviour on
 * the branded build and its user agent. `playwright-core` is the same driver
 * with no browsers attached, and the provisioning script installs Chrome.
 *
 * It is still imported dynamically. The orchestrator has to load on the Windows
 * dev machine to run the simulated room, and a static import would make that a
 * module-resolution crash instead of a preflight message.
 * ===========================================================================
 */

import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';

import { log } from '../../util/log.js';
import type {
  BrowserLauncher,
  BrowserLocator,
  BrowserPage,
  BrowserSession,
  LaunchOptions,
  WaitState,
} from './page.js';

/**
 * The user agent to send, or `undefined` to use the browser's own.
 *
 * Undefined is the right default and the only safe one. We launch REAL headful
 * Google Chrome, so its native UA is accurate and current by construction —
 * there is no `HeadlessChrome` token to strip, because we never run headless.
 *
 * This previously returned a hard-coded `Chrome/131` string. The container ships
 * Chrome 150, so every request announced a browser 19 major versions out of
 * date, and Google Meet redirected the join URL to
 * workspace.google.com/products/meet — its "unsupported browser" page. Two hours
 * went into suspecting bot detection before the captured page's canonical URL
 * showed it was a browser-support redirect.
 *
 * Any hard-coded UA rots into that same failure. Override only to reproduce a
 * specific client, never as a matter of course.
 */
export function defaultUserAgent(): string | undefined {
  const configured = process.env['LILY_BROWSER_USER_AGENT'];
  return configured === undefined || configured === '' ? undefined : configured;
}

export interface ChromeArgOptions {
  readonly viewport: { readonly width: number; readonly height: number };
  /** Window title `--auto-select-desktop-capture-source` should match. */
  readonly screenshareWindowTitle: string | null;
  /** Extra flags from the video mode. */
  readonly videoArgs: readonly string[];
  /** True inside a container running as root, where the sandbox cannot start. */
  readonly noSandbox: boolean;
}

export function buildChromeArgs(options: ChromeArgOptions): readonly string[] {
  const args = [
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-infobars',
    `--window-size=${options.viewport.width},${options.viewport.height}`,
    ...options.videoArgs,
  ];

  if (options.screenshareWindowTitle !== null) {
    args.push(
      `--auto-select-desktop-capture-source=${options.screenshareWindowTitle}`,
      `--auto-select-tab-capture-source-by-title=${options.screenshareWindowTitle}`,
    );
  }
  if (options.noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');

  return args;
}

// ---------------------------------------------------------------------------
// Playwright adapters
// ---------------------------------------------------------------------------

class PlaywrightLocator implements BrowserLocator {
  readonly #locator: Locator;

  constructor(locator: Locator) {
    this.#locator = locator;
  }

  count(): Promise<number> {
    return this.#locator.count();
  }
  first(): BrowserLocator {
    return new PlaywrightLocator(this.#locator.first());
  }
  click(options: { timeout: number }): Promise<void> {
    return this.#locator.click({ timeout: options.timeout });
  }
  fill(value: string, options: { timeout: number }): Promise<void> {
    return this.#locator.fill(value, { timeout: options.timeout });
  }
  waitFor(options: { state: WaitState; timeout: number }): Promise<void> {
    return this.#locator.waitFor({ state: options.state, timeout: options.timeout });
  }
  textContent(options: { timeout: number }): Promise<string | null> {
    return this.#locator.textContent({ timeout: options.timeout });
  }
  async allTextContents(): Promise<readonly string[]> {
    return this.#locator.allTextContents();
  }
  getAttribute(name: string, options: { timeout: number }): Promise<string | null> {
    return this.#locator.getAttribute(name, { timeout: options.timeout });
  }
  isVisible(): Promise<boolean> {
    return this.#locator.isVisible();
  }
}

class PlaywrightPage implements BrowserPage {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  async goto(
    url: string,
    options: { timeout: number; waitUntil: 'domcontentloaded' | 'load' },
  ): Promise<void> {
    await this.#page.goto(url, { timeout: options.timeout, waitUntil: options.waitUntil });
  }
  url(): string {
    return this.#page.url();
  }
  title(): Promise<string> {
    return this.#page.title();
  }
  locator(selector: string): BrowserLocator {
    return new PlaywrightLocator(this.#page.locator(selector));
  }
  content(): Promise<string> {
    return this.#page.content();
  }
  async screenshot(options: { path: string | null; fullPage: boolean }): Promise<Buffer> {
    return options.path === null
      ? this.#page.screenshot({ fullPage: options.fullPage })
      : this.#page.screenshot({ path: options.path, fullPage: options.fullPage });
  }
  async mouseMove(x: number, y: number): Promise<void> {
    // `steps` matters: a single jump can be delivered as one event with no
    // intermediate movement, and some toolbars only reset their hide timer on a
    // sequence. Cheap insurance.
    await this.#page.mouse.move(x, y, { steps: 4 });
  }

  async type(selector: string, text: string, options: { timeout: number }): Promise<void> {
    // `pressSequentially` rather than `fill`: some join forms are React-managed
    // and only commit on real key events.
    await this.#page
      .locator(selector)
      .first()
      .pressSequentially(text, { timeout: options.timeout, delay: 25 });
  }
  close(): Promise<void> {
    return this.#page.close();
  }
  isClosed(): boolean {
    return this.#page.isClosed();
  }
}

class PlaywrightSession implements BrowserSession {
  readonly page: BrowserPage;
  readonly #browser: Browser;
  readonly #context: BrowserContext;
  readonly #timeoutMs: number;

  constructor(browser: Browser, context: BrowserContext, page: Page, timeoutMs: number) {
    this.#browser = browser;
    this.#context = context;
    this.#timeoutMs = timeoutMs;
    this.page = new PlaywrightPage(page);
  }

  async newPage(url: string): Promise<BrowserPage> {
    const page = await this.#context.newPage();
    await page.goto(url, { timeout: this.#timeoutMs, waitUntil: 'domcontentloaded' });
    return new PlaywrightPage(page);
  }

  async close(): Promise<void> {
    await this.#context.close().catch(() => undefined);
    await this.#browser.close().catch(() => undefined);
  }
}

/** Only string values; Playwright's `env` will not take `string | undefined`. */
function stringEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return { ...out, ...extra };
}

export class PlaywrightBrowserLauncher implements BrowserLauncher {
  async launch(options: LaunchOptions): Promise<BrowserSession> {
    // Dynamic: see the header. A static import makes a Windows dev machine
    // fail at import time rather than at preflight.
    const { chromium } = await import('playwright-core');

    const browser = await chromium.launch({
      executablePath: options.executablePath,
      // Never headless. See xvfb.ts.
      headless: false,
      args: [...options.args],
      timeout: options.timeoutMs,
      env: stringEnv(options.display === '' ? {} : { DISPLAY: options.display }),
    });

    const context = await browser.newContext({
      // Omitted rather than passed as undefined: Playwright treats an explicit
      // undefined as "override with nothing" in some versions, and we want the
      // browser's genuine UA untouched.
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
      viewport: { width: options.viewport.width, height: options.viewport.height },
      permissions: ['microphone', 'camera'],
    });
    const page = await context.newPage();

    log.info('browser.launched', {
      display: options.display,
      executable: options.executablePath,
      argCount: options.args.length,
    });

    return new PlaywrightSession(browser, context, page, options.timeoutMs);
  }
}

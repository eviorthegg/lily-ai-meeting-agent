/**
 * The display server, and the host preflight that decides whether there is one.
 *
 * ===========================================================================
 * WHY HEADFUL CHROME INSIDE XVFB, NOT `--headless`
 * ===========================================================================
 * Headless Chrome is detectable and is detected. Google Meet in particular
 * gates functionality on signals that headless fails, and the failure is not a
 * clean refusal — it is a page that half-works, a join that silently never
 * completes, or a call with no media. Debugging that is a week nobody has.
 *
 * A real headful Chrome rendering into a virtual framebuffer is the same
 * browser a human runs, minus a monitor. `navigator.webdriver` still says what
 * it says and we do not pretend otherwise; what this avoids is the far larger
 * and far more brittle class of headless-specific breakage.
 *
 * Two more choices follow from the same reasoning:
 *
 *   - **Real Google Chrome over bundled Chromium.** Meet gates some codecs and
 *     features on the branded build and its user agent. `playwright-core` is
 *     the dependency precisely because it downloads no browsers: the browser
 *     here is Google's own package, installed by the provisioning script.
 *   - **A screen size a human would have.** 1280x720 rather than something
 *     that reads as a bot at a glance.
 *
 * ===========================================================================
 * NONE OF THIS RUNS ON WINDOWS
 * ===========================================================================
 * Xvfb, PulseAudio and v4l2loopback are Linux. On the Windows dev machine the
 * preflight fails at *construction* with that stated plainly and points at the
 * simulated local room, which is the supported dev path. It does not crash
 * mid-join, and it does not pretend.
 * ===========================================================================
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { AdapterPreflight, MeetingPlatform } from '../adapter.js';
import { errorField, log } from '../../util/log.js';

// ---------------------------------------------------------------------------
// Host probing
// ---------------------------------------------------------------------------

/**
 * Everything the preflight asks about the machine.
 *
 * Injected so the preflight itself is testable from any OS: the whole point of
 * these checks is what they say on a host that is missing things, and that must
 * be assertable without arranging a host that is missing things.
 */
export interface HostProbe {
  readonly platform: NodeJS.Platform;
  /** Absolute path to an executable on PATH, or null. */
  which(command: string): string | null;
  fileExists(path: string): boolean;
  /** True when a module specifier resolves from this process. */
  canResolveModule(specifier: string): boolean;
}

function whichOnPath(command: string): string | null {
  const path = process.env['PATH'];
  if (path === undefined || path === '') return null;
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export const systemProbe: HostProbe = {
  platform: process.platform,
  which: whichOnPath,
  fileExists: (path) => existsSync(path),
  canResolveModule: (specifier) => {
    try {
      import.meta.resolve(specifier);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Where Google Chrome lives, in the order we would rather have it.
 *
 * Chromium is last and deliberate: it works for Jitsi and generally works for
 * Zoom and Teams, and it is the build most likely to be treated differently by
 * Meet. The preflight reports which one was found so a Meet failure has an
 * obvious first thing to check.
 */
const CHROME_CANDIDATES: readonly string[] = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

export interface HostRequirements {
  readonly missing: readonly string[];
  readonly blockers: readonly string[];
  /** Absolute path to the browser found, or null. */
  readonly chromePath: string | null;
  /** True when the browser found is Google's branded build. */
  readonly isBrandedChrome: boolean;
  /** Present but optional: without it the avatar video is a static card. */
  readonly hasFfmpeg: boolean;
  readonly hasV4l2Loopback: boolean;
}

export function findChrome(probe: HostProbe = systemProbe): string | null {
  const configured = process.env['LILY_CHROME_PATH'];
  if (configured !== undefined && configured !== '' && probe.fileExists(configured)) {
    return configured;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (probe.fileExists(candidate)) return candidate;
  }
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium']) {
    const found = probe.which(name);
    if (found !== null) return found;
  }
  return null;
}

/**
 * What this host is missing.
 *
 * `missing` is anything an operator can install today. `blockers` is anything
 * they cannot — and on Windows, the operating system is a blocker.
 */
export function inspectHost(probe: HostProbe = systemProbe): HostRequirements {
  const missing: string[] = [];
  const blockers: string[] = [];

  if (probe.platform !== 'linux') {
    blockers.push(
      `The browser meeting adapter runs on Linux only; this host is "${probe.platform}". ` +
        'It needs Xvfb, PulseAudio and (for a live avatar) v4l2loopback, none of which exist ' +
        'on Windows or macOS in the form this uses. On the dev machine, run the simulated ' +
        'local room instead: LILY_MEETING_PLATFORM=local.',
    );
  }

  if (!probe.canResolveModule('playwright-core')) {
    missing.push(
      'playwright-core — the browser driver. `npm install` at the repo root. It deliberately ' +
        'downloads no browsers; Google Chrome comes from the provisioning script.',
    );
  }

  const chromePath = findChrome(probe);
  if (chromePath === null) {
    missing.push(
      'Google Chrome — no browser at any of ' +
        `${CHROME_CANDIDATES.join(', ')} and none on PATH. Install google-chrome-stable ` +
        '(orchestrator/scripts/provision-browser-host.sh does it), or set LILY_CHROME_PATH.',
    );
  }

  if (probe.which('Xvfb') === null) {
    missing.push('Xvfb — the virtual framebuffer Chrome renders into. Package: xvfb.');
  }
  if (probe.which('pactl') === null) {
    missing.push('pactl — PulseAudio control. Package: pulseaudio-utils.');
  }
  if (probe.which('parec') === null) {
    missing.push(
      'parec — captures meeting audio from the null sink monitor. Package: pulseaudio-utils.',
    );
  }
  if (probe.which('pacat') === null) {
    missing.push(
      'pacat — plays Lily\'s speech into the virtual microphone. Package: pulseaudio-utils.',
    );
  }

  const hasFfmpeg = probe.which('ffmpeg') !== null;
  const hasV4l2Loopback = probe.fileExists('/dev/video0') || probe.fileExists('/dev/video10');

  return {
    missing,
    blockers,
    chromePath,
    isBrandedChrome: chromePath !== null && chromePath.includes('chrome') && !chromePath.includes('chromium'),
    hasFfmpeg,
    hasV4l2Loopback,
  };
}

export function browserPreflight(
  platform: MeetingPlatform,
  probe: HostProbe = systemProbe,
): AdapterPreflight {
  const host = inspectHost(probe);
  return {
    platform,
    ready: host.missing.length === 0 && host.blockers.length === 0,
    missing: host.missing,
    blockers: host.blockers,
  };
}

// ---------------------------------------------------------------------------
// Xvfb
// ---------------------------------------------------------------------------

export interface XvfbOptions {
  /** Display number. One meeting per process, so a per-process number is fine. */
  readonly display: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  /** How long to wait for the X socket to appear before giving up. */
  readonly startupTimeoutMs: number;
}

export const DEFAULT_XVFB: XvfbOptions = {
  // Derived from the pid at construction so two orchestrators on one host do
  // not fight over :99. Overridden below.
  display: 99,
  width: 1280,
  height: 720,
  depth: 24,
  startupTimeoutMs: 10_000,
};

export function displayNumberForProcess(pid: number = process.pid): number {
  const configured = process.env['LILY_XVFB_DISPLAY'];
  if (configured !== undefined && configured !== '') {
    const parsed = Number(configured.replace(/^:/, ''));
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  // 100..899. Away from :0 (a real desktop) and from :99 (everyone's default).
  return 100 + (pid % 800);
}

/**
 * A running Xvfb.
 *
 * Started before Chrome and stopped after it. If it dies mid-meeting Chrome
 * dies with it, which surfaces as the meeting ending rather than as a bot
 * sitting silently in a call — the right failure of the two.
 */
export class XvfbDisplay {
  readonly #options: XvfbOptions;
  #process: ChildProcess | null = null;
  #stopped = false;

  constructor(options: Partial<XvfbOptions> = {}) {
    this.#options = { ...DEFAULT_XVFB, display: displayNumberForProcess(), ...options };
  }

  /** `:123`, the value for the DISPLAY environment variable. */
  get display(): string {
    return `:${this.#options.display}`;
  }

  get running(): boolean {
    return this.#process !== null && this.#process.exitCode === null && !this.#stopped;
  }

  async start(): Promise<void> {
    if (this.#process !== null) return;

    const { display, width, height, depth } = this.#options;
    const child = spawn(
      'Xvfb',
      [
        `:${display}`,
        '-screen',
        '0',
        `${width}x${height}x${depth}`,
        // No TCP listener: this framebuffer is for one local Chrome and nothing
        // else should be able to reach it.
        '-nolisten',
        'tcp',
        '-noreset',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    child.on('error', (cause) => {
      log.error('xvfb.spawn_failed', { display: this.display, error: errorField(cause) });
    });
    child.stderr?.on('data', () => {
      // Xvfb is noisy about extensions it did not load. Counted, not echoed.
    });

    this.#process = child;
    await this.#waitForSocket();
    log.info('xvfb.started', { display: this.display, width, height });
  }

  async #waitForSocket(): Promise<void> {
    const socket = `/tmp/.X11-unix/X${this.#options.display}`;
    const deadline = Date.now() + this.#options.startupTimeoutMs;

    for (;;) {
      if (existsSync(socket)) return;
      if (this.#process?.exitCode !== null && this.#process?.exitCode !== undefined) {
        throw new Error(
          `Xvfb exited with code ${this.#process.exitCode} before ${socket} appeared. ` +
            'Is the xvfb package installed, and is another server already on this display?',
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Xvfb did not create ${socket} within ${this.#options.startupTimeoutMs}ms. ` +
            'The display server never came up, so there is nothing for Chrome to render into.',
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const child = this.#process;
    this.#process = null;
    if (child === null) return;

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    log.info('xvfb.stopped', { display: this.display });
  }
}

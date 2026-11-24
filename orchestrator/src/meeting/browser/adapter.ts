/**
 * One adapter, every platform, through the web client.
 *
 * ===========================================================================
 * THE DECISION THIS IMPLEMENTS
 * ===========================================================================
 * The vendor-SDK route is abandoned, and not because it was hard. Zoom needs a
 * manual Marketplace review plus a native C++ Linux SDK that is not on npm.
 * Teams needs `Microsoft.Skype.Bots.Media`, which is Windows-only .NET with no
 * Node binding — an architecture port, not a missing key. Google Meet has no
 * bot-participant API at all and is not going to grow one on our schedule.
 *
 * So Lily joins the way a person joins: a real browser, the web client, as a
 * guest, with a name that says what she is. One adapter, near-universal
 * coverage, and — the part that matters operationally — one thing to fix when
 * something breaks instead of three vendor integrations in three languages.
 *
 * ===========================================================================
 * WHAT THIS COSTS, STATED PLAINLY
 * ===========================================================================
 * Google's and Zoom's terms restrict automated access to their services outside
 * published interfaces. Joining their web clients with a driven browser is
 * outside those interfaces. That risk has been weighed and accepted at the
 * product level; it is recorded in the README rather than buried, and the
 * `termsRisk` field on each driver carries it in code so no deployment can
 * claim it did not know.
 *
 * **Jitsi is the conflict-free target.** It is open source, guests are
 * explicitly allowed, and there is no terms conflict — so it is the honest
 * development and CI platform, and the driver that gets built and exercised
 * first. The others are the same pattern with different selectors.
 *
 * ===========================================================================
 * CONSENT IS BUILT IN, NOT CONFIGURED IN
 * ===========================================================================
 *   - The participant name is `config.meeting.botDisplayName`, which must read
 *     unmistakably as an AI. It is in the participant list from the moment she
 *     joins.
 *   - She announces herself in chat immediately on joining, in addition to
 *     whatever the session says out loud. Chat survives a muted microphone and
 *     a person who joined thirty seconds late.
 *   - **She stays kickable.** Removal by the host is polled for and treated as
 *     a normal `leave` path with reason `kicked`. There is no rejoin, ever —
 *     `#removed` latches and `join()` refuses afterwards. A bot that comes back
 *     after being removed is not a participant, it is an intruder.
 *
 * ===========================================================================
 * WHAT IS THE DRIVER'S AND WHAT IS NOT
 * ===========================================================================
 * Everything in this file is shared: the browser, the display server, the audio
 * plant, the camera, the screenshare surface, speaker attribution, the join
 * state machine, debug capture, and the whole lifecycle. A `PlatformDriver`
 * holds URLs, a selector table and a click order — nothing else. Adding a
 * platform is one small file, and that is the property this design exists to
 * have.
 * ===========================================================================
 */

import type { LilyConfig } from '@lily/shared/config';

import { newId } from '../../util/ids.js';
import { errorField, log } from '../../util/log.js';
import type { Clock, TimerHandle, Timers } from '../../util/clock.js';
import { systemClock, systemTimers } from '../../util/clock.js';
import type {
  AudioStream,
  EmployeeProfile,
  HeardUtterance,
  Participant,
  SpeechOutput,
} from '../../types.js';
import {
  MeetingAdapterUnavailableError,
  MeetingAdapterUnsupportedError,
  type MeetingAdapter,
  type MeetingAdapterCapabilities,
  type MeetingEndReason,
  type MeetingJoinResult,
  type MeetingPlatform,
  type Unsubscribe,
} from '../adapter.js';
import type { BoardTaskRow } from '../local/page.js';
import { captureFailure, defaultDebugDir } from './debug.js';
import {
  JoinStalledError,
  SelectorFailureError,
  requireSelector,
  type JoinContext,
  type PageContext,
  type PlatformDriver,
  type SelectorResolution,
  type StepTimeouts,
} from './driver.js';
import { LinuxMeetingEnvironment, type MeetingEnvironment } from './environment.js';
import { PlaywrightBrowserLauncher, buildChromeArgs, defaultUserAgent } from './launch.js';
import type { BrowserLauncher, BrowserPage, BrowserSession } from './page.js';
import { SpeakerResolver, SpeakerTracker, type ResolvedSpeaker } from './speaker.js';
import { JoinStateMachine } from './state.js';
import { MeetingSurface, type SurfaceStatus } from './surface.js';
import { detectRefusal, type Refusal } from './refusal.js';
import { resolveVideoMode, type VideoMode } from './video.js';
import { browserPreflight, findChrome, systemProbe, type HostProbe } from './xvfb.js';

export const DEFAULT_TIMEOUTS: StepTimeouts = {
  navigateMs: 45_000,
  interactionMs: 15_000,
  // Two minutes for a human to notice the admit prompt and click it. Longer
  // than that and the meeting has started without her anyway.
  lobbyMs: 120_000,
  inCallMs: 60_000,
  probeMs: 2_000,
};

/** Fast enough to attribute a sentence to the person who said it. */
const SPEAKER_POLL_MS = 400;
/** Roster, removal and meeting-end. Cheap to be slower about. */
const PRESENCE_POLL_MS = 3_000;
/** How long a speaker highlight must hold before it counts. See SpeakerTracker. */
const SPEAKER_HOLD_MS = 350;

/** A screen size a human would plausibly have, rather than one that reads as a bot. */
const VIEWPORT = { width: 1280, height: 720 } as const;

/**
 * How many failure captures one meeting may write.
 *
 * Evidence is captured on every selector failure now, including mid-call ones
 * that are retried — and a chat button that has moved will fail on every
 * attempt. Without a cap, one broken selector fills a disk with screenshots of
 * a live meeting, which is the opposite of what the data policy wants.
 */
const MAX_DEBUG_CAPTURES = 5;

export interface BrowserMeetingAdapterOptions {
  readonly meetingId: string;
  /** The join link, as a human received it. Normalised by the driver. */
  readonly meetingUrl: string;
  readonly driver: PlatformDriver;
  readonly config: LilyConfig;
  readonly directory: readonly EmployeeProfile[];

  /** Live task list, for the screenshare board. */
  readonly taskView?: () => readonly BoardTaskRow[];
  readonly videoMode?: VideoMode;
  readonly debugDir?: string;
  readonly timeouts?: StepTimeouts;
  readonly clock?: Clock;
  readonly timers?: Timers;

  // Test seams. Every one of these has a real default; none is a mock in
  // production.
  readonly launcher?: BrowserLauncher;
  readonly environment?: MeetingEnvironment;
  readonly probe?: HostProbe;
}

export class BrowserMeetingAdapter implements MeetingAdapter {
  readonly platform: MeetingPlatform;
  readonly capabilities: MeetingAdapterCapabilities;

  readonly #options: BrowserMeetingAdapterOptions;
  readonly #driver: PlatformDriver;
  readonly #clock: Clock;
  readonly #timers: Timers;
  readonly #timeouts: StepTimeouts;
  readonly #debugDir: string;
  readonly #botDisplayName: string;
  readonly #resolver: SpeakerResolver;
  readonly #tracker = new SpeakerTracker(SPEAKER_HOLD_MS);
  readonly #state: JoinStateMachine;
  readonly #surface: MeetingSurface;
  readonly #chromePath: string;
  readonly #viewport = VIEWPORT;
  #captureCount = 0;

  readonly #onJoin = new Set<(participant: Participant) => void>();
  readonly #onLeave = new Set<(participant: Participant) => void>();
  readonly #onUtterance = new Set<(utterance: HeardUtterance) => void>();
  readonly #onEnd = new Set<(reason: MeetingEndReason) => void>();
  readonly #onSpeaker = new Set<(participant: Participant | null) => void>();

  /** Display name (lowercased) → the participant we minted for it. */
  readonly #participants = new Map<string, Participant>();

  #environment: MeetingEnvironment | null = null;
  #session: BrowserSession | null = null;
  #avatarPage: BrowserPage | null = null;
  #sharePage: BrowserPage | null = null;
  #audio: AudioStream | null = null;
  #speakerTimer: TimerHandle | null = null;
  #presenceTimer: TimerHandle | null = null;
  #polling = false;
  #status: SurfaceStatus | null = null;
  #activeSpeaker: Participant | null = null;
  #joinedAt: Date | null = null;
  #muted = false;
  #handRaised = false;
  #sharing = false;
  #left = false;
  /** Latches on removal. Nothing re-joins after this is true. */
  #removed = false;
  #resolvedVideoMode: VideoMode | null = null;

  constructor(options: BrowserMeetingAdapterOptions) {
    this.#options = options;
    this.#driver = options.driver;
    this.platform = options.driver.platform;
    this.capabilities = options.driver.capabilities;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? systemTimers;
    this.#timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
    this.#debugDir = options.debugDir ?? defaultDebugDir();
    this.#botDisplayName = options.config.meeting.botDisplayName;
    this.#state = new JoinStateMachine(this.#clock);

    const probe = options.probe ?? systemProbe;
    const check = browserPreflight(this.platform, probe);
    if (!check.ready) {
      // At construction, not at join. A room full of people watching a bot that
      // was never going to be able to speak is the failure this prevents.
      throw new MeetingAdapterUnavailableError(
        this.platform,
        [...check.missing, ...check.blockers],
        'See orchestrator/README.md § Platforms. This adapter drives a real ' +
          'headful Google Chrome inside Xvfb with a PulseAudio virtual sound card, so it needs a ' +
          'Linux host provisioned by orchestrator/scripts/provision-browser-host.sh. On a dev ' +
          'machine run the simulated local room instead: LILY_MEETING_PLATFORM=local.',
      );
    }

    // `findChrome` already succeeded inside the preflight; this re-reads it for
    // the launch rather than threading it through the result type.
    this.#chromePath = findChrome(probe) ?? '';

    this.#resolver = new SpeakerResolver({
      directory: options.directory,
      botDisplayName: this.#botDisplayName,
    });

    this.#surface = new MeetingSurface({
      meetingId: options.meetingId,
      botDisplayName: this.#botDisplayName,
      rows: () => options.taskView?.() ?? [],
      status: () => this.#status,
    });

    if (this.#driver.termsRisk !== null) {
      // Logged once, at construction, as an enum-free single field. An accepted
      // risk that nobody is reminded of is an unaccepted risk.
      log.warn('browser.terms_risk_accepted', {
        driver: this.#driver.id,
        platform: this.platform,
        note: this.#driver.termsRisk,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Extras beyond MeetingAdapter
  // -------------------------------------------------------------------------

  /**
   * Who the platform says is speaking, or null.
   *
   * Read off the DOM, which is better attribution than diarizing a mixed audio
   * stream would ever be — it is the platform's own per-track answer rather
   * than our guess at one. `employeeId` is null whenever the name is unknown,
   * ambiguous or absent, and the permission gate treats null as "not a known
   * employee", which is the direction that denies.
   */
  get activeSpeaker(): Participant | null {
    return this.#activeSpeaker;
  }

  onActiveSpeakerChange(handler: (participant: Participant | null) => void): Unsubscribe {
    this.#onSpeaker.add(handler);
    return () => this.#onSpeaker.delete(handler);
  }

  /** Where the join stalled, for a caller that wants to report it. */
  get joinState(): string {
    return this.#state.state;
  }

  get wasRemovedByHost(): boolean {
    return this.#removed;
  }

  // -------------------------------------------------------------------------
  // Join
  // -------------------------------------------------------------------------

  async join(): Promise<MeetingJoinResult> {
    if (this.#removed) {
      throw new Error(
        `${this.#botDisplayName} was removed from this meeting by a host and will not rejoin. ` +
          'Removal is final by design — see the consent notes in this adapter.',
      );
    }
    if (this.#session !== null) throw new Error('BrowserMeetingAdapter.join() called twice.');

    const url = this.#driver.joinUrl(this.#options.meetingUrl, this.#botDisplayName);

    const environment =
      this.#options.environment ??
      new LinuxMeetingEnvironment({
        meetingId: this.#options.meetingId,
        videoMode: this.#videoMode(),
        screen: VIEWPORT,
      });
    this.#environment = environment;

    await environment.start();
    await this.#surface.start();

    const launcher = this.#options.launcher ?? new PlaywrightBrowserLauncher();
    this.#session = await launcher.launch({
      display: environment.display,
      executablePath: this.#chromePath,
      args: buildChromeArgs({
        viewport: this.#viewport,
        screenshareWindowTitle: this.#surface.windowTitle,
        videoArgs: environment.videoArgs(),
        noSandbox: process.env['LILY_BROWSER_NO_SANDBOX'] === '1',
      }),
      timeoutMs: this.#timeouts.navigateMs,
      userAgent: defaultUserAgent(),
      viewport: this.#viewport,
    });

    const ctx = this.#joinContext(url);
    try {
      await this.#driver.join(ctx);
    } catch (cause) {
      await this.#failJoin(cause);
    }

    if (!this.#state.inCall) {
      await this.#failJoin(
        new JoinStalledError({
          driverId: this.#driver.id,
          joinState: this.#state.state,
          stall: this.#state.describeStall(),
          debugPaths: [],
          guidance:
            this.#state.state === 'lobby'
              ? 'Nobody admitted the guest. This is a person, not a bug: someone already in the ' +
                'meeting has to accept the join request.'
              : 'The driver returned without reaching the in-call state. Its selector table is ' +
                'the first place to look.',
        }),
      );
    }

    this.#joinedAt = this.#clock.date();
    log.info('browser.joined', {
      driver: this.#driver.id,
      platform: this.platform,
      meetingId: this.#options.meetingId,
      trail: this.#state.trail(),
    });

    await this.#announce();
    await this.#refreshParticipants();
    this.#startPolling();

    const bot: Participant = {
      participantId: newId('bot'),
      displayName: this.#botDisplayName,
      employeeId: null,
      isBot: true,
      joinedAt: this.#joinedAt,
    };
    this.#participants.set(this.#botDisplayName.toLowerCase(), bot);

    return {
      meetingId: this.#options.meetingId,
      joinedAt: this.#joinedAt,
      participants: [...this.#participants.values()],
    };
  }

  /**
   * Turn any join failure into one that names the step, the selector and the
   * state — and leaves evidence on disk.
   */
  /**
   * Say what she is, in the room, without being asked to.
   *
   * ===========================================================================
   * BEST EFFORT, DELIBERATELY — AND THE ORDER MATTERS
   * ===========================================================================
   * Consent must not be *contingent* on chat working, and it must not be able to
   * *end* a meeting she is already in. Both were wrong before: an unreachable
   * chat button propagated out of `join()` and killed a live call.
   *
   * Disclosure has three independent carriers, and they degrade in this order:
   *
   *   1. **The participant list.** `config.meeting.botDisplayName` must read
   *      unmistakably as an AI, and it is there from the moment she joins. This
   *      one cannot fail — it is the join itself — and it is the load-bearing
   *      part of the disclosure.
   *   2. **Chat**, written here. Best of the two active ones: it persists, so
   *      someone who joins thirty seconds late still sees it, and it survives a
   *      muted microphone.
   *   3. **Speech.** The session says `speech.joinAnnouncement` through the
   *      scheduler right after `start()`. On a realtime brain that is rendered
   *      audio going straight to the virtual microphone, so it does not touch
   *      chat and is unaffected by whatever went wrong here.
   *
   * Note this deliberately does *not* fall back to `speak()` with text: on an
   * audio platform `speak` routes text to chat, so that would just retry the
   * thing that already failed and call it a second tier.
   */
  async #announce(): Promise<void> {
    if (!this.capabilities.chat) return;

    const line =
      `${this.#botDisplayName} has joined. I am an AI assistant, not a person. ` +
      `I listen for things addressed to me by name and can be removed by any host at any time.`;

    const posted = await this.#bestEffort('announce.chat', () => this.postChat(line));
    if (posted) return;

    // Worth an error rather than a warning: the disclosure is thinner than
    // intended and somebody should know, even though the meeting continues and
    // the participant list still says what she is.
    log.error('browser.announcement_not_written', {
      driver: this.#driver.id,
      meetingId: this.#options.meetingId,
      note: 'chat unreachable; disclosure rests on the participant name and the spoken line',
    });
  }

  /**
   * Screenshot and page HTML, while the page still exists.
   *
   * Capped per meeting — see `MAX_DEBUG_CAPTURES`. Returns the paths written,
   * or an empty list, and never throws: this only ever runs on a failure path
   * and must not replace the real error with its own.
   */
  async #capture(page: BrowserPage | null, label: string): Promise<readonly string[]> {
    if (this.#captureCount >= MAX_DEBUG_CAPTURES) {
      log.debug('browser.debug_capture_capped', { cap: MAX_DEBUG_CAPTURES, label });
      return [];
    }
    this.#captureCount += 1;

    const capture = await captureFailure(page, {
      dir: this.#debugDir,
      driverId: this.#driver.id,
      label,
      meetingId: this.#options.meetingId,
    }).catch(() => ({ paths: [] as readonly string[] }));

    return capture.paths;
  }

  /**
   * A post-join step that must never end a live meeting.
   *
   * ===========================================================================
   * THE RULE THIS ENFORCES
   * ===========================================================================
   * **Only failing to get *into* the call is fatal.** Once Lily is in the room,
   * every remaining nicety — announcing herself, posting to chat, raising a
   * hand, sharing a screen, updating her status card — is something that can
   * degrade. A meeting that ends because a chat button moved is a far worse
   * outcome than a meeting where nothing was posted to chat.
   *
   * This was not theoretical. A `chatToggle` timeout on the join announcement
   * propagated out of `speak()`, through the speech scheduler's `sayImmediately`
   * (which, unlike its queue pump, does not catch), out of `session.start()`,
   * and killed a live meeting she was already in.
   *
   * Failures are logged at `warn` with the step name and the selector
   * diagnosis, never silently swallowed — degrading is not the same as
   * pretending it worked.
   */
  async #bestEffort(step: string, action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (cause) {
      log.warn('browser.post_join_step_failed', {
        driver: this.#driver.id,
        step,
        inCall: this.#state.inCall,
        resolution: cause instanceof SelectorFailureError ? cause.resolution : 'unknown',
        selector: cause instanceof SelectorFailureError ? cause.selectorName : 'n/a',
        error: errorField(cause),
      });
      return false;
    }
  }

  async #failJoin(cause: unknown): Promise<never> {
    // Read the stall *before* moving to `failed`, or every message becomes
    // "failed 0s ago" and the state it actually stalled in is lost.
    const stalledIn = this.#state.state;
    const stall = this.#state.describeStall();

    // A selector failure has already captured its own evidence, at the moment
    // it happened and with the page still open. Re-throw it untouched rather
    // than rebuilding it against a page that is about to be torn down.
    if (cause instanceof SelectorFailureError) {
      this.#state.to('failed', 'join failed');
      await this.#teardown().catch(() => undefined);
      throw cause;
    }

    // Same rule, same reason: a stall that already photographed the page did so
    // at the moment that mattered. Re-wrapping it duplicated the "[meet] join
    // did not complete: ..." prefix into the message AND captured a second,
    // later screenshot of a page that had by then moved on — burying the
    // capture worth reading under one that was not.
    if (cause instanceof JoinStalledError && cause.debugPaths.length > 0) {
      this.#state.to('failed', 'join failed');
      await this.#teardown().catch(() => undefined);
      throw cause;
    }

    // Everything else failed without a selector step, so this is the first
    // chance to photograph the page — and it has to happen before teardown.
    const paths = await this.#capture(this.#session?.page ?? null, `join-${stalledIn}`);

    this.#state.to('failed', 'join failed');
    await this.#teardown().catch(() => undefined);

    if (cause instanceof JoinStalledError) {
      throw new JoinStalledError({
        driverId: this.#driver.id,
        joinState: cause.joinState,
        stall,
        debugPaths: paths,
        guidance: cause.message,
      });
    }

    throw new Error(
      `[${this.#driver.id}] join failed while ${stall}.\n` +
        `  cause: ${errorField(cause)}\n` +
        (paths.length === 0
          ? ''
          : `Page evidence written to:\n${paths.map((p) => `  ${p}`).join('\n')}`),
    );
  }

  // -------------------------------------------------------------------------
  // The context every driver step runs through
  // -------------------------------------------------------------------------

  #pageContext(): PageContext {
    const page = this.#session?.page;
    if (page === undefined) throw new Error('The browser is not running.');
    return this.#contextFor(page);
  }

  #joinContext(url: string): JoinContext {
    const page = this.#session?.page;
    if (page === undefined) throw new Error('The browser is not running.');
    return { ...this.#contextFor(page), state: this.#state, url };
  }

  #contextFor(page: BrowserPage): PageContext {
    const driverId = this.#driver.id;
    const selectors = this.#driver.selectors;
    const state = this.#state;
    const timeouts = this.#timeouts;

    /**
     * Turn a raw interaction failure into a diagnosis.
     *
     * Async, and worth it: it probes the page to distinguish "nothing matched"
     * from "matched and would not take the click", and it captures the
     * screenshot and HTML **here**, while the page is still open. Doing that at
     * teardown was too late — a mid-call failure produced "no page evidence was
     * captured", which is exactly when the evidence is most useful.
     */
    const fail = async (step: string, name: string, cause: unknown): Promise<never> => {
      const entry = requireSelector(driverId, selectors, name);

      let matchCount = -1;
      let resolution: SelectorResolution = 'unknown';
      try {
        matchCount = await page.locator(entry.selector).count();
        resolution = matchCount > 0 ? 'not-interactable' : 'not-found';
      } catch {
        // The page went away underneath us. `unknown` says so rather than
        // guessing at a vendor change.
      }

      // Ask the page why before blaming the selector table. A vendor that has
      // written "Automated bots aren't allowed to join this meeting" on the
      // screen has already answered, and the old message talked over it.
      let refusal: Refusal | null = null;
      try {
        refusal = detectRefusal(await page.content());
      } catch {
        // Page gone. `null` keeps the ordinary diagnosis; it never asserts
        // that there was no refusal, only that none was read.
      }

      const capture = await this.#capture(page, `${step}-${name}`);

      throw new SelectorFailureError({
        refusal,
        driverId,
        step,
        selectorName: name,
        selector: entry.selector,
        what: entry.what,
        joinState: state.state,
        stall: state.describeStall(),
        resolution,
        matchCount,
        debugPaths: capture,
        cause,
      });
    };

    return {
      page,
      timeouts,
      driverId,
      viewport: this.#viewport,
      botDisplayName: this.#botDisplayName,

      capture: (label: string) => this.#capture(page, label),

      async click(step, name) {
        const entry = requireSelector(driverId, selectors, name);
        try {
          await page.locator(entry.selector).first().click({ timeout: timeouts.interactionMs });
        } catch (cause) {
          await fail(step, name, cause);
        }
      },

      async fill(step, name, value) {
        const entry = requireSelector(driverId, selectors, name);
        try {
          await page.locator(entry.selector).first().fill(value, { timeout: timeouts.interactionMs });
        } catch (cause) {
          // A React-managed field can reject `fill` and accept real keystrokes.
          try {
            await page.type(entry.selector, value, { timeout: timeouts.interactionMs });
          } catch {
            await fail(step, name, cause);
          }
        }
      },

      async submit(step, name) {
        const entry = requireSelector(driverId, selectors, name);
        try {
          await page.type(entry.selector, '\n', { timeout: timeouts.interactionMs });
        } catch (cause) {
          await fail(step, name, cause);
        }
      },

      async waitFor(step, name, want, timeoutMs) {
        const entry = requireSelector(driverId, selectors, name);
        try {
          await page.locator(entry.selector).first().waitFor({ state: want, timeout: timeoutMs });
        } catch (cause) {
          await fail(step, name, cause);
        }
      },

      async present(name, timeoutMs) {
        const entry = requireSelector(driverId, selectors, name);
        try {
          await page.locator(entry.selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
          return true;
        } catch {
          return false;
        }
      },

      async clickIfPresent(name, timeoutMs) {
        const entry = requireSelector(driverId, selectors, name);
        try {
          const locator = page.locator(entry.selector).first();
          await locator.waitFor({ state: 'visible', timeout: timeoutMs });
          await locator.click({ timeout: timeoutMs });
          return true;
        } catch {
          // Optional by definition. Absence is the common case.
          return false;
        }
      },

      async textsOf(name) {
        const entry = requireSelector(driverId, selectors, name);
        try {
          return await page.locator(entry.selector).allTextContents();
        } catch {
          return [];
        }
      },

      async attributeOf(name, attribute) {
        const entry = requireSelector(driverId, selectors, name);
        try {
          return await page
            .locator(entry.selector)
            .first()
            .getAttribute(attribute, { timeout: timeouts.probeMs });
        } catch {
          return null;
        }
      },

      async race(names, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          for (const name of names) {
            const entry = requireSelector(driverId, selectors, name);
            const visible = await page
              .locator(entry.selector)
              .first()
              .isVisible()
              .catch(() => false);
            if (visible) return name;
          }
          if (Date.now() >= deadline) return null;
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  #startPolling(): void {
    this.#polling = true;
    this.#speakerTimer = this.#timers.every(SPEAKER_POLL_MS, () => {
      void this.#pollSpeaker().catch((cause: unknown) => {
        log.debug('browser.speaker_poll_failed', { error: errorField(cause) });
      });
    });
    this.#presenceTimer = this.#timers.every(PRESENCE_POLL_MS, () => {
      void this.#pollPresence().catch((cause: unknown) => {
        log.debug('browser.presence_poll_failed', { error: errorField(cause) });
      });
    });
  }

  async #pollSpeaker(): Promise<void> {
    if (!this.#state.inCall || this.#left) return;

    const raw = await this.#driver.activeSpeaker(this.#pageContext());
    const observation = this.#tracker.observe(raw, this.#clock.now());
    if (!observation.changed) return;

    if (observation.speaker === null) {
      this.#setActiveSpeaker(null);
      return;
    }

    const resolved = this.#resolver.resolve(observation.speaker);
    if (resolved.isBot) {
      // Lily's own tile lighting up is Lily talking. Not an utterance, and not
      // a speaker anything downstream should attribute anything to.
      this.#setActiveSpeaker(null);
      return;
    }

    this.#setActiveSpeaker(this.#rememberParticipant(resolved));
  }

  #setActiveSpeaker(participant: Participant | null): void {
    if (participant?.participantId === this.#activeSpeaker?.participantId) return;
    this.#activeSpeaker = participant;
    for (const handler of this.#onSpeaker) handler(participant);
  }

  async #pollPresence(): Promise<void> {
    if (this.#left) return;
    const ctx = this.#pageContext();

    if (await this.#driver.wasRemoved(ctx)) {
      this.#removed = true;
      log.warn('browser.removed_by_host', { driver: this.#driver.id });
      for (const handler of this.#onEnd) handler('kicked');
      return;
    }

    if (await this.#driver.hasEnded(ctx)) {
      for (const handler of this.#onEnd) handler('meeting_ended');
      return;
    }

    await this.#refreshParticipants();
  }

  async #refreshParticipants(): Promise<void> {
    const names = await this.#driver.participantNames(this.#pageContext()).catch(() => []);
    // An empty read is far more likely a collapsed participants panel than an
    // empty room, and treating it as departures would fire a leave event for
    // everyone and end the meeting. Emptiness is decided by the session's own
    // grace timer on real leave events, not by one unlucky poll.
    if (names.length === 0) return;

    const seen = new Set<string>();
    for (const name of names) {
      const resolved = this.#resolver.resolve(name);
      if (resolved.isBot) {
        seen.add(this.#botDisplayName.toLowerCase());
        continue;
      }
      seen.add(resolved.displayName.toLowerCase());
      this.#rememberParticipant(resolved);
    }

    for (const [key, participant] of [...this.#participants]) {
      if (seen.has(key) || participant.isBot) continue;
      this.#participants.delete(key);
      for (const handler of this.#onLeave) handler(participant);
    }
  }

  #rememberParticipant(resolved: ResolvedSpeaker): Participant {
    const key = resolved.displayName.toLowerCase();
    const existing = this.#participants.get(key);
    if (existing !== undefined) return existing;

    const participant = this.#resolver.toParticipant(resolved, this.#clock.date());
    this.#participants.set(key, participant);
    for (const handler of this.#onJoin) handler(participant);
    return participant;
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /**
   * Say something.
   *
   * ===========================================================================
   * WHY A FAILURE HERE IS NOT ALLOWED TO PROPAGATE
   * ===========================================================================
   * `SpeechScheduler.sayImmediately` — used for the join announcement and the
   * goodbye — does not catch, unlike its queue pump. So a throw from here goes
   * straight out of `session.start()` and ends the process. That is how a
   * single unreachable chat button killed a live meeting Lily was already in.
   *
   * The judgement: a line that cannot be delivered is bad, and a meeting that
   * ends because a line could not be delivered is worse. So an undeliverable
   * line is logged at `warn` with the step and the selector diagnosis, and the
   * meeting carries on.
   *
   * The one case that still throws is a *contract* error rather than a runtime
   * one: text output on a platform that reports `capabilities.chat === false`.
   * That is a misconfigured adapter, it is deterministic, and it should be
   * discovered rather than absorbed.
   */
  async speak(output: SpeechOutput): Promise<void> {
    if (this.#left) return;

    if (output.kind === 'audio') {
      await this.#bestEffort('speak.audio', async () => {
        await this.#environment?.writeSpeech(output.pcm16);
      });
      return;
    }

    if (!this.capabilities.chat) {
      throw new MeetingAdapterUnsupportedError(
        this.platform,
        'text-only speech without a chat channel',
      );
    }

    // Text on an audio platform. Chat is the only route the adapter has — it
    // cannot synthesise — so if chat is unreachable the line is lost, and that
    // is recorded rather than hidden.
    const delivered = await this.#bestEffort('speak.chat', () => this.postChat(output.text));
    if (!delivered) {
      log.warn('browser.speech_undeliverable', {
        driver: this.#driver.id,
        // Length only. The words are meeting content and do not go to stdout.
        chars: output.text.length,
      });
    }
  }

  async stopSpeaking(): Promise<void> {
    this.#environment?.interruptSpeech();
  }

  getAudioStream(): AudioStream | null {
    if (!this.capabilities.audio) return null;
    this.#audio ??= this.#environment?.captureStream() ?? null;
    return this.#audio;
  }

  async postChat(message: string): Promise<void> {
    if (this.#left) return;
    await this.#driver.postChat(this.#pageContext(), message);
  }

  /**
   * Share the board.
   *
   * `url` is the caller's route on Lily's own surface, not an arbitrary page:
   * the session asks for `/board`, a second browser window opens it with a
   * title unique to this meeting, and Chrome's
   * `--auto-select-desktop-capture-source` answers the picker with that title.
   * The window is torn down with the share, so a previous meeting's items are
   * never left on screen.
   *
   * This one still throws on failure, deliberately. The session says "the
   * action items are on screen" straight after calling it, and swallowing the
   * failure would turn a missed click into Lily asserting something false. The
   * session's utterance handler already catches, so the meeting continues and
   * she simply says nothing — silence beats a lie.
   */
  async startScreenshare(url: string): Promise<void> {
    if (this.#sharing) return;
    const session = this.#session;
    if (session === null) throw new Error('The browser is not running.');

    const target = url.startsWith('http') ? url : `${this.#surface.origin}${url}`;
    this.#sharePage = await session.newPage(target);

    try {
      await this.#driver.startScreenshare(this.#pageContext());
    } catch (cause) {
      // The window opened and the share did not. Leaving it would keep a board
      // of this meeting's action items on screen with nothing sharing it, and
      // would hold the tab open for the rest of the call.
      await this.#closeSharePage();
      throw cause;
    }

    this.#sharing = true;
    log.info('browser.screenshare_started', { driver: this.#driver.id });
  }

  async stopScreenshare(): Promise<void> {
    if (!this.#sharing) return;
    this.#sharing = false;
    await this.#driver.stopScreenshare(this.#pageContext()).catch((cause: unknown) => {
      log.warn('browser.screenshare_stop_failed', { error: errorField(cause) });
    });
    await this.#closeSharePage();
  }

  async #closeSharePage(): Promise<void> {
    const page = this.#sharePage;
    this.#sharePage = null;
    if (page === null || page.isClosed()) return;
    await page.close().catch(() => undefined);
  }

  async raiseHand(): Promise<void> {
    await this.#driver.setHandRaised(this.#pageContext(), true);
    this.#handRaised = true;
  }

  async lowerHand(): Promise<void> {
    await this.#driver.setHandRaised(this.#pageContext(), false);
    this.#handRaised = false;
  }

  async mute(): Promise<void> {
    await this.#driver.setMuted(this.#pageContext(), true);
    this.#muted = true;
  }

  async unmute(): Promise<void> {
    await this.#driver.setMuted(this.#pageContext(), false);
    this.#muted = false;
  }

  get muted(): boolean {
    return this.#muted;
  }

  get handRaised(): boolean {
    return this.#handRaised;
  }

  /**
   * Live work-in-progress under her avatar.
   *
   * Only reaches the meeting grid in `v4l2loopback` video mode, where the card
   * is re-rendered and pushed as a camera frame. In static-card mode the flag
   * Chrome was launched with points at a file it loops, so there is nothing to
   * update — the status is still tracked, and the shared board still shows it.
   *
   * **Must never reject.** `session.ts` calls this as `void adapter.setStatus(…)`
   * from a daemon event handler with no `.catch`, and an unhandled rejection
   * ends the Node process — which would mean a live meeting killed by a failed
   * avatar redraw. The `catch` below is load-bearing; do not remove it.
   */
  async setStatus(status: { state: string; note?: string } | null): Promise<void> {
    this.#status =
      status === null
        ? null
        : { state: status.state, note: status.note === undefined ? null : status.note };

    if (this.#videoMode() !== 'v4l2loopback') return;
    await this.#refreshAvatarFrame().catch((cause: unknown) => {
      log.debug('browser.avatar_refresh_failed', { error: errorField(cause) });
    });
  }

  /**
   * The video mode for this meeting, decided once.
   *
   * Memoised deliberately. `resolveVideoMode()` probes the filesystem, and
   * `join()` and `setStatus()` both ask — if the device vanished mid-call the
   * two would disagree, and `setStatus` would start pushing frames into an
   * ffmpeg that `join` never started.
   */
  #videoMode(): VideoMode {
    this.#resolvedVideoMode ??= this.#options.videoMode ?? resolveVideoMode();
    return this.#resolvedVideoMode;
  }

  async #refreshAvatarFrame(): Promise<void> {
    const session = this.#session;
    if (session === null) return;

    this.#avatarPage ??= await session.newPage(this.#surface.avatarUrl);
    const page = this.#avatarPage;
    if (page.isClosed()) {
      this.#avatarPage = null;
      return;
    }
    await page.goto(this.#surface.avatarUrl, {
      timeout: this.#timeouts.interactionMs,
      waitUntil: 'domcontentloaded',
    });
    const png = await page.screenshot({ path: null, fullPage: false });
    this.#environment?.pushAvatarFrame(png);
  }

  async getParticipants(): Promise<readonly Participant[]> {
    return [...this.#participants.values()];
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  onParticipantJoin(handler: (participant: Participant) => void): Unsubscribe {
    this.#onJoin.add(handler);
    return () => this.#onJoin.delete(handler);
  }

  onParticipantLeave(handler: (participant: Participant) => void): Unsubscribe {
    this.#onLeave.add(handler);
    return () => this.#onLeave.delete(handler);
  }

  /**
   * Recognised speech.
   *
   * A browser cannot produce this on its own: the DOM says *who* is talking,
   * never *what* they said. In the wired path the words come from the Realtime
   * session consuming `getAudioStream()`, and the speaker comes from this
   * adapter through `onActiveSpeakerChange` → `LilyBrain.noteSpeaker` — so the
   * brain assembles the attributed utterance and this event stays quiet.
   *
   * It is still here, and still real, for a caller that does its own
   * transcription: they hand the text to `emitUtterance` and the adapter
   * attributes it. That is also what the attribution tests drive.
   */
  onUtterance(handler: (utterance: HeardUtterance) => void): Unsubscribe {
    this.#onUtterance.add(handler);
    return () => this.#onUtterance.delete(handler);
  }

  /**
   * Attribute a transcript to whoever the platform says is speaking.
   *
   * Deliberately explicit rather than inferred, and deliberately unable to
   * guess: with no identified speaker this produces `employeeId: null`, which
   * the permission gate treats as "not a known employee". The adapter keeps no
   * transcript of its own — `text` passes straight through to the handlers.
   */
  emitUtterance(text: string, at: Date = this.#clock.date()): void {
    const speaker = this.#activeSpeaker;
    const utterance: HeardUtterance = {
      participantId: speaker?.participantId ?? 'unknown',
      employeeId: speaker?.employeeId ?? null,
      speakerName: speaker?.displayName ?? 'unidentified speaker',
      text,
      at,
      fromAudio: true,
    };
    for (const handler of this.#onUtterance) handler(utterance);
  }

  onMeetingEnd(handler: (reason: MeetingEndReason) => void): Unsubscribe {
    this.#onEnd.add(handler);
    return () => this.#onEnd.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Leave
  // -------------------------------------------------------------------------

  async leave(reason: MeetingEndReason): Promise<void> {
    if (this.#left) return;
    this.#left = true;

    // Removal is a leave path, not an error path, and never a rejoin.
    if (reason === 'kicked') this.#removed = true;

    if (this.#state.inCall && reason !== 'kicked') {
      await this.#driver.leave(this.#pageContext()).catch((cause: unknown) => {
        log.warn('browser.leave_click_failed', { error: errorField(cause) });
      });
    }

    this.#state.to('left', reason);
    await this.#teardown();

    log.info('browser.left', {
      driver: this.#driver.id,
      reason,
      removed: this.#removed,
      trail: this.#state.trail(),
    });
  }

  async #teardown(): Promise<void> {
    if (this.#speakerTimer !== null) this.#timers.cancel(this.#speakerTimer);
    if (this.#presenceTimer !== null) this.#timers.cancel(this.#presenceTimer);
    this.#speakerTimer = null;
    this.#presenceTimer = null;
    this.#polling = false;

    this.#audio?.close();
    this.#audio = null;

    await this.#closeSharePage();
    const avatar = this.#avatarPage;
    this.#avatarPage = null;
    if (avatar !== null && !avatar.isClosed()) await avatar.close().catch(() => undefined);

    const session = this.#session;
    this.#session = null;
    await session?.close().catch(() => undefined);

    await this.#surface.stop().catch(() => undefined);
    await this.#environment?.stop().catch(() => undefined);
    this.#environment = null;
    this.#participants.clear();
    this.#activeSpeaker = null;
  }

  /** Test-visible: true while the poll timers are armed. */
  get polling(): boolean {
    return this.#polling;
  }
}

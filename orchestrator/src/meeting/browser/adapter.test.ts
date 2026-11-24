/**
 * The browser adapter, driven by a fake page.
 *
 * No browser, no display server, no network, no meeting. Everything asserted
 * here is a property that must hold before any of those are involved:
 *
 *   - the join sequence walks the state machine and stops in `in-call`;
 *   - a selector that stops matching produces a message naming **which step**
 *     and **which selector**, plus page evidence on disk;
 *   - a lobby nobody answers reports the lobby, not a generic timeout;
 *   - the active speaker is resolved against the roster, and an unknown speaker
 *     is `employeeId: null`;
 *   - Lily announces herself, stays kickable, and never rejoins after removal;
 *   - Chrome is not launched headless and is not given a fake audio device.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConfig } from '@lily/shared/config';
import type { LilyConfig } from '@lily/shared/config';

import { ManualClock } from '../../util/clock.js';
import type { EmployeeProfile, Participant } from '../../types.js';
import { MeetingAdapterUnavailableError } from '../adapter.js';
import { BrowserMeetingAdapter } from './adapter.js';
import { JoinStalledError, SelectorFailureError } from './driver.js';
import { JitsiDriver } from './drivers/jitsi.js';
import { NullMeetingEnvironment } from './environment.js';
import {
  FakeBrowserLauncher,
  FakeMeetingPage,
  bareLinuxProbe,
  readyLinuxProbe,
} from './testing.js';

const DIRECTORY: readonly EmployeeProfile[] = [
  {
    employeeId: 'emp_sarah',
    name: 'Sarah Chen',
    aliases: [],
    jobDescription: 'auth and identity',
    agentKind: 'claude-code',
    capabilities: ['fs'],
    daemonEnrolled: true,
  },
  {
    employeeId: 'emp_john',
    name: 'John Rivera',
    aliases: [],
    jobDescription: 'build and release',
    agentKind: 'claude-code',
    capabilities: ['shell'],
    daemonEnrolled: true,
  },
];

let config: LilyConfig;
let debugDir: string;

beforeEach(() => {
  config = buildConfig('local');
  debugDir = mkdtempSync(pathJoin(tmpdir(), 'lily-browser-test-'));
});

afterEach(() => {
  delete process.env['LILY_CHROME_PATH'];
});

/** A page already showing everything a clean Jitsi join needs. */
function readyPage(): FakeMeetingPage {
  const driver = new JitsiDriver();
  return new FakeMeetingPage('jitsi', driver.selectors)
    .show('nameInput')
    .show('joinButton')
    .show('inCallMarker')
    .show('chatToggle')
    .show('chatInput')
    .show('leaveButton')
    .show('participantNames', { texts: ['Sarah Chen', 'John Rivera', 'Lily (AI assistant)'] });
}

interface Harness {
  readonly adapter: BrowserMeetingAdapter;
  readonly page: FakeMeetingPage;
  readonly launcher: FakeBrowserLauncher;
  readonly clock: ManualClock;
  readonly environment: NullMeetingEnvironment;
}

function harness(page: FakeMeetingPage, lobbyMs = 30): Harness {
  const clock = new ManualClock();
  const launcher = new FakeBrowserLauncher(page);
  const environment = new NullMeetingEnvironment();

  const adapter = new BrowserMeetingAdapter({
    meetingId: 'mtg_browser_test',
    meetingUrl: 'https://meet.jit.si/LilyTestRoom',
    driver: new JitsiDriver(),
    config,
    directory: DIRECTORY,
    debugDir,
    clock,
    timers: clock,
    launcher,
    environment,
    probe: readyLinuxProbe(),
    timeouts: {
      navigateMs: 100,
      interactionMs: 50,
      lobbyMs,
      inCallMs: 100,
      probeMs: 20,
    },
  });

  return { adapter, page, launcher, clock, environment };
}

/** Let queued microtasks settle after a timer fires. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------

describe('construction refuses a host that cannot run a browser meeting', () => {
  it('names every missing package, before any meeting is scheduled against it', () => {
    let thrown: unknown;
    try {
      new BrowserMeetingAdapter({
        meetingId: 'mtg_1',
        meetingUrl: 'https://meet.jit.si/x',
        driver: new JitsiDriver(),
        config,
        directory: DIRECTORY,
        probe: bareLinuxProbe(),
      });
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(MeetingAdapterUnavailableError);
    const message = (thrown as Error).message;
    for (const wanted of ['Xvfb', 'pactl', 'parec', 'pacat', 'Google Chrome', 'playwright-core']) {
      expect(message).toContain(wanted);
    }
    // And it says what to do instead.
    expect(message).toContain('LILY_MEETING_PLATFORM=local');
  });

  it('treats a non-Linux host as a blocker, not a missing package', () => {
    let thrown: unknown;
    try {
      new BrowserMeetingAdapter({
        meetingId: 'mtg_1',
        meetingUrl: 'https://meet.jit.si/x',
        driver: new JitsiDriver(),
        config,
        directory: DIRECTORY,
        probe: { ...readyLinuxProbe(), platform: 'win32' },
      });
    } catch (cause) {
      thrown = cause;
    }
    // The Windows dev machine's answer, and it points at the supported path.
    expect((thrown as Error).message).toMatch(/Linux only|"win32"/);
    expect((thrown as Error).message).toContain('local room');
  });
});

describe('a clean join', () => {
  it('walks the state machine and ends in the call', async () => {
    const { adapter, page } = harness(readyPage());

    const result = await adapter.join();

    expect(adapter.joinState).toBe('in-call');
    expect(result.meetingId).toBe('mtg_browser_test');
    expect(page.fills.map((fill) => fill.name)).toContain('nameInput');
    expect(page.clickedNames()).toContain('joinButton');

    await adapter.leave('meeting_ended');
  });

  it('joins under the configured AI display name, and nothing else', async () => {
    const { adapter, page } = harness(readyPage());
    await adapter.join();

    const nameFill = page.fills.find((fill) => fill.name === 'nameInput');
    expect(nameFill?.value).toBe(config.meeting.botDisplayName);
    expect(nameFill?.value).toMatch(/AI/i);

    await adapter.leave('meeting_ended');
  });

  it('announces itself in the room in writing, without being asked to', async () => {
    // Consent does not depend on the microphone working or on anyone reading
    // the participant list.
    const { adapter, page } = harness(readyPage());
    await adapter.join();

    const announcement = page.fills.find((fill) => fill.name === 'chatInput');
    expect(announcement).toBeDefined();
    expect(announcement?.value).toContain('AI assistant, not a person');
    expect(announcement?.value).toContain('removed by any host');

    await adapter.leave('meeting_ended');
  });

  it('carries the display name into the Jitsi URL as well as the field', async () => {
    const { adapter, page } = harness(readyPage());
    await adapter.join();

    const url = page.navigations[0] ?? '';
    expect(url).toContain('userInfo.displayName');
    expect(decodeURIComponent(url)).toContain(config.meeting.botDisplayName);

    await adapter.leave('meeting_ended');
  });
});

describe('Chrome is launched the way a meeting client expects', () => {
  it('is never headless, and is never given the fake audio device', async () => {
    const { adapter, launcher } = harness(readyPage());
    await adapter.join();

    const args = launcher.args.join(' ');
    // Headless is detected; that is the whole reason for Xvfb.
    expect(args).not.toContain('--headless');
    // The fake *device* emits a test tone. The fake *UI* grants the prompt.
    expect(args).not.toContain('--use-fake-device-for-media-stream');
    expect(args).toContain('--use-fake-ui-for-media-stream');

    await adapter.leave('meeting_ended');
  });

  it('points the desktop-capture auto-select at this meeting only', async () => {
    const { adapter, launcher } = harness(readyPage());
    await adapter.join();

    const args = launcher.args.join(' ');
    expect(args).toContain('--auto-select-desktop-capture-source=Lily board mtg_browser_test');

    await adapter.leave('meeting_ended');
  });

  it('uses the branded Chrome the probe found', async () => {
    const { adapter, launcher } = harness(readyPage());
    await adapter.join();
    expect(launcher.launches[0]?.executablePath).toBe('/usr/bin/google-chrome-stable');
    await adapter.leave('meeting_ended');
  });
});

describe('a post-join step must never end a live meeting', () => {
  it('survives an announcement it cannot deliver', async () => {
    // The exact live failure: in-call, and the chat control is unreachable.
    // It used to propagate out of join() and kill the meeting.
    const page = readyPage().hide('chatToggle').hide('chatInput');
    const { adapter, launcher } = harness(page);

    const result = await adapter.join();

    expect(adapter.joinState).toBe('in-call');
    expect(result.participants.length).toBeGreaterThan(0);
    expect(launcher.session.closed).toBe(false);

    await adapter.leave('meeting_ended');
  });

  it('does not let an undeliverable line out of speak()', async () => {
    // `SpeechScheduler.sayImmediately` does not catch, so a throw here reaches
    // session.start() and ends the process.
    const page = readyPage().hide('chatToggle').hide('chatInput');
    const { adapter } = harness(page);
    await adapter.join();

    await expect(adapter.speak({ kind: 'text', text: 'before we wrap up' })).resolves.toBeUndefined();

    await adapter.leave('meeting_ended');
  });

  it('still reports the failure rather than pretending it worked', async () => {
    // Degrading is not the same as lying: postChat itself stays honest, so a
    // caller that needs to know still can.
    const page = readyPage().hide('chatToggle').hide('chatInput');
    const { adapter } = harness(page);
    await adapter.join();

    await expect(adapter.postChat('did this arrive?')).rejects.toThrow(SelectorFailureError);

    await adapter.leave('meeting_ended');
  });

  it('closes the share window when the share click fails', async () => {
    // Otherwise a board of this meeting's action items stays on screen with
    // nothing sharing it, for the rest of the call.
    const page = readyPage();
    const { adapter, launcher } = harness(page);
    await adapter.join();

    await expect(adapter.startScreenshare('/board')).rejects.toThrow(SelectorFailureError);
    expect(launcher.session.extraPages.every((extra) => extra.isClosed())).toBe(true);

    await adapter.leave('meeting_ended');
  });
});

describe('an auto-hiding toolbar is not a vendor UI change', () => {
  it('wakes the toolbar with pointer movement before touching it', async () => {
    // Jitsi hides its toolbar after a few seconds without pointer movement, and
    // a driven browser never moves its pointer. The buttons are in the DOM and
    // not hittable, which is why chatToggle timed out 34s into a live call.
    const page = readyPage().hide('chatInput').showButAutoHidden('chatToggle');
    const { adapter } = harness(page);

    await adapter.join();

    expect(page.mouseMoves.length).toBeGreaterThanOrEqual(2);
    expect(page.wokenByPointer).toContain('chatToggle');
    expect(page.clickedNames()).toContain('chatToggle');

    await adapter.leave('meeting_ended');
  });

  it('moves to two different points, because a no-op move resets no timer', async () => {
    const page = readyPage().hide('chatInput').showButAutoHidden('chatToggle');
    const { adapter } = harness(page);
    await adapter.join();

    const [first, second] = page.mouseMoves;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toEqual(first);

    await adapter.leave('meeting_ended');
  });

  it('says "found but not interactable" when waking it does not help', async () => {
    // A modal on top, or something still animating in. The table is correct and
    // the message must not send anyone to edit it.
    const page = readyPage().hide('chatInput').showButBlocked('chatToggle');
    const { adapter } = harness(page);
    await adapter.join();

    let thrown: unknown;
    try {
      await adapter.postChat('hello');
    } catch (cause) {
      thrown = cause;
    }

    const error = thrown as SelectorFailureError;
    expect(error.resolution).toBe('not-interactable');
    expect(error.matchCount).toBeGreaterThan(0);
    expect(error.message).toContain('FOUND BUT NOT INTERACTABLE');
    expect(error.message).toContain('NOT a selector change');
    expect(error.message).toContain('revealToolbar');
    // And it must NOT be the "vendor renamed it" advice.
    expect(error.message).not.toContain('NOT FOUND');

    await adapter.leave('meeting_ended');
  });

  it('still says "not found" when the element genuinely is not there', async () => {
    const page = readyPage().hide('chatInput').hide('chatToggle');
    const { adapter } = harness(page);
    await adapter.join();

    let thrown: unknown;
    try {
      await adapter.postChat('hello');
    } catch (cause) {
      thrown = cause;
    }

    const error = thrown as SelectorFailureError;
    expect(error.resolution).toBe('not-found');
    expect(error.matchCount).toBe(0);
    expect(error.message).toContain('NOT FOUND');
    expect(error.message).toContain('SELECTORS table');

    await adapter.leave('meeting_ended');
  });
});

describe('a selector that stopped matching', () => {
  it('names the step, the selector and the state — not a CSS timeout', async () => {
    // The join button was renamed. Everything else is fine.
    const page = readyPage().hide('joinButton');
    const { adapter } = harness(page);

    let thrown: unknown;
    try {
      await adapter.join();
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(SelectorFailureError);
    const error = thrown as SelectorFailureError;

    expect(error.step).toBe('join');
    expect(error.selectorName).toBe('joinButton');
    expect(error.driverId).toBe('jitsi');
    // The state it was in when it failed, not the state it ended up in.
    expect(error.joinState).toBe('name-entry');

    const message = error.message;
    expect(message).toContain('step "join"');
    expect(message).toContain('joinButton');
    expect(message).toContain('SELECTORS table');
    // Nothing matched, so this genuinely is the "vendor moved it" case.
    expect(error.resolution).toBe('not-found');
    // The actual selector, so the fix is a copy-paste away.
    expect(message).toContain('data-testid="prejoin.joinMeeting"');
  });

  it('captures a screenshot and the page HTML, to disk and nowhere else', async () => {
    const page = readyPage().hide('nameInput');
    const { adapter } = harness(page);

    let thrown: unknown;
    try {
      await adapter.join();
    } catch (cause) {
      thrown = cause;
    }

    const error = thrown as SelectorFailureError;
    expect(error.selectorName).toBe('nameInput');
    expect(error.debugPaths.length).toBe(2);
    expect(error.debugPaths.some((path) => path.endsWith('.png'))).toBe(true);
    expect(error.debugPaths.some((path) => path.endsWith('.html'))).toBe(true);
    // Under the debug directory, never inside the repo.
    expect(error.debugPaths.every((path) => path.startsWith(debugDir))).toBe(true);
    expect(error.message).toContain('Page evidence written to');
  });

  it('captures evidence for a MID-CALL failure, while the page is still open', async () => {
    // This is when a screenshot is worth the most and it used to be worth
    // nothing: capture happened at teardown, so a mid-call failure reported
    // "no page evidence was captured (the page was already gone)".
    const page = readyPage().hide('chatInput').hide('chatToggle');
    const { adapter, launcher } = harness(page);
    await adapter.join();

    let thrown: unknown;
    try {
      await adapter.postChat('hello');
    } catch (cause) {
      thrown = cause;
    }

    const error = thrown as SelectorFailureError;
    expect(error.debugPaths).toHaveLength(2);
    expect(error.message).toContain('Page evidence written to');
    expect(error.message).not.toContain('page was already gone');
    // Still in the meeting; the capture did not tear anything down.
    expect(launcher.session.closed).toBe(false);
    expect(adapter.joinState).toBe('in-call');

    await adapter.leave('meeting_ended');
  });

  it('caps how many captures one meeting may write', async () => {
    // A moved chat button fails on every retry. Without a cap that is a disk
    // filling with screenshots of a live meeting.
    const page = readyPage().hide('chatInput').hide('chatToggle');
    const { adapter } = harness(page);
    await adapter.join(); // announce already consumed one

    const captureCounts: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await adapter.postChat('retry');
      } catch (cause) {
        captureCounts.push((cause as SelectorFailureError).debugPaths.length);
      }
    }

    expect(captureCounts).toHaveLength(8);
    // Some captured, then it stops. Never all eight.
    expect(captureCounts.filter((count) => count > 0).length).toBeLessThan(8);
    expect(captureCounts.at(-1)).toBe(0);

    await adapter.leave('meeting_ended');
  });

  it('tears the browser down rather than leaving it holding the process open', async () => {
    const { adapter, launcher } = harness(readyPage().hide('joinButton'));
    await adapter.join().catch(() => undefined);
    expect(launcher.session.closed).toBe(true);
    expect(adapter.joinState).toBe('failed');
  });

  it('refuses a selector name a driver did not declare', () => {
    // The table is the whole point; reaching past it must not be quiet.
    const driver = new JitsiDriver();
    const page = new FakeMeetingPage('jitsi', driver.selectors);
    expect(() => page.show('notInTheTable')).toThrow(/not in its SELECTORS table/);
  });
});

describe('the lobby is a state, not a hang', () => {
  it('reports the lobby, and says a person has to admit the guest', async () => {
    // Joined, sitting in "waiting for a moderator", and nobody clicks.
    const page = readyPage().show('lobbyIndicator').hide('inCallMarker');
    const { adapter } = harness(page, 30);

    let thrown: unknown;
    try {
      await adapter.join();
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(JoinStalledError);
    const message = (thrown as Error).message;
    expect(message).toContain('lobby');
    expect(message).toContain('This is a person, not a bug');
    expect(message).toContain('botDisplayName');
  });

  it('reports a refusal as final, not as something to retry', async () => {
    const page = readyPage().show('lobbyIndicator').show('deniedIndicator').hide('inCallMarker');
    const { adapter } = harness(page, 500);

    let thrown: unknown;
    try {
      await adapter.join();
    } catch (cause) {
      thrown = cause;
    }
    expect((thrown as Error).message).toContain('refused');
    expect((thrown as Error).message).toContain('nothing here retries a refusal');
  });
});

describe('the active speaker, resolved against the roster', () => {
  it('maps a known name to an employee and publishes the change', async () => {
    const { adapter, page, clock } = harness(readyPage());
    await adapter.join();

    const seen: Array<Participant | null> = [];
    adapter.onActiveSpeakerChange((participant) => seen.push(participant));

    page.show('dominantSpeakerName', { texts: ['Sarah Chen'] });
    // Two polls: the highlight has to hold before it counts.
    clock.advance(500);
    await flush();
    clock.advance(500);
    await flush();

    expect(adapter.activeSpeaker?.employeeId).toBe('emp_sarah');
    expect(seen.at(-1)?.displayName).toBe('Sarah Chen');

    await adapter.leave('meeting_ended');
  });

  it('reports a guest as present but unidentified, which is what denies', async () => {
    const { adapter, page, clock } = harness(readyPage());
    await adapter.join();

    page.show('dominantSpeakerName', { texts: ['Dana from Acme'] });
    clock.advance(500);
    await flush();
    clock.advance(500);
    await flush();

    expect(adapter.activeSpeaker).not.toBeNull();
    // The whole safety property: unknown is null, and the gate treats null as
    // "not a known employee".
    expect(adapter.activeSpeaker?.employeeId).toBeNull();

    await adapter.leave('meeting_ended');
  });

  it('never treats its own tile as a speaker', async () => {
    const { adapter, page, clock } = harness(readyPage());
    await adapter.join();

    page.show('dominantSpeakerName', { texts: [config.meeting.botDisplayName] });
    clock.advance(500);
    await flush();
    clock.advance(500);
    await flush();

    expect(adapter.activeSpeaker).toBeNull();

    await adapter.leave('meeting_ended');
  });

  it('attributes an emitted transcript to whoever is speaking, and to nobody when it cannot', async () => {
    const { adapter, page, clock } = harness(readyPage());
    await adapter.join();

    const heard: Array<{ employeeId: string | null; speakerName: string }> = [];
    adapter.onUtterance((utterance) =>
      heard.push({ employeeId: utterance.employeeId, speakerName: utterance.speakerName }),
    );

    adapter.emitUtterance('nobody is highlighted yet');
    expect(heard[0]).toEqual({ employeeId: null, speakerName: 'unidentified speaker' });

    page.show('dominantSpeakerName', { texts: ['John Rivera'] });
    clock.advance(500);
    await flush();
    clock.advance(500);
    await flush();

    adapter.emitUtterance('yes, go ahead');
    expect(heard[1]).toEqual({ employeeId: 'emp_john', speakerName: 'John Rivera' });

    await adapter.leave('meeting_ended');
  });
});

describe('she stays kickable', () => {
  it('treats removal as a normal leave path with its own reason', async () => {
    const { adapter, page, clock } = harness(readyPage());
    await adapter.join();

    const reasons: string[] = [];
    adapter.onMeetingEnd((reason) => reasons.push(reason));

    page.show('removedDialog');
    clock.advance(3_500);
    await flush(8);

    expect(reasons).toContain('kicked');
    expect(adapter.wasRemovedByHost).toBe(true);

    await adapter.leave('kicked');
  });

  it('never rejoins after being removed', async () => {
    const { adapter } = harness(readyPage());
    await adapter.join();
    await adapter.leave('kicked');

    await expect(adapter.join()).rejects.toThrow(/will not rejoin/);
  });

  it('does not click "leave" on the way out after being removed', async () => {
    // There is no leave button on a page that has already ejected us, and
    // clicking at it would only produce a selector failure on the exit path.
    const { adapter, page } = harness(readyPage());
    await adapter.join();
    const before = page.clickedNames().filter((name) => name === 'leaveButton').length;

    await adapter.leave('kicked');

    const after = page.clickedNames().filter((name) => name === 'leaveButton').length;
    expect(after).toBe(before);
  });
});

describe('leaving', () => {
  it('hangs up, closes the browser and stops the local surface', async () => {
    const { adapter, page, launcher } = harness(readyPage());
    await adapter.join();

    await adapter.leave('meeting_ended');

    expect(page.clickedNames()).toContain('leaveButton');
    expect(launcher.session.closed).toBe(true);
    expect(adapter.joinState).toBe('left');
    expect(adapter.polling).toBe(false);
  });

  it('is idempotent', async () => {
    const { adapter } = harness(readyPage());
    await adapter.join();
    await adapter.leave('meeting_ended');
    await expect(adapter.leave('silence')).resolves.toBeUndefined();
  });
});

describe('the roster the adapter reports', () => {
  it('lists everyone it can see, with employees resolved and guests not', async () => {
    const page = readyPage().setTexts('participantNames', [
      'Sarah Chen',
      'Dana from Acme',
      'Lily (AI assistant)',
    ]);
    const { adapter } = harness(page);
    await adapter.join();

    const participants = await adapter.getParticipants();
    const byName = new Map(participants.map((p) => [p.displayName, p]));

    expect(byName.get('Sarah Chen')?.employeeId).toBe('emp_sarah');
    expect(byName.get('Dana from Acme')?.employeeId).toBeNull();
    expect(byName.get(config.meeting.botDisplayName)?.isBot).toBe(true);

    await adapter.leave('meeting_ended');
  });
});

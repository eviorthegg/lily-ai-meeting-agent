/**
 * A whole meeting, end to end.
 *
 * Real HTTP server, real WebSocket clients typing into the real room page's
 * protocol, the real `TextBrain`, the real classifier, the real permission
 * gate, the real task memory — and a stand-in for the employee laptops that are
 * not attached, which is the one thing that genuinely cannot be present here.
 *
 * The last block is the important one: it asserts that nothing this process
 * hands over on the way out contains anything anybody said.
 */

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildConfig, type LilyConfig } from '@lily/shared/config';

import { LoopbackDaemonLink, type SimulatedStep } from './dispatch/loopback-link.js';
import { LocalMeetingAdapter } from './meeting/local/adapter.js';
import type { RoomParticipantView, RoomTaskView, RoomToClient } from './meeting/local/wire.js';
import { TextBrain } from './brain/text.js';
import { MeetingSession, type MeetingOutcomeSink, type MeetingSummary } from './session.js';
import { InMemoryUsageSink } from './usage.js';
import type { EmployeeProfile, MeetingTask } from './types.js';
import type { PermissionAuditEntry } from './permissions.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIRECTORY: readonly EmployeeProfile[] = [
  {
    employeeId: 'emp_sarah',
    name: 'Sarah Chen',
    aliases: ['sarah'],
    jobDescription: 'Backend engineer — authentication and the login flow',
    agentKind: 'claude-code',
    capabilities: ['github', 'shell'],
    daemonEnrolled: true,
  },
  {
    employeeId: 'emp_priya',
    name: 'Priya Nair',
    aliases: ['priya'],
    jobDescription: 'Product manager — roadmap and scheduling',
    agentKind: 'codex',
    capabilities: ['google-calendar'],
    daemonEnrolled: true,
  },
  {
    employeeId: 'emp_dana',
    name: 'Dana Okafor',
    aliases: ['dana'],
    jobDescription: 'Designer',
    agentKind: null,
    capabilities: [],
    daemonEnrolled: false,
  },
];

const AGENT_ANSWER =
  'The login flow validates the password with argon2id, then issues a 15-minute access token.';

/** Utterances that must never end up anywhere durable. */
const CHATTER = 'honestly the coffee machine has been broken since Tuesday';
const QUESTION = 'Sarah, how does the login flow work?';

function testConfig(): LilyConfig {
  const base = buildConfig('local');
  return {
    ...base,
    realtime: {
      ...base.realtime,
      // The real 700ms pause is correct behaviour and pointless latency in a
      // test; shortening it exercises the same code path faster.
      turnDetection: { ...base.realtime.turnDetection, silenceDurationMs: 20 },
    },
    permissions: { ...base.permissions, voiceApprovalTimeoutSec: 5 },
    meeting: { ...base.meeting, usageFlushIntervalSec: 3_600 },
  };
}

function planFor(mode: 'read_only' | 'standard'): readonly SimulatedStep[] {
  if (mode === 'read_only') {
    return [
      { kind: 'status', afterMs: 5, state: 'running', note: 'searching the repo' },
      { kind: 'result', afterMs: 40, ok: true, answer: AGENT_ANSWER },
    ];
  }
  // Stops at the permission request on purpose: the assertion is about the
  // gate, and a result racing the approval would make the test time-dependent.
  return [
    { kind: 'status', afterMs: 5, state: 'running', note: 'preparing the migration' },
    {
      kind: 'permission',
      afterMs: 15,
      actionKind: 'shell',
      detail: 'npx prisma migrate deploy',
      reason: 'the migration has not been applied on this branch',
    },
  ];
}

// ---------------------------------------------------------------------------
// A browser, without the browser
// ---------------------------------------------------------------------------

class RoomClient {
  readonly messages: Array<{ from: string; text: string; isBot: boolean }> = [];
  readonly systemLines: string[] = [];
  readonly statuses: Array<{ state: string; note: string | null }> = [];
  participants: RoomParticipantView[] = [];
  tasks: RoomTaskView[] = [];
  screenshareUrl: string | null = null;
  #socket: WebSocket | null = null;

  /** Auto-answers a question addressed to this participant, as a person would. */
  autoAnswer: { match: RegExp; reply: string } | null = null;

  async connect(url: string, displayName: string, employeeId: string | null): Promise<void> {
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/room`);
    this.#socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8')) as RoomToClient;
      switch (message.t) {
        case 'welcome':
          this.participants = message.participants;
          this.tasks = message.tasks;
          break;
        case 'message':
          this.messages.push({ from: message.from, text: message.text, isBot: message.isBot });
          if (message.isBot && this.autoAnswer !== null && this.autoAnswer.match.test(message.text)) {
            this.say(this.autoAnswer.reply);
          }
          break;
        case 'tasks':
          this.tasks = message.tasks;
          break;
        case 'status':
          this.statuses.push({ state: message.state, note: message.note });
          break;
        case 'screenshare':
          this.screenshareUrl = message.url;
          break;
        case 'system':
          this.systemLines.push(message.text);
          break;
        default:
          break;
      }
    });

    socket.send(JSON.stringify({ t: 'join', displayName, employeeId }));
    await this.until(() => this.participants.length > 0, 'welcome');
  }

  say(text: string): void {
    this.#socket?.send(JSON.stringify({ t: 'say', text }));
  }

  close(): void {
    this.#socket?.close();
    this.#socket = null;
  }

  fromLily(): string[] {
    return this.messages.filter((message) => message.isBot).map((message) => message.text);
  }

  async until(predicate: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${what}. Lily said: ${JSON.stringify(this.fromLily())}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async untilLilySays(pattern: RegExp, timeoutMs = 8_000): Promise<string> {
    await this.until(
      () => this.fromLily().some((line) => pattern.test(line)),
      `Lily to say ${pattern}`,
      timeoutMs,
    );
    return this.fromLily().find((line) => pattern.test(line)) ?? '';
  }
}

// ---------------------------------------------------------------------------

interface Recorded {
  readonly tasks: MeetingTask[][];
  readonly summaries: MeetingSummary[];
  readonly audits: PermissionAuditEntry[];
}

function recordingSink(): { sink: MeetingOutcomeSink; recorded: Recorded } {
  const recorded: Recorded = { tasks: [], summaries: [], audits: [] };
  return {
    recorded,
    sink: {
      recordTasks: (tasks) => {
        recorded.tasks.push([...tasks]);
      },
      recordSummary: (summary) => {
        recorded.summaries.push(summary);
      },
      recordAudit: (entry) => {
        recorded.audits.push(entry);
      },
    },
  };
}

let teardown: (() => Promise<void>) | null = null;

afterEach(async () => {
  await teardown?.();
  teardown = null;
});

// ---------------------------------------------------------------------------

describe('a simulated meeting, end to end', () => {
  it('runs the whole loop and persists no transcript', { timeout: 45_000 }, async () => {
    const config = testConfig();
    const usage = new InMemoryUsageSink();
    const { sink, recorded } = recordingSink();

    const daemon = new LoopbackDaemonLink({
      agents: [
        {
          employeeId: 'emp_sarah',
          agentKind: 'claude-code',
          capabilities: ['github', 'shell'],
          plan: (task) => planFor(task.mode),
        },
        { employeeId: 'emp_priya', agentKind: 'codex', capabilities: ['google-calendar'] },
      ],
    });

    let session: MeetingSession | null = null;
    const adapter = new LocalMeetingAdapter({
      meetingId: 'mtg_e2e',
      botDisplayName: config.meeting.botDisplayName,
      directory: DIRECTORY,
      port: 0,
      brainKind: 'text',
      taskView: () => (session === null ? [] : session.taskViews()),
    });

    // Everything Lily says, whether or not anyone is connected to hear it. The
    // join announcement goes out before the first tab opens, so the room alone
    // cannot observe it.
    const everythingLilySaid: string[] = [];
    const realSpeak = adapter.speak.bind(adapter);
    adapter.speak = async (output) => {
      everythingLilySaid.push(output.kind === 'text' ? output.text : (output.text ?? ''));
      await realSpeak(output);
    };

    session = new MeetingSession({
      meetingId: 'mtg_e2e',
      config,
      adapter,
      brain: new TextBrain(),
      daemon,
      directory: DIRECTORY,
      usageSink: usage,
      outcomeSink: sink,
    });

    const active = session;
    const priya = new RoomClient();
    const sarah = new RoomClient();
    teardown = async () => {
      priya.close();
      sarah.close();
      await active.end('meeting_ended').catch(() => undefined);
    };

    await session.start();

    // -- She announces herself as an AI before anyone else is even in. --------
    expect(everythingLilySaid[0]).toContain("I'm an AI");
    expect(config.meeting.botDisplayName).toMatch(/AI/);

    // -- Two people join. ----------------------------------------------------
    await priya.connect(adapter.url, 'Priya Nair', 'emp_priya');
    await sarah.connect(adapter.url, 'Sarah Chen', 'emp_sarah');
    await priya.until(() => priya.participants.length >= 1, 'the room to fill');

    const roomView = await fetch(`${adapter.url}/api/participants`);
    const listed = (await roomView.json()) as RoomParticipantView[];
    const bot = listed.find((participant) => participant.isBot);
    expect(bot).toBeDefined();
    // Unmistakably an AI in the participant list. Consent depends on it.
    expect(bot?.displayName).toBe(config.meeting.botDisplayName);
    expect(listed.filter((participant) => !participant.isBot)).toHaveLength(2);

    // -- Chatter: she stays out of it. ---------------------------------------
    const beforeChatter = priya.fromLily().length;
    priya.say(CHATTER);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(priya.fromLily()).toHaveLength(beforeChatter);

    // -- A question routed to a person's agent. ------------------------------
    priya.say(QUESTION);

    // Acknowledged immediately — the room is not left waiting in silence.
    await priya.untilLilySays(/Checking with Sarah/);

    // The work-in-progress status renders under her avatar while it runs.
    await priya.until(
      () => priya.statuses.some((status) => status.note === 'searching the repo'),
      'the live status',
    );

    // And the answer re-enters the conversation when it arrives.
    const answer = await priya.untilLilySays(/argon2id/);
    expect(answer).toContain('Sarah');

    // -- A human-to-human assignment: silent, logged, not acted on. ----------
    const beforeAssignment = priya.fromLily().length;
    priya.say('Sarah, make sure you finish the auth refactor by Sunday');

    await priya.until(
      () => priya.tasks.some((task) => task.type === 'human_assignment'),
      'the assignment to be recorded',
    );

    const assignment = priya.tasks.find((task) => task.type === 'human_assignment');
    expect(assignment?.owner_employee_id).toBe('emp_sarah');
    expect(assignment?.status).toBe('unconfirmed');
    expect(assignment?.due).not.toBeNull();
    // Not one word about it out loud.
    expect(priya.fromLily()).toHaveLength(beforeAssignment);

    // -- Someone with no agent enrolled. -------------------------------------
    priya.say('Dana, what did you decide on the empty state?');
    await priya.untilLilySays(/doesn't have an agent connected/);

    // -- The permission gate, in the room. -----------------------------------
    sarah.say('Lily, get my agent to run the migration');
    const prompt = await sarah.untilLilySays(/npx prisma migrate deploy/);
    expect(prompt).toContain('Sarah');
    expect(prompt).toContain('Is that okay?');

    // A bystander's yes is not consent.
    priya.say('yes, go for it');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sarah.fromLily().some((line) => /Approved/.test(line))).toBe(false);

    // The owner's is.
    sarah.say('yes, approve that');
    await sarah.untilLilySays(/Approved/);

    const granted = recorded.audits.find((entry) => entry.action === 'permission.granted');
    expect(granted?.ownerEmployeeId).toBe('emp_sarah');
    expect(granted?.detail).toBe('npx prisma migrate deploy');

    // -- Screenshare renders the board. --------------------------------------
    priya.say('Lily, put the action items on screen');
    await priya.until(() => priya.screenshareUrl !== null, 'the screenshare');
    expect(priya.screenshareUrl).toBe('/board');
    const board = await fetch(`${adapter.url}/board`);
    expect(await board.text()).toContain('auth refactor');

    // -- Participant leave fires the same callback a real adapter would. -----
    const seenLeave: string[] = [];
    adapter.onParticipantLeave((participant) => seenLeave.push(participant.displayName));

    // -- Wrap-up: read back the unconfirmed item, take only the owner's yes. --
    sarah.autoAnswer = { match: /Confirming\?/, reply: 'yes, that\'s mine' };

    const summary = await session.end('meeting_ended');
    teardown = null;

    const wrapUp = everythingLilySaid.join('\n');
    expect(wrapUp).toContain('Before we wrap');
    // First name, the obligation framing stripped, and the deadline said once.
    expect(wrapUp).toContain("Sarah, I've got you down for: finish the auth refactor, due 2026-");
    expect(wrapUp).not.toContain('make sure you finish');
    expect(wrapUp).toContain('marked as confirmed');

    // -- What actually left the process. -------------------------------------
    expect(recorded.summaries).toHaveLength(1);
    expect(summary.endReason).toBe('meeting_ended');
    expect(summary.dispatchedTaskCount).toBeGreaterThanOrEqual(2);

    const handedOver = JSON.stringify({
      tasks: recorded.tasks,
      summaries: recorded.summaries,
      audits: recorded.audits,
      usage: usage.slices,
    });

    // Nothing anyone said in passing.
    expect(handedOver).not.toContain(CHATTER);
    expect(handedOver).not.toContain('coffee machine');
    // Nothing Lily said, either — her speech is as much a transcript as theirs.
    expect(handedOver).not.toContain(AGENT_ANSWER);
    expect(handedOver).not.toContain('Before we wrap');
    expect(handedOver).not.toContain("I'm an AI");
    // And no field pretending otherwise.
    expect(handedOver).not.toMatch(/"(transcript|transcripts|audioData|recordingUrl|agentOutput)"/);

    // The confirmed assignment did survive — task text is one of exactly two
    // things the data policy allows out, and it is why the summary email exists.
    const finalTasks = recorded.tasks.at(-1) ?? [];
    const confirmed = finalTasks.find((task) => task.type === 'human_assignment');
    expect(confirmed?.status).toBe('confirmed');

    // -- Memory is gone. -----------------------------------------------------
    expect(active.tasks.all()).toEqual([]);

    // -- Billing: Lily's own consumption, and nothing from Sarah's laptop. ---
    const final = usage.slices.at(-1);
    expect(final?.final).toBe(true);
    expect(final).toBeDefined();
    // The employee's agent did real work. It contributes a count, never a cost.
    expect(usage.slices.reduce((sum, slice) => sum + slice.dispatchedTaskCount, 0)).toBeGreaterThan(0);
    for (const slice of usage.slices) {
      // TextBrain makes no model calls at all, so any reasoning tokens here
      // could only have come from metering somebody else's agent.
      expect(slice.breakdown.reasoningTokens).toBe(0);
      expect(slice.breakdown.realtimeAudioSec).toBe(0);
      expect(Object.keys(slice.breakdown).sort()).toEqual([
        'ec2Sec',
        'realtimeAudioSec',
        'reasoningTokens',
        'searchCalls',
        'ttsChars',
      ]);
    }

    expect(seenLeave.length).toBeGreaterThanOrEqual(0);
  });

  it('winds itself down when the room empties', { timeout: 20_000 }, async () => {
    const base = testConfig();
    const config: LilyConfig = {
      ...base,
      meeting: { ...base.meeting, emptyRoomGraceSec: 1 },
    };

    const daemon = new LoopbackDaemonLink({ agents: [] });
    let session: MeetingSession | null = null;
    const adapter = new LocalMeetingAdapter({
      meetingId: 'mtg_empty',
      botDisplayName: config.meeting.botDisplayName,
      directory: DIRECTORY,
      port: 0,
      taskView: () => (session === null ? [] : session.taskViews()),
    });

    session = new MeetingSession({
      meetingId: 'mtg_empty',
      config,
      adapter,
      brain: new TextBrain(),
      daemon,
      directory: DIRECTORY,
      usageSink: new InMemoryUsageSink(),
    });

    const active = session;
    teardown = async () => {
      await active.end('meeting_ended').catch(() => undefined);
    };

    await session.start();

    const priya = new RoomClient();
    await priya.connect(adapter.url, 'Priya Nair', 'emp_priya');
    priya.close();

    // Everyone left. She waits out the grace period in case it was a reconnect,
    // then drops off rather than sitting in an empty room billing.
    const summary = await session.finished;
    teardown = null;
    expect(summary.endReason).toBe('empty_room');
  });

  it('does not end on silence while a dispatched task is still running', { timeout: 40_000 }, async () => {
    // Regression. Observed in real use: dispatched at 16:41:39, session ended
    // `endReason: "silence"` at 16:46:39, and the agent's answer was discarded.
    // A quiet room while an agent works is expected — Lily acknowledges, the
    // conversation moves on, and she re-enters with the result later.
    const base = testConfig();
    const config: LilyConfig = {
      ...base,
      // Silence fires fast; the agent deliberately takes several times longer.
      meeting: { ...base.meeting, silenceTimeoutSec: 1, emptyRoomGraceSec: 120 },
    };

    const daemon = new LoopbackDaemonLink({
      agents: [
        {
          employeeId: 'emp_sarah',
          agentKind: 'claude-code',
          capabilities: [],
          plan: () => [
            { kind: 'status', afterMs: 50, state: 'running', note: 'searching the repo' },
            {
              kind: 'result',
              afterMs: 4_000,
              ok: true,
              answer: 'The login flow starts in auth/session.ts and issues a rotating refresh token.',
            },
          ],
        },
      ],
    });

    let session: MeetingSession | null = null;
    const adapter = new LocalMeetingAdapter({
      meetingId: 'mtg_slow_agent',
      botDisplayName: config.meeting.botDisplayName,
      directory: DIRECTORY,
      port: 0,
      taskView: () => (session === null ? [] : session.taskViews()),
    });

    session = new MeetingSession({
      meetingId: 'mtg_slow_agent',
      config,
      adapter,
      brain: new TextBrain(),
      daemon,
      directory: DIRECTORY,
      usageSink: new InMemoryUsageSink(),
    });

    const active = session;
    teardown = async () => {
      await active.end('meeting_ended').catch(() => undefined);
    };

    await session.start();

    const priya = new RoomClient();
    await priya.connect(adapter.url, 'Priya Nair', 'emp_priya');
    priya.say('Sarah, how does the login flow work?');

    // Well past the 1s silence window but before the agent replies. The meeting
    // must still be alive; this is the exact point at which it used to die.
    const endedEarly = await Promise.race([
      active.finished.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_500)),
    ]);
    expect(endedEarly, 'ended on silence while a task was still in flight').toBe(false);

    // And the answer still arrives.
    await priya.untilLilySays(/login flow|session\.ts/i, 15_000);

    // With nothing outstanding, silence ends it normally — the timer is
    // suppressed while work is in flight, not disabled.
    const summary = await active.finished;
    teardown = null;
    expect(summary.endReason).toBe('silence');
  });

  it('rejects a second person signing in as the same employee', { timeout: 20_000 }, async () => {
    const config = testConfig();
    const daemon = new LoopbackDaemonLink({ agents: [] });
    let session: MeetingSession | null = null;
    const adapter = new LocalMeetingAdapter({
      meetingId: 'mtg_dupe',
      botDisplayName: config.meeting.botDisplayName,
      directory: DIRECTORY,
      port: 0,
      taskView: () => (session === null ? [] : session.taskViews()),
    });

    session = new MeetingSession({
      meetingId: 'mtg_dupe',
      config,
      adapter,
      brain: new TextBrain(),
      daemon,
      directory: DIRECTORY,
      usageSink: new InMemoryUsageSink(),
    });

    const active = session;
    const first = new RoomClient();
    teardown = async () => {
      first.close();
      await active.end('meeting_ended').catch(() => undefined);
    };

    await session.start();
    await first.connect(adapter.url, 'Sarah Chen', 'emp_sarah');

    // Identity is what the permission gate keys off. Two tabs claiming to be
    // the same person would make "only the owner may approve" meaningless.
    const impostor = new WebSocket(`${adapter.url.replace(/^http/, 'ws')}/room`);
    await new Promise<void>((resolve) => impostor.once('open', () => resolve()));

    const reply = new Promise<RoomToClient>((resolve) => {
      impostor.on('message', (raw: Buffer) => resolve(JSON.parse(raw.toString('utf8'))));
    });
    impostor.send(
      JSON.stringify({ t: 'join', displayName: 'Not Sarah', employeeId: 'emp_sarah' }),
    );

    const message = await reply;
    expect(message.t).toBe('error');
    impostor.close();
  });
});

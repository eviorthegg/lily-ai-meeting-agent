/**
 * Orchestrator entry point.
 *
 * One process, one meeting. Started as a detached child locally (see
 * `LocalOrchestratorLauncher` in @lily/shared) and as an EC2 instance in
 * deployed stages, with the same argument surface either way: everything
 * arrives through the environment, and the process exits when the meeting ends.
 */

import { getConfig, type LilyConfig } from '@lily/shared/config';
import { AwsSecretsProvider, LocalSecretsProvider, type SecretsProvider } from '@lily/shared/providers';

import { RealtimeBrain } from './brain/realtime.js';
import { TextBrain } from './brain/text.js';
import type { LilyBrain } from './brain/types.js';
import { loadRoster } from './demo/roster.js';
import { CompositeDaemonLink } from './dispatch/composite-link.js';
import { LoopbackDaemonLink, type SimulatedAgent } from './dispatch/loopback-link.js';
import { WsDaemonLink } from './dispatch/ws-link.js';
import type { DaemonLink } from './dispatch/link.js';
import { LocalMeetingAdapter } from './meeting/local/adapter.js';
import { createJitsiMeetingAdapter } from './meeting/jitsi/index.js';
import { createMeetMeetingAdapter } from './meeting/meet/index.js';
import { createTeamsMeetingAdapter } from './meeting/teams/index.js';
import { createZoomMeetingAdapter } from './meeting/zoom/index.js';
import type { MeetingAdapter, MeetingPlatform } from './meeting/adapter.js';
import type { RoomTaskView } from './meeting/local/wire.js';
import { Roster } from './roster.js';
import { MeetingSession } from './session.js';
import type { EmployeeProfile } from './types.js';
import { InMemoryUsageSink } from './usage.js';
import { newMeetingId } from './util/ids.js';
import { errorField, log } from './util/log.js';

function env(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

function secretsFor(config: LilyConfig): SecretsProvider {
  // Only the secrets provider is needed here, so the full `createProviders`
  // bundle is skipped: it requires mail and WebSocket configuration the
  // orchestrator has no use for and would fail on.
  return config.stage === 'local'
    ? new LocalSecretsProvider()
    : new AwsSecretsProvider({ region: config.region });
}

function resolvePlatform(): MeetingPlatform {
  const raw = env('LILY_MEETING_PLATFORM') ?? 'local';
  if (raw === 'local' || raw === 'zoom' || raw === 'meet' || raw === 'teams' || raw === 'jitsi') {
    return raw;
  }
  throw new Error(
    `LILY_MEETING_PLATFORM is "${raw}". Expected one of: local, jitsi, zoom, meet, teams.`,
  );
}

function buildAdapter(
  platform: MeetingPlatform,
  meetingId: string,
  config: LilyConfig,
  directory: readonly EmployeeProfile[],
  brainKind: string,
  taskView: () => readonly RoomTaskView[],
): MeetingAdapter {
  const botDisplayName = config.meeting.botDisplayName;

  switch (platform) {
    case 'local': {
      const port = Number(env('LILY_ROOM_PORT') ?? '4100');
      return new LocalMeetingAdapter({
        meetingId,
        botDisplayName,
        directory,
        port,
        host: env('LILY_ROOM_HOST') ?? '127.0.0.1',
        brainKind,
        taskView,
      });
    }

    // The three real platforms are all the same adapter now: a real browser
    // joining the web client as a guest. They differ only in which driver —
    // that is, which selector table — is handed to it.
    case 'jitsi':
      return createJitsiMeetingAdapter({
        meetingId,
        meetingUrl: env('LILY_MEETING_URL') ?? '',
        config,
        directory,
        taskView,
      });

    case 'zoom': {
      const link = env('LILY_MEETING_URL') ?? env('LILY_ZOOM_MEETING_NUMBER');
      if (link === null) {
        throw new Error(
          'LILY_MEETING_URL (a Zoom join link) or LILY_ZOOM_MEETING_NUMBER is required for the ' +
            'zoom platform.',
        );
      }
      return createZoomMeetingAdapter({ meetingId, meetingUrl: link, config, directory, taskView });
    }

    case 'teams': {
      const joinUrl = env('LILY_MEETING_URL');
      if (joinUrl === null) {
        throw new Error('LILY_MEETING_URL is required for the teams platform.');
      }
      return createTeamsMeetingAdapter({ meetingId, joinUrl, config, directory, taskView });
    }

    case 'meet':
      return createMeetMeetingAdapter({
        meetingId,
        meetingUrl: env('LILY_MEETING_URL') ?? '',
        config,
        directory,
        taskView,
      });
  }
}

async function buildBrain(
  config: LilyConfig,
  adapter: MeetingAdapter,
  roster: Roster,
): Promise<LilyBrain> {
  const requested = env('LILY_BRAIN');

  // A platform that cannot carry audio cannot run the realtime brain, and
  // saying so beats connecting to OpenAI and discovering it mid-meeting.
  if (requested === 'text' || (requested === null && !adapter.capabilities.audio)) {
    return new TextBrain();
  }

  const secrets = secretsFor(config);
  let apiKey: string;
  try {
    apiKey = await secrets.get(`lily/${config.stage}/openai-api-key`);
  } catch (cause) {
    if (requested === 'realtime') throw cause;
    log.warn('brain.falling_back_to_text', { reason: errorField(cause) });
    return new TextBrain();
  }

  return new RealtimeBrain({
    apiKey,
    realtime: config.realtime,
    roster,
    botDisplayName: config.meeting.botDisplayName,
  });
}

/**
 * Simulated agents for everyone whose real daemon is not here.
 *
 * Off with `LILY_SIMULATE_AGENTS=0`, which is the right setting for testing a
 * real daemon in isolation: with simulation on, a real agent that fails to
 * connect is silently covered for.
 */
function buildSimulatedAgents(directory: readonly EmployeeProfile[]): SimulatedAgent[] {
  return directory
    .filter((employee) => employee.daemonEnrolled)
    .map((employee) => ({
      employeeId: employee.employeeId,
      agentKind: employee.agentKind ?? 'claude-code',
      capabilities: employee.capabilities,
    }));
}

/**
 * Things that hold the event loop open and must be released if startup fails
 * partway. Registered in the order they are opened.
 */
const openResources: Array<() => Promise<void>> = [];

async function main(): Promise<void> {
  const base = getConfig();

  // The launcher caps the meeting; policy caps it harder. Whichever is lower wins.
  const cap = Number(env('LILY_MAX_DURATION_SEC') ?? '0');
  const config: LilyConfig =
    Number.isFinite(cap) && cap > 0
      ? {
          ...base,
          meeting: { ...base.meeting, maxDurationSec: Math.min(cap, base.meeting.maxDurationSec) },
        }
      : base;

  const meetingId = env('LILY_MEETING_ID') ?? newMeetingId();
  const platform = resolvePlatform();
  const directory = loadRoster();
  const roster = new Roster(directory, config.meeting.botDisplayName);

  // Everything that can fail on configuration alone happens before any socket
  // is opened. An unavailable platform adapter has to exit the process, and a
  // listening server would keep it alive instead — a startup error that hangs
  // is worse than one that crashes, because nothing is watching it.
  //
  // `session` is bound late: the adapter needs a task view and the session
  // needs the adapter, so one of the two has to be.
  let session: MeetingSession | null = null;

  const adapter = buildAdapter(platform, meetingId, config, directory, env('LILY_BRAIN') ?? 'text', () =>
    session === null ? [] : session.taskViews(),
  );

  const brain = await buildBrain(config, adapter, roster);
  if (adapter instanceof LocalMeetingAdapter) adapter.setBrainKind(brain.kind);

  // The daemon endpoint is a separate port because in a deployed stage it is a
  // separate host entirely: daemons connect to the API's WebSocket, not to the
  // orchestrator. Locally the hop adds nothing, so they dial this directly.
  const wsLink = new WsDaemonLink({
    port: Number(env('LILY_DAEMON_PORT') ?? '4101'),
    host: env('LILY_DAEMON_HOST') ?? '127.0.0.1',
    authorize: ({ employeeId }) => roster.byId(employeeId) !== null,
  });
  await wsLink.listen();
  openResources.push(() => wsLink.close());

  const simulate = env('LILY_SIMULATE_AGENTS') !== '0';
  const daemon: DaemonLink = simulate
    ? new CompositeDaemonLink(
        wsLink,
        new LoopbackDaemonLink({ agents: buildSimulatedAgents(directory) }),
      )
    : wsLink;

  session = new MeetingSession({
    meetingId,
    config,
    adapter,
    brain,
    daemon,
    directory,
    usageSink: new InMemoryUsageSink(),
    ...(env('LILY_DISPATCH_DEADLINE_SEC') === null
      ? {}
      : { dispatchDeadlineSec: Number(env('LILY_DISPATCH_DEADLINE_SEC')) }),
  });

  const active = session;
  const shutdown = (signal: string): void => {
    log.info('orchestrator.signal', { signal });
    // SIGTERM is how the launcher ends a meeting, and the shutdown path has to
    // run: leave the call cleanly, read back what is unconfirmed, flush usage.
    void active.end('meeting_ended');
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await session.start();

  if (adapter instanceof LocalMeetingAdapter) {
    process.stdout.write(
      `\n  Lily's meeting room is up.\n\n` +
        `    Room       ${adapter.url}\n` +
        `    Board      ${adapter.url}/board\n` +
        `    Daemons    ${wsLink.url}\n` +
        `    Brain      ${brain.kind}\n` +
        `    Agents     ${daemon.connectedEmployees().length} connected` +
        `${simulate ? ' (simulated where no real daemon is attached)' : ''}\n\n` +
        `  Open the room in two tabs to see it as two people.\n\n`,
    );
  }

  const summary = await session.finished;
  log.info('orchestrator.finished', {
    meetingId: summary.meetingId,
    durationSec: summary.durationSec,
    endReason: summary.endReason,
    taskCount: summary.taskCount,
    unconfirmedCount: summary.unconfirmedCount,
    dispatchedTaskCount: summary.dispatchedTaskCount,
  });
}

main().catch(async (cause: unknown) => {
  // Adapter construction failures land here, and their messages name exactly
  // what is missing — print it whole rather than reducing it to one line.
  process.stderr.write(`\n${cause instanceof Error ? cause.message : String(cause)}\n\n`);
  log.error('orchestrator.fatal', { error: errorField(cause) });
  process.exitCode = 1;

  // Release anything already listening, so the process actually exits rather
  // than hanging on an open server with a failure nobody can see.
  for (const release of openResources.reverse()) {
    await release().catch(() => undefined);
  }
});

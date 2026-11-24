#!/usr/bin/env node
import { getConfig } from '@lily/shared';
import { resolveAdapter, NoAgentError } from './agents/index.js';
import { detectAgents } from './agents/detect.js';
import {
  ConfigError,
  configPath,
  expandHome,
  loadConfig,
  readDeviceToken,
  saveConfig,
  writeDeviceToken,
  type DaemonConfig,
} from './config.js';
import { DaemonConnection } from './connection.js';
import { log } from './log.js';
import { TaskRunner } from './tasks.js';
import { UiServer } from './ui/server.js';
import { DAEMON_VERSION } from './version.js';

/**
 * Daemon entrypoint.
 *
 *   run                     connect and serve dispatched tasks
 *   enroll --token <token>  exchange a one-time install token for a device token
 *   detect [--json]         list installed agents (the install scripts parse --json)
 *   doctor                  diagnose a broken install without connecting
 */

type Argv = readonly string[];

function flag(argv: Argv, name: string): boolean {
  return argv.includes(`--${name}`);
}

function option(argv: Argv, name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function platform(): 'darwin' | 'linux' | 'win32' {
  const value = process.platform;
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value;
  // Anything else is close enough to Linux here, and reporting an unrecognised
  // platform upstream would fail protocol validation on the server.
  return 'linux';
}

function workspaceFor(config: DaemonConfig): string {
  return expandHome(config.workspace ?? process.cwd());
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function run(): Promise<number> {
  const config = await loadConfig();
  if (config === null) {
    console.error(
      `Not enrolled — no config at ${configPath()}.\n` +
        `Use the install link from your invite email, or: lily-daemon enroll --token <token>`,
    );
    return 1;
  }

  let adapter;
  try {
    adapter = await resolveAdapter(config);
  } catch (error) {
    if (error instanceof NoAgentError) {
      console.error(`${error.message}\n\nRun \`lily-daemon detect\` to see what is installed.`);
      return 1;
    }
    throw error;
  }

  // Names only — what the agent can reach, never what it can see. Lily routes on
  // this, so an empty list is worth surfacing rather than passing silently.
  const capabilities = await adapter.capabilities();
  if (capabilities.length === 0) {
    log.info('agent.no_capabilities', { kind: adapter.kind });
  }

  // DND is employee-owned and persisted, so a reboot cannot quietly re-enrol
  // someone into dispatch. Held in memory and written through on change.
  let dnd = config.dnd;
  const isDnd = () => dnd;

  // `connection` and `runner` refer to each other — the runner sends through the
  // connection, the connection routes inbound frames into the runner. The
  // runner's callbacks close over `connection` before it is declared, which is
  // safe because they only run once both exist.
  const runner = new TaskRunner({
    adapter,
    workspace: workspaceFor(config),
    isDnd,
    sendStatus: (taskId, state, note) => {
      connection?.sendStatus(taskId, state, note);
    },
    sendResult: (result) => {
      connection?.sendResult(result);
    },
    sendPermissionRequest: (request) => {
      connection?.sendPermissionRequest(request);
    },
  });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info('daemon.shutdown', { code });
    runner.cancelAll('meeting_ended');
    connection?.stop();
    await ui?.stop();
    process.exit(code);
  };

  const connection = new DaemonConnection({
    wsUrl: config.ws_url ?? getConfig().wsBaseUrl,
    employeeId: config.employee_id,
    agentKind: adapter.kind,
    capabilities,
    daemonVersion: DAEMON_VERSION,
    platform: platform(),
    getToken: () => readDeviceToken(config),
    isDnd,
    handlers: {
      onDispatch: (payload) => runner.dispatch(payload),
      onPermissionResponse: (payload) => runner.resolvePermission(payload),
      onCancel: (payload) => runner.cancel(payload),
      onTokenRotate: async (payload) => {
        // Awaited before the next reconnect, so a rotation cannot race the
        // reconnect that would then present the superseded token.
        await writeDeviceToken(config, payload.newToken);
      },
      onRevoked: (payload) => {
        // Terminal: unenrolled, or this token was seen elsewhere. Never retry.
        console.error(`Connection revoked by the server (${payload.reason}). Shutting down.`);
        void shutdown(1);
      },
    },
  });

  const ui = new UiServer({
    port: config.ui_port,
    getState: () => ({
      connection: connection?.state ?? 'idle',
      employeeId: config.employee_id,
      agent: { label: adapter.label, kind: adapter.kind },
      capabilities,
      dnd,
      tokenBackend: config.device_token?.backend ?? 'none',
      tokenInsecure: config.device_token?.insecure === true,
      daemonVersion: DAEMON_VERSION,
      // TaskRecord is structurally a UiTaskView; mapping would only add drift.
      tasks: runner.recent,
    }),
    setDnd: async (enabled) => {
      dnd = enabled;
      // Cancel in-flight work immediately. A toggle that only took effect on the
      // next dispatch would not be a pause in any meaningful sense.
      if (enabled) runner.cancelAll('employee_dnd');
      await saveConfig({ ...config, dnd: enabled });
      connection?.sendDnd(enabled);
      log.info('dnd.changed', { enabled });
    },
  });

  const uiUrl = await ui.start();
  connection.start();

  console.log('Lily: starting');
  console.log(`  employee    ${config.employee_id}`);
  console.log(`  agent       ${adapter.label}`);
  console.log(`  capability  ${capabilities.length > 0 ? capabilities.join(', ') : '(none)'}`);
  console.log(`  status      ${uiUrl}`);
  if (config.device_token?.insecure === true) {
    console.log('  warning     device token stored WITHOUT OS protection');
  }

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  // Resolves only via shutdown() — the daemon is a long-running service.
  return new Promise<number>(() => {});
}

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------

async function enroll(argv: Argv): Promise<number> {
  const token = option(argv, 'token');
  if (token === undefined) {
    console.error('Missing --token. Use the install link from your invite email.');
    return 1;
  }

  const apiBase = (option(argv, 'api') ?? getConfig().apiBaseUrl).replace(/\/$/, '');

  // The install token is single-use and short-lived. The response is the only
  // moment the device token exists in plaintext anywhere.
  const response = await fetch(`${apiBase}/daemon/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installToken: token, daemonVersion: DAEMON_VERSION }),
  }).catch((cause: unknown) => {
    throw new Error(`Could not reach the Lily API at ${apiBase}.`, { cause });
  });

  if (!response.ok) {
    console.error(
      response.status === 410
        ? 'That install token has already been used or has expired. Ask for a new invite.'
        : `Enrollment failed: ${response.status} ${await response.text()}`,
    );
    return 1;
  }

  const body = (await response.json()) as {
    employeeId: string;
    orgId: string;
    deviceToken: string;
    wsUrl?: string;
  };

  const detected = await detectAgents();
  const preferred = detected[0];

  const config: DaemonConfig = {
    employee_id: body.employeeId,
    org_id: body.orgId,
    ui_port: 4111,
    dnd: false,
    ...(body.wsUrl === undefined ? {} : { ws_url: body.wsUrl }),
  };

  await saveConfig(config);
  await writeDeviceToken(config, body.deviceToken);

  console.log(`Enrolled as ${body.employeeId}. Config written to ${configPath()}.`);
  console.log(
    preferred === undefined
      ? 'No coding agent detected — install one, then run `lily-daemon detect`.'
      : `Agent: ${preferred.label}${preferred.version === null ? '' : ` (${preferred.version})`}`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// detect / doctor
// ---------------------------------------------------------------------------

async function detect(argv: Argv): Promise<number> {
  const agents = await detectAgents();

  if (flag(argv, 'json')) {
    // stdout stays machine-readable — the install scripts parse this.
    process.stdout.write(`${JSON.stringify(agents, null, 2)}\n`);
    return 0;
  }

  if (agents.length === 0) {
    console.log('No coding agents found on PATH.');
    console.log('Looked for: claude, codex, cursor-agent, gemini, windsurf');
    return 1;
  }

  for (const agent of agents) {
    console.log(`${agent.label.padEnd(14)} ${agent.version ?? '(version unknown)'}`);
    console.log(`${''.padEnd(14)} ${agent.executable}`);
  }
  return 0;
}

async function doctor(): Promise<number> {
  let problems = 0;
  const say = (ok: boolean, label: string, detail = '') => {
    if (!ok) problems += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(24)}${detail}`);
  };

  console.log(`\nlily-daemon ${DAEMON_VERSION}\n`);

  const config = await loadConfig();
  if (config === null) {
    say(false, 'config present', configPath());
    console.log('\nNot enrolled. Run: lily-daemon enroll --token <token>\n');
    return 1;
  }
  say(true, 'config present', configPath());
  say(true, 'employee', config.employee_id);
  say(config.device_token !== undefined, 'device token sealed', config.device_token?.backend ?? 'none');

  if (config.device_token?.insecure === true) {
    say(false, 'token protection', 'stored WITHOUT OS protection — install a keyring');
  }

  try {
    await readDeviceToken(config);
    say(true, 'device token readable');
  } catch (error) {
    say(false, 'device token readable', (error as Error).message);
  }

  try {
    const adapter = await resolveAdapter(config);
    say(true, 'agent resolved', adapter.label);
    const capabilities = await adapter.capabilities();
    say(true, 'capabilities', capabilities.length > 0 ? capabilities.join(', ') : '(none)');
  } catch (error) {
    say(false, 'agent resolved', (error as Error).message);
  }

  console.log(problems === 0 ? '\nno problems found\n' : `\n${problems} problem(s)\n`);
  return problems === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const USAGE = `lily-daemon ${DAEMON_VERSION}

  run                      connect and serve dispatched tasks
  enroll --token <token>   exchange a one-time install token
  detect [--json]          list installed coding agents
  doctor                   diagnose the install
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'run';

  switch (command) {
    case 'run':
      return run();
    case 'enroll':
      return enroll(argv);
    case 'detect':
      return detect(argv);
    case 'doctor':
      return doctor();
    case '--version':
    case '-v':
      console.log(DAEMON_VERSION);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    log.error('daemon.fatal', { message: (error as Error).message });
    console.error(error);
    process.exit(1);
  });

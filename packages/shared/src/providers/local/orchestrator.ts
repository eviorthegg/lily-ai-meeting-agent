import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  LaunchedOrchestrator,
  MeetingLaunchSpec,
  OrchestratorLauncher,
} from '../types.js';

const run = promisify(execFile);

/**
 * Local-stage orchestrator.
 *
 * Two launch modes, because the requirements genuinely differ:
 *
 *   process — a detached `node` child. Correct for the simulated local room,
 *             which needs no browser at all.
 *   docker  — the orchestrator image. Required for any REAL meeting platform,
 *             because joining one means driving a headful Chrome inside Xvfb
 *             with PulseAudio null sinks, none of which exist on Windows or
 *             macOS. On Linux the host can do it directly.
 *
 * Without the docker mode, starting a real meeting from the dashboard fails
 * preflight on every non-Linux developer machine — which is most of them.
 */

export type LaunchMode = 'process' | 'docker';

interface LocalHandleRecord {
  readonly mode: LaunchMode;
  /** pid for `process`, container name for `docker`. */
  readonly ref: string;
  readonly meetingId: string;
  readonly launchedAt: string;
}

/** Built by `docker compose --profile browser build orchestrator`. */
const DEFAULT_IMAGE = 'callagent-zoom-orchestrator';

/**
 * The simulated room needs no browser, so it always runs in-process — that keeps
 * the fast path fast. Anything else needs the Linux userland the image carries,
 * unless the host already is Linux.
 */
function defaultMode(platform: MeetingLaunchSpec['platform']): LaunchMode {
  const override = process.env['LILY_LOCAL_ORCHESTRATOR_MODE'];
  if (override === 'process' || override === 'docker') return override;
  if (platform === 'local') return 'process';
  return process.platform === 'linux' ? 'process' : 'docker';
}

export class LocalOrchestratorLauncher implements OrchestratorLauncher {
  readonly #stateDir: string;
  readonly #entryPoint: string;
  readonly #image: string;
  readonly #roomPort: number;
  readonly #daemonPort: number;

  constructor(opts?: {
    stateDir?: string;
    entryPoint?: string;
    image?: string;
    roomPort?: number;
    daemonPort?: number;
  }) {
    this.#stateDir = resolve(opts?.stateDir ?? '.lily-local/orchestrators');
    this.#entryPoint = resolve(
      opts?.entryPoint ?? process.env['LILY_ORCHESTRATOR_ENTRY'] ?? 'orchestrator/dist/main.js',
    );
    this.#image = opts?.image ?? process.env['LILY_ORCHESTRATOR_IMAGE'] ?? DEFAULT_IMAGE;
    this.#roomPort = opts?.roomPort ?? Number(process.env['LILY_ROOM_PORT'] ?? '4100');
    this.#daemonPort = opts?.daemonPort ?? Number(process.env['LILY_DAEMON_PORT'] ?? '4101');
  }

  #recordPath(handle: string): string {
    return join(this.#stateDir, `${handle}.json`);
  }

  #write(handle: string, record: LocalHandleRecord): void {
    mkdirSync(this.#stateDir, { recursive: true });
    writeFileSync(this.#recordPath(handle), JSON.stringify(record, null, 2), 'utf8');
  }

  #read(handle: string): LocalHandleRecord | null {
    const path = this.#recordPath(handle);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as LocalHandleRecord;
    } catch {
      return null;
    }
  }

  #meetingEnv(spec: MeetingLaunchSpec): Record<string, string> {
    return {
      LILY_STAGE: 'local',
      LILY_MEETING_ID: spec.meetingId,
      LILY_ORG_ID: spec.orgId,
      LILY_MEETING_PLATFORM: spec.platform,
      LILY_MEETING_URL: spec.meetingUrl,
      LILY_BOOTSTRAP_TOKEN: spec.bootstrapToken,
      LILY_MAX_DURATION_SEC: String(spec.maxDurationSec),
    };
  }

  async launch(spec: MeetingLaunchSpec): Promise<LaunchedOrchestrator> {
    return defaultMode(spec.platform) === 'docker'
      ? this.#launchDocker(spec)
      : this.#launchProcess(spec);
  }

  // --- process mode --------------------------------------------------------

  #launchProcess(spec: MeetingLaunchSpec): LaunchedOrchestrator {
    if (!existsSync(this.#entryPoint)) {
      throw new Error(
        `Orchestrator entry point not found at ${this.#entryPoint}. ` +
          `Build it first: npm run build -w @lily/orchestrator`,
      );
    }

    const child = spawn(process.execPath, [this.#entryPoint], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...this.#meetingEnv(spec) },
    });

    if (child.pid === undefined) {
      throw new Error(`Failed to spawn local orchestrator for meeting ${spec.meetingId}.`);
    }

    // Detached so it outlives the API process that started it, matching EC2 —
    // where the instance is independent of the Lambda that launched it.
    child.unref();

    const handle = `local-${spec.meetingId}-${child.pid}`;
    const launchedAt = new Date();
    this.#write(handle, {
      mode: 'process',
      ref: String(child.pid),
      meetingId: spec.meetingId,
      launchedAt: launchedAt.toISOString(),
    });

    return { handle, launchedAt };
  }

  // --- docker mode ---------------------------------------------------------

  async #launchDocker(spec: MeetingLaunchSpec): Promise<LaunchedOrchestrator> {
    await this.#assertDocker(spec);

    const container = `lily-mtg-${spec.meetingId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');

    const args = [
      'run',
      '--detach',
      // Deliberately NOT --rm. `docker run --detach` returns a container id the
      // instant the container starts, so launch() reports success even when the
      // bot dies a second later — and with --rm the container and its logs are
      // gone before anyone can ask why. A crashed meeting left no evidence at
      // all, which cost an hour of guessing. `terminate()` removes it instead.
      '--name',
      container,
      // Chrome maps large shared-memory segments per renderer; Docker's 64MB
      // default causes tab crashes that look like unrelated join failures.
      '--shm-size=1g',
      // Keeps Chrome's own sandbox working rather than resorting to
      // --no-sandbox. It visits meeting URLs we do not control.
      '--cap-add=SYS_ADMIN',
      // Published so the daemon on the host can reach the daemon link, and so a
      // human can open the board. Fixed ports mean ONE local meeting at a time —
      // acceptable for development, and why concurrency is tested against a
      // deployed stage rather than here.
      '-p',
      `${this.#roomPort}:4100`,
      '-p',
      `${this.#daemonPort}:4101`,
    ];

    for (const [key, value] of Object.entries(this.#meetingEnv(spec))) {
      args.push('-e', `${key}=${value}`);
    }

    args.push(this.#image, 'node', 'orchestrator/dist/main.js');

    try {
      await run('docker', args, { windowsHide: true });
    } catch (error) {
      // Surface what Docker actually said. An earlier version replaced this with
      // a guess about port conflicts — which happened to be right, and still sent
      // the reader looking for the wrong thing on the first occasion it was wrong.
      const stderr = String((error as { stderr?: string }).stderr ?? '').trim();
      const detail = stderr === '' ? (error as Error).message : stderr;

      const blockers = await this.#lilyContainers();
      const hint =
        blockers.length > 0
          ? `\n\nStill running from a previous meeting: ${blockers.join(', ')}\n` +
            `  docker rm -f ${blockers.join(' ')}`
          : '';

      throw new Error(
        `Could not start the orchestrator container for meeting ${spec.meetingId}.\n  ${detail}${hint}`,
        { cause: error },
      );
    }

    const handle = `docker-${container}`;
    const launchedAt = new Date();
    this.#write(handle, {
      mode: 'docker',
      ref: container,
      meetingId: spec.meetingId,
      launchedAt: launchedAt.toISOString(),
    });

    return { handle, launchedAt };
  }

  /**
   * Orchestrator containers still running from an earlier meeting.
   *
   * Because the local ports are fixed, a leftover container is the single most
   * common launch failure — usually one nobody remembers starting. Naming it,
   * with the command to remove it, turns a confusing port conflict into a
   * one-line fix.
   */
  async #lilyContainers(): Promise<string[]> {
    try {
      const { stdout } = await run(
        'docker',
        ['ps', '--filter', 'name=lily-mtg-', '--format', '{{.Names}}'],
        { windowsHide: true },
      );
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Fail before starting anything, naming the exact command to fix it. A missing
   * image is the most likely local failure, and "docker: command not found"
   * buried in a stack trace helps nobody.
   */
  async #assertDocker(spec: MeetingLaunchSpec): Promise<void> {
    try {
      await run('docker', ['version', '--format', '{{.Server.Version}}'], { windowsHide: true });
    } catch (error) {
      throw new Error(
        `Joining a ${spec.platform} meeting needs Docker, because it requires a real Chrome ` +
          `inside Xvfb with PulseAudio — none of which exist on ${process.platform}. ` +
          `Start Docker Desktop, or use the simulated room instead.`,
        { cause: error },
      );
    }

    try {
      await run('docker', ['image', 'inspect', this.#image], { windowsHide: true });
    } catch (error) {
      throw new Error(
        `The orchestrator image "${this.#image}" has not been built. ` +
          `Run: docker compose --profile browser build orchestrator`,
        { cause: error },
      );
    }
  }

  // --- lifecycle -----------------------------------------------------------

  async isRunning(handle: string): Promise<boolean> {
    const record = this.#read(handle);
    if (record === null) return false;

    if (record.mode === 'docker') {
      try {
        const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', record.ref], {
          windowsHide: true,
        });
        return stdout.trim() === 'true';
      } catch {
        return false;
      }
    }

    try {
      // Signal 0 tests for existence without delivering anything.
      process.kill(Number(record.ref), 0);
      return true;
    } catch {
      return false;
    }
  }

  async terminate(handle: string): Promise<void> {
    const record = this.#read(handle);
    if (record === null) return; // Idempotent, as the contract requires.

    if (record.mode === 'docker') {
      // `stop` with a grace period, not `kill`: the bot needs its shutdown path
      // to run so it leaves the meeting cleanly rather than vanishing from the
      // participant list, and so it flushes final usage.
      // `stop` with a grace period, not `kill`: the bot needs its shutdown path
      // to run so it leaves the meeting cleanly rather than vanishing from the
      // participant list, and so it flushes final usage. The `rm` is separate
      // because the container is no longer started with --rm.
      await run('docker', ['stop', '--timeout', '15', record.ref], { windowsHide: true }).catch(
        () => undefined,
      );
      await run('docker', ['rm', '-f', record.ref], { windowsHide: true }).catch(() => undefined);
    } else {
      try {
        process.kill(Number(record.ref), 'SIGTERM');
      } catch {
        // Already gone.
      }
    }

    rmSync(this.#recordPath(handle), { force: true });
  }
}

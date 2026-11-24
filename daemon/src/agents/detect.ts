import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentKind } from './types.js';
import { log } from '../log.js';

const run = promisify(execFile);

/**
 * Locate installed coding agents.
 *
 * Uses `where` on Windows and `command -v` elsewhere. `command -v` is preferred
 * over `which`, which is not guaranteed present on minimal Linux images and is a
 * shell builtin on some systems.
 */

/**
 * How to actually start the agent.
 *
 * On Windows, `where` resolves an npm-installed CLI to an extensionless shell
 * shim that `CreateProcess` cannot execute, plus a `.cmd` batch shim that it
 * can. Running the `.cmd` would require `shell: true`, which is unacceptable
 * here: the task text comes from a meeting and is passed as an argument, so a
 * shell layer would be a command-injection surface.
 *
 * Instead the shim is read and the underlying JS entry point extracted, so the
 * agent is launched as `node cli.js …` with no shell involved. This works for
 * any npm-installed CLI, not just Claude Code.
 */
export interface AgentLauncher {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export interface DetectedAgent {
  readonly kind: AgentKind;
  readonly label: string;
  readonly executable: string;
  readonly launcher: AgentLauncher;
  readonly version: string | null;
}

interface Candidate {
  readonly kind: AgentKind;
  readonly label: string;
  readonly binary: string;
  readonly versionArgs: readonly string[];
}

const CANDIDATES: readonly Candidate[] = [
  { kind: 'claude-code', label: 'Claude Code', binary: 'claude', versionArgs: ['--version'] },
  { kind: 'codex', label: 'Codex', binary: 'codex', versionArgs: ['--version'] },
  { kind: 'cursor', label: 'Cursor Agent', binary: 'cursor-agent', versionArgs: ['--version'] },
  { kind: 'gemini-cli', label: 'Gemini CLI', binary: 'gemini', versionArgs: ['--version'] },
  { kind: 'windsurf', label: 'Windsurf', binary: 'windsurf', versionArgs: ['--version'] },
];

const isWindows = process.platform === 'win32';

/** Extensions Windows can actually execute, most preferred first. */
const WINDOWS_EXEC_PRIORITY = ['.exe', '.cmd', '.bat'];

async function resolveExecutable(binary: string): Promise<string | null> {
  try {
    const { stdout } = isWindows
      ? await run('where', [binary], { windowsHide: true })
      : await run('/bin/sh', ['-c', `command -v ${binary}`]);

    const matches = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (matches.length === 0) return null;
    if (!isWindows) return matches[0] ?? null;

    // `where` lists the extensionless shell shim first, which Windows cannot
    // execute. Prefer a real executable extension over first-match ordering.
    for (const extension of WINDOWS_EXEC_PRIORITY) {
      const match = matches.find((path) => path.toLowerCase().endsWith(extension));
      if (match !== undefined) return match;
    }

    return matches[0] ?? null;
  } catch {
    return null;
  }
}

/** Matches the JS entry point inside an npm-generated `.cmd` shim. */
const SHIM_ENTRY = /"%dp0%\\(.+?\.js)"/i;

/**
 * Turn a resolved path into something spawnable without a shell.
 *
 * Falls back to invoking the path directly when the shim cannot be parsed —
 * a degraded but honest outcome, rather than silently enabling `shell: true`.
 */
export async function resolveLauncher(executablePath: string): Promise<AgentLauncher> {
  if (!isWindows || !executablePath.toLowerCase().endsWith('.cmd')) {
    return { command: executablePath, prefixArgs: [] };
  }

  try {
    const contents = await readFile(executablePath, 'utf8');
    const relative = SHIM_ENTRY.exec(contents)?.[1];
    if (relative === undefined) return { command: executablePath, prefixArgs: [] };

    const entry = join(dirname(executablePath), relative);
    if (!existsSync(entry)) return { command: executablePath, prefixArgs: [] };

    return { command: process.execPath, prefixArgs: [entry] };
  } catch {
    return { command: executablePath, prefixArgs: [] };
  }
}

async function resolveVersion(
  launcher: AgentLauncher,
  versionArgs: readonly string[],
): Promise<string | null> {
  try {
    const { stdout } = await run(launcher.command, [...launcher.prefixArgs, ...versionArgs], {
      timeout: 20_000,
      windowsHide: true,
    });
    return stdout.trim().split(/\r?\n/)[0] ?? null;
  } catch {
    // Present but unresponsive to --version is still usable; don't drop it.
    return null;
  }
}

export async function detectAgents(): Promise<DetectedAgent[]> {
  const found = await Promise.all(
    CANDIDATES.map(async (candidate): Promise<DetectedAgent | null> => {
      const executable = await resolveExecutable(candidate.binary);
      if (executable === null) return null;

      const launcher = await resolveLauncher(executable);
      const version = await resolveVersion(launcher, candidate.versionArgs);
      return {
        kind: candidate.kind,
        label: candidate.label,
        executable,
        launcher,
        version,
      };
    }),
  );

  const agents = found.filter((a): a is DetectedAgent => a !== null);
  log.info('agents.detected', { count: agents.length, kinds: agents.map((a) => a.kind).join(',') });
  return agents;
}

export async function detectAgent(kind: AgentKind): Promise<DetectedAgent | null> {
  const all = await detectAgents();
  return all.find((agent) => agent.kind === kind) ?? null;
}

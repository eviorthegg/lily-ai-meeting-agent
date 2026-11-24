import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { log } from './log.js';
import { resolveSecretStore, storeForSealed, type SealedSecret } from './secrets/index.js';

/**
 * `~/.lily/config.json` — the daemon's entire persistent state.
 *
 * Everything here is about *this daemon's identity and preferences*. Nothing
 * derived from the employee's machine, their repos, or any task ever lands in
 * this file; see the DATA POLICY header in api/src/db/schema.ts, which this
 * daemon is the upstream of.
 */

const sealedSecretSchema = z.object({
  backend: z.enum(['dpapi', 'keychain', 'libsecret', 'file']),
  value: z.string(),
  insecure: z.literal(true).optional(),
});

/**
 * Generic agent template, so an agent nobody has written an adapter for can still
 * be wired in by editing this file. `{{task}}` is substituted at dispatch time.
 */
export const agentTemplateSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** `~` is expanded. Defaults to the daemon's working directory. */
  cwd: z.string().optional(),
  /** Extra environment for the child. Never merged into the daemon's own env. */
  env: z.record(z.string()).optional(),
  /** Which adapter reads this template. 'command' is the generic one. */
  kind: z.enum(['command', 'claude-code']).default('command'),
  /**
   * Send the task on stdin instead of substituting `{{task}}` into args. For
   * agents that read their prompt from a pipe.
   */
  stdin_task: z.boolean().default(false),
  /**
   * MCP server / tool NAMES this agent can reach, e.g. ["google-calendar"].
   *
   * Declared by hand because a generic command cannot be introspected. Lily routes
   * on it, so an employee wiring in their own agent has to state what it reaches.
   * Names only — never anything those tools can see.
   */
  capabilities: z.array(z.string().min(1).max(128)).max(100).optional(),
});

export const daemonConfigSchema = z.object({
  employee_id: z.string().min(1).max(128),
  org_id: z.string().min(1).max(128),

  /** Overrides the stage default from @lily/shared. */
  ws_url: z.string().url().optional(),
  api_url: z.string().url().optional(),

  device_token: sealedSecretSchema.optional(),

  agent: agentTemplateSchema.optional(),

  /** Directory the dispatched agent runs in. `~` is expanded. */
  workspace: z.string().optional(),

  /** Loopback status/DND page. 0 asks the OS for a free port. */
  ui_port: z.number().int().min(0).max(65_535).default(4111),

  /**
   * Do Not Disturb. Persisted so it survives a restart — an employee who muted
   * their agent before a focus block should not be re-enrolled into dispatch by
   * a laptop reboot.
   */
  dnd: z.boolean().default(false),
});

export type DaemonConfig = z.infer<typeof daemonConfigSchema>;
export type AgentTemplate = z.infer<typeof agentTemplateSchema>;

export function configDir(): string {
  return process.env['LILY_HOME'] ?? join(homedir(), '.lily');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

/** Expand a leading `~` and resolve to an absolute path. */
export function expandHome(input: string): string {
  const expanded =
    input === '~' || input.startsWith('~/') || input.startsWith('~\\')
      ? join(homedir(), input.slice(1))
      : input;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export class ConfigError extends Error {}

/** Returns null when the daemon has not been enrolled yet. */
export async function loadConfig(path = configPath()): Promise<DaemonConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigError(`Could not read ${path}: ${String(cause)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} is not valid JSON. Fix it or re-run enrollment.`);
  }

  const result = daemonConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`${path} is not a valid Lily config — ${detail}`);
  }

  return result.data;
}

export async function saveConfig(config: DaemonConfig, path = configPath()): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // Write-then-rename so an interrupted save cannot leave a half-written config
  // that the daemon would refuse to start from on the next boot.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);

  // Best effort: on Windows this is close to a no-op, which is precisely why the
  // token there is DPAPI-sealed rather than trusting file permissions.
  await chmod(path, 0o600).catch(() => undefined);
}

/**
 * Decrypt the device token.
 *
 * Uses the store named in the sealed record rather than the platform default, so
 * a config written before a keyring was installed still opens.
 */
export async function readDeviceToken(config: DaemonConfig): Promise<string> {
  const sealed = config.device_token;
  if (sealed === undefined) {
    throw new ConfigError(
      'This daemon is not enrolled — no device token in the config. Run `lily-daemon enroll`.',
    );
  }
  return storeForSealed(sealed).open(sealed);
}

/**
 * Seal a new device token and persist it.
 *
 * Called on enrollment and on every `token.rotate`. Rotation happens on a schedule
 * *and* on every reconnect, so this is a hot-ish path: it must be safe to call
 * repeatedly and must never leave the config without a usable token.
 */
export async function writeDeviceToken(
  config: DaemonConfig,
  token: string,
  path = configPath(),
): Promise<DaemonConfig> {
  const store = await resolveSecretStore();
  const sealed: SealedSecret = await store.seal(token);
  const next: DaemonConfig = { ...config, device_token: sealed };
  await saveConfig(next, path);

  if (store.isInsecure) {
    log.warn('config.device_token_unprotected', { backend: store.backend });
  }
  return next;
}

/** DND is employee-owned. Nothing inbound from the server can call this. */
export async function persistDnd(
  config: DaemonConfig,
  enabled: boolean,
  path = configPath(),
): Promise<DaemonConfig> {
  const next: DaemonConfig = { ...config, dnd: enabled };
  await saveConfig(next, path);
  return next;
}

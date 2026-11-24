import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { SecretsProvider } from '../types.js';

/**
 * Maps a logical secret name to an environment variable key.
 * `lily/local/mongo-uri` → `LILY_LOCAL_MONGO_URI`
 */
export function secretNameToEnvKey(secretName: string): string {
  return secretName.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

function parseDotEnv(contents: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip matched surrounding quotes, so values containing '#' or spaces survive.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    out.set(key, value);
  }

  return out;
}

/** Walk up from `start` looking for a directory containing a marker file. */
function findUp(marker: string, start: string): string | null {
  let dir = resolve(start);

  for (;;) {
    if (existsSync(join(dir, marker))) return join(dir, marker);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Local-stage secrets: resolved from `.env.local` at the repo root, falling back
 * to the process environment.
 *
 * `.env.local` is gitignored and this provider is only ever constructed for the
 * local stage — see `createProviders`. Deployed stages have no code path that
 * can read a file-backed secret.
 */
export class LocalSecretsProvider implements SecretsProvider {
  #fileValues: Map<string, string> | null = null;
  readonly #filePath: string | null;

  constructor(filePath?: string) {
    this.#filePath =
      filePath ?? process.env['LILY_LOCAL_SECRETS_FILE'] ?? findUp('.env.local', process.cwd());
  }

  #values(): Map<string, string> {
    if (this.#fileValues === null) {
      this.#fileValues =
        this.#filePath !== null && existsSync(this.#filePath)
          ? parseDotEnv(readFileSync(this.#filePath, 'utf8'))
          : new Map();
    }
    return this.#fileValues;
  }

  async get(secretName: string): Promise<string> {
    const key = secretNameToEnvKey(secretName);
    const fromEnv = process.env[key];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

    const fromFile = this.#values().get(key);
    if (fromFile !== undefined && fromFile !== '') return fromFile;

    throw new Error(
      `Secret "${secretName}" is not set for the local stage. ` +
        `Add ${key}=... to .env.local (see .env.example) or export it in your shell.`,
    );
  }

  invalidate(): void {
    this.#fileValues = null;
  }
}

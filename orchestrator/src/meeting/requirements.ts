/**
 * Shared preflight machinery for the real platform adapters.
 *
 * Two categories, kept apart because they are not the same problem:
 *
 *   `missing`  — something a developer can supply today. An API key, a secret,
 *                a meeting number, an installed SDK.
 *   `blockers` — something no environment variable can fix. A vendor approval,
 *                a security review, an API that does not exist. These are the
 *                honest reason each adapter is a stub, and they are surfaced
 *                rather than designed around.
 */

import type { AdapterPreflight, MeetingPlatform } from './adapter.js';

export function envValue(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

export interface RequirementSpec {
  readonly env: string;
  readonly what: string;
}

export function missingEnv(specs: readonly RequirementSpec[]): string[] {
  return specs
    .filter((spec) => envValue(spec.env) === null)
    .map((spec) => `${spec.env} — ${spec.what}`);
}

export function preflight(
  platform: MeetingPlatform,
  specs: readonly RequirementSpec[],
  blockers: readonly string[],
): AdapterPreflight {
  const missing = missingEnv(specs);
  return {
    platform,
    // A blocker is fatal on its own: having every key and still needing an
    // approval that has not been granted is not "ready".
    ready: missing.length === 0 && blockers.length === 0,
    missing,
    blockers,
  };
}

/** True when a native module can be resolved from this process. */
export function canResolve(specifier: string): boolean {
  try {
    // `import.meta.resolve` is synchronous in Node and does not execute the
    // module, which is what a preflight wants — presence, not side effects.
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

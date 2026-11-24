/**
 * The three stages this system runs in.
 *
 *   local — everything on a developer machine. No AWS calls at all: local mongod,
 *           a WebSocket shim that reproduces the API Gateway contract, mail written
 *           to disk, and the orchestrator spawned as a child process instead of EC2.
 *   dev   — deployed to AWS, but in dev mode: SES sandbox, verbose logs, short
 *           retention, relaxed rate limits, test-mode Lemon Squeezy.
 *   prod  — the real thing.
 *
 * Stage selects *providers*, never business logic. If you find yourself writing
 * `if (stage === 'prod')` inside a handler, the branch belongs in a provider instead.
 */
export const STAGES = ['local', 'dev', 'prod'] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/**
 * Resolve the active stage from the environment.
 *
 * Defaults to `local` when unset — the safe direction. An unset stage must never
 * silently resolve to `prod`, and an unrecognised value is always a hard failure
 * rather than a fallback, so a typo in a deploy pipeline can't quietly run dev
 * config against production data.
 */
export function resolveStage(env: NodeJS.ProcessEnv = process.env): Stage {
  const raw = env['LILY_STAGE'];

  if (raw === undefined || raw === '') {
    return 'local';
  }

  if (!isStage(raw)) {
    throw new Error(
      `LILY_STAGE is "${raw}", which is not a known stage. Expected one of: ${STAGES.join(', ')}.`,
    );
  }

  return raw;
}

/** True when the stage runs entirely on the developer machine with no AWS dependency. */
export function isLocal(stage: Stage): boolean {
  return stage === 'local';
}

/** True when the stage is deployed to AWS (either dev or prod). */
export function isDeployed(stage: Stage): boolean {
  return stage === 'dev' || stage === 'prod';
}

import {
  tierFor,
  type ActionKind,
  type PermissionTier,
} from '@lily/shared';
import { log } from './log.js';

/**
 * Permission engine for meeting-dispatched work.
 *
 * This is the security boundary of the product: Lily can cause commands to run
 * on an employee's machine, so what follows decides what happens silently, what
 * gets asked aloud in the meeting, and what is refused outright.
 *
 * Three rules shape everything here.
 *
 * 1. **Hard-blocked actions never generate a permission request.** They are
 *    refused locally and the meeting is never asked. Voicing them would train
 *    people to approve destructive operations, and would mean a socially
 *    pressured "yes" in front of colleagues could delete a repo.
 *
 * 2. **Classification fails toward the strictest plausible tier.** An unrecognised
 *    command is `shell` (gated), never `read`. A misclassification that gates a
 *    harmless action costs one spoken question; the reverse silently runs
 *    something nobody approved.
 *
 * 3. **Hard-block patterns are tested before permissive ones.** `git push --force
 *    origin main` must not match a "git is usually read-only" rule. Order in
 *    `classifyCommand` is load-bearing, not stylistic.
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface Rule {
  readonly kind: ActionKind;
  readonly pattern: RegExp;
}

/**
 * Branches whose history is protected. A push here is hard-blocked regardless of
 * approval; anything else is an ordinary gated write.
 */
const PROTECTED_BRANCHES = /\b(main|master|release\/[^\s]+|prod(uction)?)\b/;

/**
 * Evaluated top to bottom, first match wins. Hard-blocked kinds come first by
 * design — see rule 3 above.
 */
const RULES: readonly Rule[] = [
  // --- hard-blocked -------------------------------------------------------
  { kind: 'credential_access', pattern: /(^|[\s/\\])(\.env|\.npmrc|\.pypirc|id_rsa|id_ed25519)\b/ },
  { kind: 'credential_access', pattern: /\.(aws|ssh|kube|docker|gnupg)[/\\]/ },
  { kind: 'credential_access', pattern: /\b(aws\s+configure|gcloud\s+auth|az\s+login|op\s+read|security\s+find-generic-password|keyring)\b/ },
  { kind: 'credential_access', pattern: /\b(printenv|env)\b(?!\s*\|)/ },

  { kind: 'deploy', pattern: /\b(kubectl|helm|terraform|pulumi|serverless|sam|vercel|flyctl|heroku)\b/ },
  { kind: 'deploy', pattern: /\baws\s+(?!s3\s+ls|sts\s+get-caller-identity)/ },
  { kind: 'deploy', pattern: /\b(docker\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|cargo\s+publish|gh\s+release\s+create)\b/ },

  // Force-push and branch deletion are destructive on ANY branch, not just protected ones.
  { kind: 'vcs_push_protected', pattern: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|-f\b|--delete\b|:\s*\S)/ },
  { kind: 'delete', pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*[fdx]|branch\s+-D)\b/ },
  { kind: 'delete', pattern: /\b(rm|rmdir|unlink|shred)\b/ },
  { kind: 'delete', pattern: /\bRemove-Item\b|\bdel\b|\berase\b/i },
  { kind: 'delete', pattern: /\b(drop\s+(table|database)|truncate\s+table)\b/i },

  // --- gated --------------------------------------------------------------
  { kind: 'test', pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/ },
  { kind: 'test', pattern: /\b(pytest|jest|vitest|mocha|rspec|go\s+test|cargo\s+test|dotnet\s+test|phpunit)\b/ },

  { kind: 'install', pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/ },
  { kind: 'install', pattern: /\b(pip3?|uv|poetry|gem|cargo|go|apt|apt-get|brew|choco|winget)\s+(install|add|get)\b/ },

  { kind: 'network', pattern: /\b(curl|wget|nc|netcat|ssh|scp|rsync|Invoke-WebRequest|Invoke-RestMethod)\b/i },

  { kind: 'write', pattern: /\bgit\s+(commit|add|merge|rebase|cherry-pick|stash|tag|push)\b/ },
  { kind: 'write', pattern: /(^|\s)(>|>>|tee)\s/ },
  { kind: 'write', pattern: /\b(mv|cp|mkdir|touch|chmod|chown|ln)\b/ },
  { kind: 'write', pattern: /\b(Set-Content|Add-Content|New-Item|Copy-Item|Move-Item)\b/i },

  // --- auto-approved ------------------------------------------------------
  { kind: 'vcs_read', pattern: /\bgit\s+(log|diff|show|status|blame|branch|remote|describe|rev-parse)\b/ },
  { kind: 'search', pattern: /\b(grep|rg|ripgrep|ag|ack|find|fd|fzf|Select-String)\b/i },
  { kind: 'read', pattern: /\b(cat|less|more|head|tail|bat|ls|dir|stat|file|wc|tree|pwd|Get-Content|Get-ChildItem)\b/i },
];

/**
 * Map a concrete command to the closed action vocabulary.
 *
 * Returns `shell` for anything unrecognised — a gated tier, never an auto one.
 */
export function classifyCommand(command: string): ActionKind {
  const normalized = command.trim();

  for (const rule of RULES) {
    if (!rule.pattern.test(normalized)) continue;

    // A plain `git push` is only hard-blocked when it targets a protected branch;
    // pushing a feature branch is an ordinary gated write.
    if (rule.kind === 'write' && /\bgit\s+push\b/.test(normalized)) {
      return PROTECTED_BRANCHES.test(normalized) ? 'vcs_push_protected' : 'write';
    }

    return rule.kind;
  }

  return 'shell';
}

/**
 * Shell metacharacters let one approved command carry another. `npm test` is a
 * test; `npm test && rm -rf .` is not, and must not inherit the test tier.
 */
const CHAINING = /(\|\||&&|;|\||`|\$\()/;

export function splitChained(command: string): string[] {
  return command
    .split(/\|\||&&|;|\|/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Classify a command that may chain several operations, returning the strictest
 * kind present. This is why chaining is decomposed rather than pattern-matched
 * as a whole string.
 */
export function classifyFull(command: string): ActionKind {
  if (!CHAINING.test(command)) return classifyCommand(command);

  const kinds = splitChained(command).map(classifyCommand);

  // Command substitution can hide anything; treat its presence as unrecognised.
  if (/`|\$\(/.test(command)) kinds.push('shell');

  return strictest(kinds);
}

const TIER_SEVERITY: Record<PermissionTier, number> = { auto: 0, gated: 1, blocked: 2 };

export function strictest(kinds: readonly ActionKind[]): ActionKind {
  let worst: ActionKind = 'read';
  for (const kind of kinds) {
    if (TIER_SEVERITY[tierFor(kind)] > TIER_SEVERITY[tierFor(worst)]) worst = kind;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type DispatchMode = 'read_only' | 'standard';

export interface DecisionInput {
  readonly command: string;
  readonly mode: DispatchMode;
  /** True when the meeting participant who asked owns this agent. */
  readonly selfRequested: boolean;
}

export type Decision =
  | { readonly outcome: 'allow'; readonly kind: ActionKind; readonly rationale: AllowReason }
  | { readonly outcome: 'ask'; readonly kind: ActionKind; readonly detail: string }
  | { readonly outcome: 'refuse'; readonly kind: ActionKind; readonly message: string };

export type AllowReason = 'auto_tier' | 'self_requested';

/**
 * Kinds that a spoken self-request can cover without a second prompt.
 *
 * "Lily, book a meeting with Chris tomorrow" plainly implies a calendar write and
 * the network call to perform it — re-asking the person who just asked adds
 * friction and no security.
 *
 * It does NOT extend to `shell`, `test` or `install`. No natural-language request
 * in a meeting implies "and run arbitrary commands on my laptop", so those keep
 * gating even for the requester. This is the boundary between honouring intent
 * and letting one sentence authorise anything.
 */
const SELF_REQUEST_COVERS: readonly ActionKind[] = ['write', 'network'];

export function decide(input: DecisionInput): Decision {
  const kind = classifyFull(input.command);
  const tier = tierFor(kind);

  if (tier === 'blocked') {
    // Never an 'ask'. See rule 1.
    return {
      outcome: 'refuse',
      kind,
      message: refusalMessage(kind),
    };
  }

  if (tier === 'auto') {
    return { outcome: 'allow', kind, rationale: 'auto_tier' };
  }

  // Questions dispatched read-only refuse mutation rather than interrupting the
  // meeting to ask for something the task never needed.
  if (input.mode === 'read_only') {
    return {
      outcome: 'refuse',
      kind,
      message:
        `This task was dispatched read-only, so "${truncate(input.command)}" was not run. ` +
        `Ask again as an action rather than a question if you want it performed.`,
    };
  }

  if (input.selfRequested && SELF_REQUEST_COVERS.includes(kind)) {
    return { outcome: 'allow', kind, rationale: 'self_requested' };
  }

  return { outcome: 'ask', kind, detail: truncate(input.command) };
}

function refusalMessage(kind: ActionKind): string {
  switch (kind) {
    case 'vcs_push_protected':
      return 'Pushing to a protected branch is blocked for meeting-dispatched tasks.';
    case 'delete':
      return 'Deleting files or history is blocked for meeting-dispatched tasks.';
    case 'deploy':
      return 'Deployment and release commands are blocked for meeting-dispatched tasks.';
    case 'credential_access':
      return 'Reading credentials is blocked for meeting-dispatched tasks.';
    default:
      return 'This action is blocked for meeting-dispatched tasks.';
  }
}

/** Lily reads `detail` aloud verbatim, so it must stay short enough to say. */
function truncate(command: string, max = 120): string {
  const single = command.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export interface PendingRequest {
  readonly taskId: string;
  readonly requestId: string;
  readonly kind: ActionKind;
  readonly detail: string;
}

export interface GateCallbacks {
  /** Emits `permission.request` upward. Called only for `ask` decisions. */
  readonly onAsk: (request: PendingRequest) => void;
}

export interface GateResolution {
  readonly approved: boolean;
  readonly reason: 'granted' | 'denied' | 'timeout' | 'wrong_speaker' | 'hard_blocked';
}

/**
 * Coordinates the asynchronous half: emit a request, block the agent, resolve
 * when the meeting answers.
 *
 * Timeouts are decided by the orchestrator, which owns the spoken interaction —
 * but this side keeps its own longer backstop so a lost response cannot wedge
 * an agent process forever.
 */
export class PermissionGate {
  readonly #pending = new Map<string, (resolution: GateResolution) => void>();
  readonly #callbacks: GateCallbacks;
  readonly #backstopMs: number;

  constructor(callbacks: GateCallbacks, opts?: { backstopMs?: number }) {
    this.#callbacks = callbacks;
    this.#backstopMs = opts?.backstopMs ?? 120_000;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Evaluate a command and, if it needs approval, wait for it.
   *
   * Resolves rather than throws on refusal: a denied permission is a normal
   * outcome the agent should report back, not an exception.
   */
  async request(
    taskId: string,
    requestId: string,
    input: DecisionInput,
  ): Promise<GateResolution & { kind: ActionKind; decision: Decision }> {
    const decision = decide(input);

    if (decision.outcome === 'refuse') {
      log.warn('permission.refused', { taskId, kind: decision.kind });
      return {
        approved: false,
        reason: tierFor(decision.kind) === 'blocked' ? 'hard_blocked' : 'denied',
        kind: decision.kind,
        decision,
      };
    }

    if (decision.outcome === 'allow') {
      log.debug('permission.allowed', { taskId, kind: decision.kind, why: decision.rationale });
      return { approved: true, reason: 'granted', kind: decision.kind, decision };
    }

    log.info('permission.asked', { taskId, requestId, kind: decision.kind });
    this.#callbacks.onAsk({ taskId, requestId, kind: decision.kind, detail: decision.detail });

    const resolution = await new Promise<GateResolution>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        log.warn('permission.backstop_timeout', { taskId, requestId });
        resolve({ approved: false, reason: 'timeout' });
      }, this.#backstopMs);

      // Do not hold the process open purely to wait on an answer.
      timer.unref?.();

      this.#pending.set(requestId, (value) => {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        resolve(value);
      });
    });

    return { ...resolution, kind: decision.kind, decision };
  }

  /** Called when `permission.response` arrives. Unknown ids are ignored. */
  resolve(requestId: string, resolution: GateResolution): boolean {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      log.debug('permission.response_unknown', { requestId });
      return false;
    }
    pending(resolution);
    return true;
  }

  /** Deny everything outstanding — meeting ended, task cancelled, DND engaged. */
  abandonAll(reason: GateResolution['reason'] = 'denied'): void {
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      pending({ approved: false, reason });
    }
  }
}

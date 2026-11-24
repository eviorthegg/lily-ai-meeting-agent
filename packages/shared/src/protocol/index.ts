import { z } from 'zod';

/**
 * Wire protocol between the employee daemon, the API, and the Lily orchestrator.
 *
 * Validated with zod rather than merely typed. Every message here crosses a
 * trust boundary — the daemon runs on an employee's laptop and the orchestrator
 * runs on a disposable EC2 box — so shapes are checked at runtime on receipt.
 * A TypeScript interface alone proves nothing about what actually arrived on
 * the socket.
 *
 * Compatibility rule: `v` is the protocol version. A daemon that has not been
 * updated must be told to upgrade, not silently mis-parsed — see
 * `PROTOCOL_VERSION` handling in the $connect handler.
 */
export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const envelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  /** Client-generated id, echoed in any correlated reply. */
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  ts: z.string().datetime(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

// ---------------------------------------------------------------------------
// Permission model
// ---------------------------------------------------------------------------

/**
 * What an agent is trying to do, classified into a fixed vocabulary.
 *
 * The daemon maps its agent's concrete tool call onto one of these before asking
 * anyone. Keeping the vocabulary closed is what lets the policy be audited: a
 * free-text action string could not be reasoned about, and "run tests" and
 * "delete the repo" would be indistinguishable to the gate.
 */
export const actionKindSchema = z.enum([
  // Auto-approved: non-mutating inspection.
  'read',
  'search',
  'vcs_read',
  // Gated: requires spoken approval from the owning employee.
  'write',
  'shell',
  'test',
  'install',
  'network',
  // Hard-blocked: never approvable, never voiced as approvable.
  'vcs_push_protected',
  'delete',
  'deploy',
  'credential_access',
]);

export type ActionKind = z.infer<typeof actionKindSchema>;

export const AUTO_APPROVED_KINDS: readonly ActionKind[] = ['read', 'search', 'vcs_read'];
export const GATED_KINDS: readonly ActionKind[] = [
  'write',
  'shell',
  'test',
  'install',
  'network',
];
export const HARD_BLOCKED_KINDS: readonly ActionKind[] = [
  'vcs_push_protected',
  'delete',
  'deploy',
  'credential_access',
];

export type PermissionTier = 'auto' | 'gated' | 'blocked';

export function tierFor(kind: ActionKind): PermissionTier {
  if (AUTO_APPROVED_KINDS.includes(kind)) return 'auto';
  if (HARD_BLOCKED_KINDS.includes(kind)) return 'blocked';
  return 'gated';
}

// ---------------------------------------------------------------------------
// daemon → server
// ---------------------------------------------------------------------------

/**
 * First message after connect. Reports who this daemon is and what its agent
 * can reach.
 *
 * `capabilities` is names only — MCP server and tool identifiers such as
 * 'google-calendar' or 'github'. Lily routes on it ("who can book a meeting?")
 * and it is stored on the user record. It must never carry anything those tools
 * can see.
 */
export const daemonHelloSchema = z.object({
  employeeId: z.string().min(1).max(128),
  agentKind: z.string().min(1).max(64),
  capabilities: z.array(z.string().min(1).max(128)).max(100),
  daemonVersion: z.string().max(32),
  platform: z.enum(['darwin', 'linux', 'win32']),
});

export const presenceHeartbeatSchema = z.object({
  /** Employee-controlled Do Not Disturb, reported on every beat so the server
   *  converges even if a toggle message was lost. */
  dnd: z.boolean(),
});

/** Live work-in-progress, shown under Lily's avatar so the room isn't staring at silence. */
export const agentStatusSchema = z.object({
  taskId: z.string().min(1).max(64),
  state: z.enum(['queued', 'running', 'awaiting_permission', 'done', 'failed']),
  /** Short human-readable note, e.g. "searching the repo". Never file contents. */
  note: z.string().max(200).optional(),
});

/**
 * The agent's answer, on its way to being spoken in the meeting.
 *
 * `answer` is transient: it passes through the orchestrator into Lily's speech
 * and is never persisted. Only `ok` is recorded, as TaskDoc.dispatchOutcome.
 * The cap is a backstop against an agent dumping a file into the reply.
 */
export const taskResultSchema = z.object({
  taskId: z.string().min(1).max(64),
  ok: z.boolean(),
  answer: z.string().max(4_000),
  truncated: z.boolean(),
  error: z.string().max(500).optional(),
});

export const permissionRequestSchema = z.object({
  taskId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(64),
  kind: actionKindSchema,
  /** Exactly what will run, e.g. "npm test". Lily repeats this back verbatim
   *  before relaying approval, so it must be precise and short enough to say. */
  detail: z.string().min(1).max(200),
  reason: z.string().max(300).optional(),
});

export const dndSetSchema = z.object({ enabled: z.boolean() });

// ---------------------------------------------------------------------------
// server → daemon
// ---------------------------------------------------------------------------

export const taskDispatchSchema = z.object({
  taskId: z.string().min(1).max(64),
  meetingId: z.string().min(1).max(64),
  /** The question or instruction, in plain language. */
  text: z.string().min(1).max(2_000),
  /** Who asked. Used to decide whether the request is self-directed. */
  requesterEmployeeId: z.string().min(1).max(128),
  /**
   * Meeting-dispatched tasks run under a restricted profile, separate from the
   * employee's normal interactive session. 'read_only' is the default for
   * questions; 'standard' still gates every mutating action.
   */
  mode: z.enum(['read_only', 'standard']),
  /**
   * True when the requester is the owner of this agent. Their spoken request is
   * itself the approval for the action they named — re-prompting the same
   * person for the thing they just asked for adds friction and no security.
   * Anything beyond the named action still gates normally.
   */
  selfRequested: z.boolean(),
  deadlineSec: z.number().int().positive().max(600),
});

export const permissionResponseSchema = z.object({
  taskId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(64),
  approved: z.boolean(),
  /** 'timeout' and 'wrong_speaker' are denials, recorded distinctly in the audit log. */
  reason: z.enum(['granted', 'denied', 'timeout', 'wrong_speaker', 'hard_blocked']),
});

export const taskCancelSchema = z.object({
  taskId: z.string().min(1).max(64),
  reason: z.enum(['meeting_ended', 'superseded', 'employee_dnd', 'timeout']),
});

/** Device tokens rotate on a schedule and on every reconnect. */
export const tokenRotateSchema = z.object({
  newToken: z.string().min(32),
  rotatesAt: z.string().datetime(),
});

/** Sent immediately before the server closes a revoked connection. */
export const connectionRevokedSchema = z.object({
  reason: z.enum(['employee_removed', 'token_revoked', 'reuse_detected', 'org_suspended']),
});

// ---------------------------------------------------------------------------
// Discriminated unions
// ---------------------------------------------------------------------------

function msg<T extends string, S extends z.ZodTypeAny>(type: T, payload: S) {
  return envelopeSchema.extend({ type: z.literal(type), payload });
}

export const daemonToServerSchema = z.discriminatedUnion('type', [
  msg('daemon.hello', daemonHelloSchema),
  msg('presence.heartbeat', presenceHeartbeatSchema),
  msg('agent.status', agentStatusSchema),
  msg('task.result', taskResultSchema),
  msg('permission.request', permissionRequestSchema),
  msg('dnd.set', dndSetSchema),
]);

export const serverToDaemonSchema = z.discriminatedUnion('type', [
  msg('task.dispatch', taskDispatchSchema),
  msg('permission.response', permissionResponseSchema),
  msg('task.cancel', taskCancelSchema),
  msg('token.rotate', tokenRotateSchema),
  msg('connection.revoked', connectionRevokedSchema),
]);

export type DaemonToServer = z.infer<typeof daemonToServerSchema>;
export type ServerToDaemon = z.infer<typeof serverToDaemonSchema>;
export type DaemonMessageType = DaemonToServer['type'];
export type ServerMessageType = ServerToDaemon['type'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function encode<T extends { type: string; payload: unknown }>(
  message: T & { id?: string },
): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    id: message.id ?? crypto.randomUUID(),
    type: message.type,
    ts: new Date().toISOString(),
    payload: message.payload,
  });
}

export type DecodeResult<T> =
  | { ok: true; message: T }
  | { ok: false; error: string };

/**
 * Parse and validate an inbound frame.
 *
 * Returns a result rather than throwing: a malformed frame from a daemon is an
 * expected condition (old client, corrupted send) that should close the socket
 * with a clear reason, not raise an unhandled exception in the handler.
 */
export function decode<S extends z.ZodTypeAny>(
  schema: S,
  raw: string | Buffer,
): DecodeResult<z.infer<S>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed JSON' };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') };
  }

  return { ok: true, message: result.data };
}

export const decodeFromDaemon = (raw: string | Buffer) => decode(daemonToServerSchema, raw);
export const decodeFromServer = (raw: string | Buffer) => decode(serverToDaemonSchema, raw);

/**
 * Dashboard side of the WebSocket API.
 *
 * `packages/shared/src/protocol` defines two directions — daemon→server and
 * server→daemon — and a dashboard is neither. What the team table needs is a
 * read-only fan-out of facts the server already has: who is connected, and what
 * an agent is doing right now. That is declared here.
 *
 * Declared rather than imported for the same reason `lib/api/types.ts` mirrors
 * the Mongo schema by hand: `@lily/shared` is a NodeNext package that pulls in
 * the AWS SDK and the MongoDB driver, and none of that belongs in a browser
 * bundle. Field names and the `agent.status` state vocabulary are copied exactly
 * from `agentStatusSchema` so divergence shows up as a rename.
 *
 * Validation is hand-written guards rather than zod. Four message shapes do not
 * justify a runtime schema library in a bundle whose first paint is a marketing
 * page — but they absolutely justify validating, because this data crosses a
 * trust boundary and an unchecked cast would let a malformed frame put
 * `undefined` into a presence badge.
 *
 * DATA POLICY: nothing on this channel carries content. `note` is the same
 * short human-readable string the daemon already sends ("searching the repo"),
 * capped server-side and re-capped on receipt below. Transcripts, file contents
 * and agent output are not on this socket because they are nowhere in the system.
 */

export const DASHBOARD_PROTOCOL_VERSION = 1 as const;

export type AgentTaskState = 'queued' | 'running' | 'awaiting_permission' | 'done' | 'failed';

export interface PresenceRow {
  employeeId: string;
  online: boolean;
  /** Employee-controlled Do Not Disturb. A manager cannot override it, and the
   *  table must not present it as "offline" — it is a different fact. */
  dnd: boolean;
  agentKind: string | null;
  /** When the server observed this. Rendered next to the badge, always. */
  at: string;
}

export interface AgentStatusRow {
  employeeId: string;
  taskId: string;
  state: AgentTaskState;
  note: string | null;
  at: string;
}

export interface MeetingStatusRow {
  meetingId: string;
  status: string;
  at: string;
}

export type DashboardInbound =
  | { type: 'presence.snapshot'; at: string; rows: PresenceRow[] }
  | { type: 'presence.changed'; at: string; row: PresenceRow }
  | { type: 'agent.status'; at: string; row: AgentStatusRow }
  | { type: 'meeting.status'; at: string; row: MeetingStatusRow }
  | { type: 'pong'; at: string };

/** dashboard → server. Subscription is scoped by the token, never by this frame. */
export type DashboardOutbound =
  | { v: number; type: 'dashboard.hello'; ts: string }
  | { v: number; type: 'ping'; ts: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NOTE_MAX = 200;
const AGENT_STATES: readonly string[] = [
  'queued',
  'running',
  'awaiting_permission',
  'done',
  'failed',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function nullableStr(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  return str(value, max);
}

function isoOr(value: unknown, fallback: string): string {
  const parsed = str(value, 40);
  if (parsed === null) return fallback;
  return Number.isNaN(Date.parse(parsed)) ? fallback : parsed;
}

function toPresenceRow(value: unknown, fallbackAt: string): PresenceRow | null {
  if (!isRecord(value)) return null;
  const employeeId = str(value['employeeId'], 128);
  if (employeeId === null) return null;
  return {
    employeeId,
    online: value['online'] === true,
    dnd: value['dnd'] === true,
    agentKind: nullableStr(value['agentKind'], 64),
    at: isoOr(value['at'], fallbackAt),
  };
}

function toAgentStatusRow(value: unknown, fallbackAt: string): AgentStatusRow | null {
  if (!isRecord(value)) return null;
  const employeeId = str(value['employeeId'], 128);
  const taskId = str(value['taskId'], 64);
  const state = str(value['state'], 32);
  if (employeeId === null || taskId === null || state === null) return null;
  if (!AGENT_STATES.includes(state)) return null;
  return {
    employeeId,
    taskId,
    state: state as AgentTaskState,
    note: nullableStr(value['note'], NOTE_MAX),
    at: isoOr(value['at'], fallbackAt),
  };
}

/**
 * Parse an inbound frame. Returns null for anything unrecognised rather than
 * throwing — an old server, a truncated send or a frame from a future protocol
 * version is an expected condition on a long-lived socket, not an exception.
 */
export function decodeDashboardFrame(raw: string): DashboardInbound | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const now = new Date().toISOString();
  const at = isoOr(parsed['ts'] ?? parsed['at'], now);
  const type = str(parsed['type'], 64);
  if (type === null) return null;

  switch (type) {
    case 'presence.snapshot': {
      const raws = parsed['rows'] ?? parsed['employees'];
      if (!Array.isArray(raws)) return null;
      const rows: PresenceRow[] = [];
      for (const entry of raws) {
        const row = toPresenceRow(entry, at);
        if (row !== null) rows.push(row);
      }
      return { type: 'presence.snapshot', at, rows };
    }
    case 'presence.changed': {
      const row = toPresenceRow(parsed['row'] ?? parsed['payload'], at);
      return row === null ? null : { type: 'presence.changed', at, row };
    }
    case 'agent.status': {
      const row = toAgentStatusRow(parsed['row'] ?? parsed['payload'], at);
      return row === null ? null : { type: 'agent.status', at, row };
    }
    case 'meeting.status': {
      const source = parsed['row'] ?? parsed['payload'];
      if (!isRecord(source)) return null;
      const meetingId = str(source['meetingId'], 64);
      const status = str(source['status'], 32);
      if (meetingId === null || status === null) return null;
      return { type: 'meeting.status', at, row: { meetingId, status, at } };
    }
    case 'pong':
      return { type: 'pong', at };
    default:
      return null;
  }
}

export function encodeDashboardFrame(message: DashboardOutbound): string {
  return JSON.stringify(message);
}

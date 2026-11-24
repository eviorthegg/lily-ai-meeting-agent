import { buildTeam } from '@/lib/api/fixtures';
import { encodeDashboardFrame, type PresenceRow } from './protocol';

/**
 * Transport for the live channel.
 *
 * One interface, two implementations, chosen by the same env var that chooses
 * the API adapter. The reconnection policy, staleness clock and degraded
 * rendering all live above this line, so they are exercised identically whether
 * the frames come from API Gateway or from the fixture — which is the only way
 * to be confident the degraded path works before the real socket exists.
 */

export interface TransportHandlers {
  onOpen: () => void;
  onFrame: (raw: string) => void;
  /** Called once per closure. The provider decides whether to retry. */
  onClose: (reason: string) => void;
}

export interface TransportHandle {
  send: (raw: string) => void;
  close: () => void;
}

export type TransportFactory = (handlers: TransportHandlers) => TransportHandle;

// ---------------------------------------------------------------------------
// Real
// ---------------------------------------------------------------------------

export function createWebSocketTransport(url: string, token: string | null): TransportFactory {
  return (handlers) => {
    // The token goes in the query string because the WebSocket API has no
    // header on the upgrade — this is what $connect reads. It is a short-lived
    // access token, and the connection is wss in every deployed stage.
    const target = token === null ? url : `${url}?token=${encodeURIComponent(token)}`;

    let socket: WebSocket | null = null;
    let closedOnce = false;

    const closeOnce = (reason: string) => {
      if (closedOnce) return;
      closedOnce = true;
      handlers.onClose(reason);
    };

    try {
      socket = new WebSocket(target);
    } catch {
      // A bad URL throws synchronously. Report it as a normal closure so the
      // provider's backoff handles it instead of the error escaping into render.
      queueMicrotask(() => closeOnce('bad-url'));
      return { send: () => undefined, close: () => undefined };
    }

    socket.onopen = () => handlers.onOpen();
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === 'string') handlers.onFrame(event.data);
    };
    socket.onerror = () => closeOnce('error');
    socket.onclose = (event) => closeOnce(event.reason === '' ? 'closed' : event.reason);

    return {
      send: (raw: string) => {
        if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(raw);
      },
      close: () => {
        closedOnce = true; // A deliberate close is not a drop to retry.
        socket?.close(1000, 'client');
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

interface MockControls {
  drop: () => void;
}

let activeMock: MockControls | null = null;

/**
 * Kill the mock socket from the UI.
 *
 * Exists so the degraded path is demonstrable rather than merely written. A
 * dashboard that has never been seen with its socket down is a dashboard whose
 * offline behaviour is a guess.
 */
export function dropMockSocket(): void {
  activeMock?.drop();
}

/**
 * Scripted presence.
 *
 * It sends a snapshot on connect and then flips one member's state every few
 * seconds, with an agent-status line during the live meeting. Deterministic
 * order, so what you watch twice behaves the same twice.
 */
export function createMockTransport(): TransportFactory {
  return (handlers) => {
    const team = buildTeam();
    const rows: PresenceRow[] = team.map((member) => ({
      employeeId: member.employeeId,
      online: member.daemonOnline,
      dnd: false,
      agentKind: member.agentKind,
      at: member.lastSeenAt ?? new Date().toISOString(),
    }));

    let timer: ReturnType<typeof setInterval> | null = null;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let tick = 0;
    let closed = false;

    const stop = () => {
      if (timer !== null) clearInterval(timer);
      if (openTimer !== null) clearTimeout(openTimer);
      timer = null;
      openTimer = null;
    };

    const closeWith = (reason: string) => {
      if (closed) return;
      closed = true;
      stop();
      if (activeMock !== null) activeMock = null;
      handlers.onClose(reason);
    };

    activeMock = { drop: () => closeWith('simulated-drop') };

    // A real socket is not open in the same tick it is created, and code that
    // assumes otherwise breaks the first time it meets a network.
    openTimer = setTimeout(() => {
      if (closed) return;
      handlers.onOpen();
      handlers.onFrame(
        JSON.stringify({
          v: 1,
          type: 'presence.snapshot',
          ts: new Date().toISOString(),
          rows: rows.map((row) => ({ ...row, at: new Date().toISOString() })),
        }),
      );

      timer = setInterval(() => {
        if (closed) return;
        tick += 1;
        const now = new Date().toISOString();

        // Rotate through the enrolled members so presence visibly changes.
        const enrolled = team.filter((member) => member.daemonEnrolled);
        const subject = enrolled[tick % Math.max(1, enrolled.length)];
        if (subject !== undefined) {
          const next: PresenceRow = {
            employeeId: subject.employeeId,
            // Blinks the rotating member offline for one interval in five. A
            // toggle against the previous value drains everyone to offline over
            // a long session, which is a fixture artefact rather than a state
            // worth designing against.
            online: tick % 5 !== 0,
            dnd: tick % 11 === 0,
            agentKind: subject.agentKind,
            at: now,
          };
          const index = rows.findIndex((row) => row.employeeId === subject.employeeId);
          if (index >= 0) rows[index] = next;
          handlers.onFrame(
            JSON.stringify({ v: 1, type: 'presence.changed', ts: now, row: next }),
          );
        }

        // Agent work in the live meeting, so the task column moves too.
        const states = ['queued', 'running', 'awaiting_permission', 'running', 'done'] as const;
        const state = states[tick % states.length] ?? 'running';
        const notes: Readonly<Record<string, string>> = {
          queued: 'waiting for a slot',
          running: 'searching the repo',
          awaiting_permission: 'asking to run the test suite',
          done: 'finished',
        };
        handlers.onFrame(
          JSON.stringify({
            v: 1,
            type: 'agent.status',
            ts: now,
            row: {
              employeeId: 'emp_noa',
              taskId: 'tsk_demo_1',
              state,
              note: notes[state] ?? null,
            },
          }),
        );
      }, 4_000);
    }, 300);

    return {
      send: () => undefined,
      close: () => {
        closed = true;
        stop();
        activeMock = null;
      },
    };
  };
}

/** Shared by both transports so the provider's keepalive is transport-agnostic. */
export function pingFrame(): string {
  return encodeDashboardFrame({ v: 1, type: 'ping', ts: new Date().toISOString() });
}

export function helloFrame(): string {
  return encodeDashboardFrame({ v: 1, type: 'dashboard.hello', ts: new Date().toISOString() });
}

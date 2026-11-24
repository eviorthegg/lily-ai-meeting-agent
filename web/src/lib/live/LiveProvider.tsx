import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { wsBaseUrl } from '@/config/env';
import { isMockApi } from '@/lib/api';
import { useAuth } from '@/lib/auth/AuthProvider';
import { decodeDashboardFrame, type AgentStatusRow, type PresenceRow } from './protocol';
import {
  createMockTransport,
  createWebSocketTransport,
  dropMockSocket,
  helloFrame,
  pingFrame,
  type TransportHandle,
} from './transport';

/**
 * Live presence and in-meeting task status.
 *
 * The hard requirement this is built around is the failure case, not the happy
 * one. When the socket is down the team table must show what was last known and
 * when it was true — never a spinner that never resolves, and never a green
 * "online" badge that is quietly a lie. So:
 *
 *  - `connection` is a real state machine, surfaced in the UI, not a boolean.
 *  - Presence is only authoritative while `isLive` is true. Consumers that read
 *    `presenceFor()` get a `source` field and are expected to render it.
 *  - Frames stop arriving without the socket closing more often than people
 *    expect (a sleeping laptop, a dead NAT binding). A silence timer marks the
 *    connection `stale` on its own, which is why there is a keepalive at all.
 *  - Reconnection backs off and jitters. A dashboard left open on twenty desks
 *    reconnecting in lockstep every second is a self-inflicted outage.
 */

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  /** Open, but nothing has arrived for longer than the silence window. */
  | 'stale'
  | 'reconnecting'
  /** Given up for now; only a manual retry or a dependency change revives it. */
  | 'offline';

export interface LivePresence {
  online: boolean;
  dnd: boolean;
  agentKind: string | null;
  /** ISO time the fact was observed. Rendered, always. */
  at: string;
  source: 'live' | 'stale';
}

interface LiveContextValue {
  connection: ConnectionState;
  /** True only when presence can be shown as current. */
  isLive: boolean;
  lastFrameAt: number | null;
  presenceFor: (employeeId: string) => LivePresence | null;
  agentStatusFor: (taskId: string) => AgentStatusRow | null;
  agentStatuses: readonly AgentStatusRow[];
  retryNow: () => void;
  /** Mock builds only. Null against a real socket. */
  simulateDrop: (() => void) | null;
}

const LiveContext = createContext<LiveContextValue | null>(null);

/** No frame for this long and the connection is not trustworthy any more. */
const SILENCE_MS = 45_000;
const PING_MS = 20_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const MAX_ATTEMPTS = 12;

export function LiveProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, org } = useAuth();
  const enabled = isAuthenticated && org !== null;

  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [presence, setPresence] = useState<ReadonlyMap<string, PresenceRow>>(new Map());
  const [agentStatus, setAgentStatus] = useState<ReadonlyMap<string, AgentStatusRow>>(new Map());
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const handleRef = useRef<TransportHandle | null>(null);
  const attemptRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setConnection('idle');
      return;
    }

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let silenceTimer: ReturnType<typeof setInterval> | null = null;

    const clearTimers = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (pingTimer !== null) clearInterval(pingTimer);
      if (silenceTimer !== null) clearInterval(silenceTimer);
      retryTimer = null;
      pingTimer = null;
      silenceTimer = null;
    };

    const open = () => {
      if (disposed) return;
      setConnection(attemptRef.current === 0 ? 'connecting' : 'reconnecting');

      const factory = isMockApi
        ? createMockTransport()
        : // The access token is held in memory by the api module and is not
          // readable from here, so the real socket authenticates with the
          // refresh cookie the API already sets. If the deployed $connect wants
          // a query-string token instead, this is the single line to change.
          createWebSocketTransport(`${wsBaseUrl}/dashboard`, null);

      handleRef.current = factory({
        onOpen: () => {
          if (disposed) return;
          attemptRef.current = 0;
          setConnection('open');
          lastFrameRef.current = Date.now();
          setLastFrameAt(lastFrameRef.current);
          handleRef.current?.send(helloFrame());

          pingTimer = setInterval(() => handleRef.current?.send(pingFrame()), PING_MS);
          silenceTimer = setInterval(() => {
            const last = lastFrameRef.current;
            if (last !== null && Date.now() - last > SILENCE_MS) {
              // Open but silent. Not a closure, so nothing else would notice.
              setConnection((current) => (current === 'open' ? 'stale' : current));
            }
          }, 5_000);
        },

        onFrame: (raw) => {
          if (disposed) return;
          const frame = decodeDashboardFrame(raw);
          if (frame === null) return; // Unrecognised frames are dropped, not fatal.

          lastFrameRef.current = Date.now();
          setLastFrameAt(lastFrameRef.current);
          setConnection((current) => (current === 'stale' ? 'open' : current));

          switch (frame.type) {
            case 'presence.snapshot':
              setPresence(new Map(frame.rows.map((row) => [row.employeeId, row])));
              break;
            case 'presence.changed':
              setPresence((current) => {
                const next = new Map(current);
                next.set(frame.row.employeeId, frame.row);
                return next;
              });
              break;
            case 'agent.status':
              setAgentStatus((current) => {
                const next = new Map(current);
                next.set(frame.row.taskId, frame.row);
                return next;
              });
              break;
            case 'meeting.status':
            case 'pong':
              break;
          }
        },

        onClose: () => {
          if (disposed) return;
          clearTimers();
          handleRef.current = null;

          attemptRef.current += 1;
          if (attemptRef.current > MAX_ATTEMPTS) {
            setConnection('offline');
            return;
          }

          setConnection('reconnecting');
          const step = BACKOFF_MS[Math.min(attemptRef.current - 1, BACKOFF_MS.length - 1)] ?? 15_000;
          // Jitter, so a room full of dashboards does not reconnect in unison.
          const wait = step * (0.7 + Math.random() * 0.6);
          retryTimer = setTimeout(open, wait);
        },
      });
    };

    attemptRef.current = 0;
    open();

    return () => {
      disposed = true;
      clearTimers();
      handleRef.current?.close();
      handleRef.current = null;
    };
  }, [enabled, retryNonce]);

  // A tab that was in the background for an hour has a socket the OS may have
  // killed without telling anyone. Coming back to the foreground is the cheapest
  // possible signal that it is worth checking.
  useEffect(() => {
    if (!enabled) return;
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      const last = lastFrameRef.current;
      if (last === null || Date.now() - last > SILENCE_MS) setRetryNonce((value) => value + 1);
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled]);

  const isLive = connection === 'open';

  const presenceFor = useCallback(
    (employeeId: string): LivePresence | null => {
      const row = presence.get(employeeId);
      if (row === undefined) return null;
      return {
        online: row.online,
        dnd: row.dnd,
        agentKind: row.agentKind,
        at: row.at,
        source: isLive ? 'live' : 'stale',
      };
    },
    [presence, isLive],
  );

  const agentStatusFor = useCallback(
    (taskId: string): AgentStatusRow | null => agentStatus.get(taskId) ?? null,
    [agentStatus],
  );

  const agentStatuses = useMemo(() => [...agentStatus.values()], [agentStatus]);

  const retryNow = useCallback(() => {
    attemptRef.current = 0;
    setRetryNonce((value) => value + 1);
  }, []);

  const value = useMemo<LiveContextValue>(
    () => ({
      connection,
      isLive,
      lastFrameAt,
      presenceFor,
      agentStatusFor,
      agentStatuses,
      retryNow,
      simulateDrop: isMockApi ? dropMockSocket : null,
    }),
    [connection, isLive, lastFrameAt, presenceFor, agentStatusFor, agentStatuses, retryNow],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  const value = useContext(LiveContext);
  if (value === null) throw new Error('useLive must be used inside <LiveProvider>.');
  return value;
}

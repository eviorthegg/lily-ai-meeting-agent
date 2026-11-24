import WebSocket from 'ws';
import {
  decodeFromServer,
  encode,
  type ServerToDaemon,
} from '@lily/shared';
import { Backoff, type BackoffOptions } from './backoff.js';
import { errText, log } from './log.js';

/**
 * The daemon's link to Lily.
 *
 * Outbound WSS only. The daemon never listens on a network port — it lives on a
 * laptop behind NAT, on hotel wifi, inside corporate egress proxies, and the only
 * connection topology that survives all of those is one the employee's machine
 * initiates. That single decision is also what makes the security story
 * defensible: there is no inbound surface to attack.
 *
 * Everything arriving on this socket crosses a trust boundary and is validated
 * with the protocol's own `decodeFromServer` before it can reach any handler. A
 * frame that fails validation is counted and dropped, never partially applied.
 */

/** Payload types, projected out of the protocol's discriminated union. */
type ServerPayload<T extends ServerToDaemon['type']> = Extract<
  ServerToDaemon,
  { type: T }
>['payload'];

export type TaskDispatch = ServerPayload<'task.dispatch'>;
export type PermissionResponse = ServerPayload<'permission.response'>;
export type TaskCancel = ServerPayload<'task.cancel'>;
export type TokenRotate = ServerPayload<'token.rotate'>;
export type ConnectionRevoked = ServerPayload<'connection.revoked'>;

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'revoked'
  | 'stopped';

// ---------------------------------------------------------------------------
// Socket seam
// ---------------------------------------------------------------------------

/**
 * The bits of a WebSocket this class uses.
 *
 * Injected rather than imported directly so the reconnect, heartbeat and frame
 * validation logic can be tested without a server — the parts most likely to
 * carry a bug are also the parts hardest to reach through a real socket.
 */
export interface DaemonSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number) => void): void;
  onError(handler: (error: Error) => void): void;
}

export type SocketFactory = (url: string, headers: Readonly<Record<string, string>>) => DaemonSocket;

function normalizeRaw(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}

export const wsSocketFactory: SocketFactory = (url, headers) => {
  const socket = new WebSocket(url, { headers: { ...headers } });
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onOpen: (handler) => socket.on('open', handler),
    onMessage: (handler) => socket.on('message', (data) => handler(normalizeRaw(data))),
    onClose: (handler) => socket.on('close', (code: number) => handler(code)),
    onError: (handler) => socket.on('error', handler),
  };
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ConnectionHandlers {
  onDispatch(payload: TaskDispatch): void;
  onPermissionResponse(payload: PermissionResponse): void;
  onCancel(payload: TaskCancel): void;
  /** Persist the rotated token. Awaited before the next reconnect can use it. */
  onTokenRotate(payload: TokenRotate): Promise<void> | void;
  /** Terminal. The daemon has been unenrolled or its token reused elsewhere. */
  onRevoked(payload: ConnectionRevoked): void;
  onStateChange?(state: ConnectionState): void;
}

export interface ConnectionOptions {
  readonly wsUrl: string;
  readonly employeeId: string;
  readonly agentKind: string;
  /** MCP server and tool NAMES only. Never anything those tools can see. */
  readonly capabilities: readonly string[];
  readonly daemonVersion: string;
  readonly platform: 'darwin' | 'linux' | 'win32';
  /** Re-read on every connect: the token rotates on a schedule AND on reconnect. */
  readonly getToken: () => Promise<string>;
  /** Employee-owned DND, sampled on every heartbeat. */
  readonly isDnd: () => boolean;
  readonly handlers: ConnectionHandlers;
  readonly heartbeatMs?: number;
  readonly backoff?: BackoffOptions;
  readonly socketFactory?: SocketFactory;
}

/**
 * Consecutive invalid frames tolerated before the socket is recycled.
 *
 * A handful is noise — a partial send, a server mid-deploy. A stream of them
 * means this daemon and the server no longer agree on the protocol, and
 * reconnecting is more useful than processing garbage indefinitely.
 */
const MAX_MALFORMED_FRAMES = 20;

export class DaemonConnection {
  readonly #options: ConnectionOptions;
  readonly #factory: SocketFactory;
  readonly #backoff: Backoff;
  readonly #heartbeatMs: number;

  #socket: DaemonSocket | null = null;
  #state: ConnectionState = 'idle';
  #heartbeat: NodeJS.Timeout | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #revoked = false;
  #malformed = 0;
  #totalMalformed = 0;
  #connectedAt: number | null = null;

  constructor(options: ConnectionOptions) {
    this.#options = options;
    this.#factory = options.socketFactory ?? wsSocketFactory;
    this.#backoff = new Backoff(options.backoff ?? {});
    // Well inside any sane idle timeout on an API Gateway WebSocket, and frequent
    // enough that presence in the meeting UI does not lag a disconnect.
    this.#heartbeatMs = options.heartbeatMs ?? 25_000;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get isConnected(): boolean {
    return this.#state === 'connected';
  }

  get connectedSince(): number | null {
    return this.#connectedAt;
  }

  /** Cumulative count of frames rejected by the protocol decoder. Surfaced by `doctor`. */
  get malformedFrameCount(): number {
    return this.#totalMalformed;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.#stopped || this.#revoked) return;
    void this.#connect();
  }

  /** Deliberate local shutdown. Distinct from revocation: this one may be restarted. */
  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    this.#socket?.close(1000, 'daemon shutting down');
    this.#socket = null;
    this.#setState('stopped');
  }

  async #connect(): Promise<void> {
    if (this.#stopped || this.#revoked) return;
    this.#setState(this.#backoff.attempt === 0 ? 'connecting' : 'reconnecting');

    let token: string;
    try {
      token = await this.#options.getToken();
    } catch (cause) {
      // An unreadable token is usually a keychain that is locked, not a permanent
      // failure, so this retries rather than giving up.
      log.error('connection.token_unavailable', { error: errText(cause) });
      this.#scheduleReconnect();
      return;
    }

    let socket: DaemonSocket;
    try {
      socket = this.#factory(this.#buildUrl(token), {
        // Preferred transport for the token: headers do not end up in access logs
        // or browser history the way a query string does.
        authorization: `Bearer ${token}`,
        'x-lily-protocol': '1',
      });
    } catch (cause) {
      log.error('connection.socket_create_failed', { error: errText(cause) });
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;
    let settled = false;

    socket.onOpen(() => {
      this.#connectedAt = Date.now();
      this.#malformed = 0;
      // Reset only once the socket is actually up, so a server that accepts and
      // immediately drops connections still backs off.
      this.#backoff.reset();
      this.#setState('connected');
      log.info('connection.open', { employeeId: this.#options.employeeId });

      this.#sendHello();
      this.#startHeartbeat();
    });

    socket.onMessage((data) => {
      this.handleFrame(data);
    });

    socket.onError((error) => {
      // 'error' is always followed by 'close', so recovery is driven from there.
      log.warn('connection.error', { error: errText(error) });
    });

    socket.onClose((code) => {
      if (settled) return;
      settled = true;
      this.#stopHeartbeat();
      this.#connectedAt = null;
      this.#socket = null;

      if (this.#revoked) {
        log.warn('connection.closed_revoked', { code });
        this.#setState('revoked');
        return;
      }
      if (this.#stopped) {
        this.#setState('stopped');
        return;
      }

      log.warn('connection.closed', { code, attempt: this.#backoff.attempt });
      this.#scheduleReconnect();
    });
  }

  /**
   * The local WS shim authenticates from the query string, deployed stages read
   * the Authorization header. Both are sent; the header is the one that should be
   * relied on in production, because query strings are captured by proxy and
   * gateway access logs.
   */
  #buildUrl(token: string): string {
    const url = new URL(this.#options.wsUrl);
    url.searchParams.set('token', token);
    return url.toString();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#revoked) return;

    const delay = this.#backoff.next();
    this.#setState('reconnecting');
    log.info('connection.retry_scheduled', { delayMs: delay, attempt: this.#backoff.attempt });

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.#connect();
    }, delay);
  }

  #clearTimers(): void {
    this.#stopHeartbeat();
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeat = setInterval(() => {
      // DND rides on every beat rather than only on change, so the server
      // converges even if a `dnd.set` was lost across a reconnect.
      this.#send('presence.heartbeat', { dnd: this.#options.isDnd() });
    }, this.#heartbeatMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }

  #setState(next: ConnectionState): void {
    if (this.#state === next) return;
    this.#state = next;
    this.#options.handlers.onStateChange?.(next);
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /**
   * Validate and dispatch one inbound frame.
   *
   * Public so the frame-handling path can be exercised directly in tests. Never
   * throws: a malformed frame is an expected condition — an old server, a
   * truncated send, or something hostile — and must not take the daemon down.
   */
  handleFrame(raw: string | Buffer): { ok: boolean; error?: string } {
    const decoded = decodeFromServer(raw);

    if (!decoded.ok) {
      this.#malformed += 1;
      this.#totalMalformed += 1;
      // The rejection reason is a schema path, never the frame body — a bad frame
      // could contain anything and logging it would defeat the data policy.
      log.warn('connection.frame_rejected', { reason: decoded.error, streak: this.#malformed });

      if (this.#malformed >= MAX_MALFORMED_FRAMES) {
        log.error('connection.frame_rejection_limit', { limit: MAX_MALFORMED_FRAMES });
        this.#malformed = 0;
        this.#socket?.close(1002, 'protocol violation');
      }
      return { ok: false, error: decoded.error };
    }

    this.#malformed = 0;
    this.#route(decoded.message);
    return { ok: true };
  }

  #route(message: ServerToDaemon): void {
    const { handlers } = this.#options;

    try {
      switch (message.type) {
        case 'task.dispatch':
          handlers.onDispatch(message.payload);
          return;

        case 'permission.response':
          handlers.onPermissionResponse(message.payload);
          return;

        case 'task.cancel':
          handlers.onCancel(message.payload);
          return;

        case 'token.rotate':
          void this.#rotateToken(message.payload);
          return;

        case 'connection.revoked':
          this.#handleRevoked(message.payload);
          return;
      }
    } catch (cause) {
      // A throwing handler must not kill the socket; the next frame may be fine.
      log.error('connection.handler_failed', { type: message.type, error: errText(cause) });
    }
  }

  async #rotateToken(payload: TokenRotate): Promise<void> {
    try {
      await this.#options.handlers.onTokenRotate(payload);
      log.info('connection.token_rotated', { rotatesAt: payload.rotatesAt });
    } catch (cause) {
      // The old token stays valid until the server says otherwise, so a failed
      // persist is loud but not fatal — the next reconnect will rotate again.
      log.error('connection.token_persist_failed', { error: errText(cause) });
    }
  }

  /**
   * Revocation is terminal and deliberately unrecoverable in-process.
   *
   * This means the employee was removed, or the same device token was seen from
   * somewhere else. Either way, retrying would be a client repeatedly presenting
   * a credential it has been told is no longer valid — so the retry loop is shut
   * off entirely rather than backed off.
   */
  #handleRevoked(payload: ConnectionRevoked): void {
    this.#revoked = true;
    this.#clearTimers();
    log.error('connection.revoked', { reason: payload.reason });

    try {
      this.#options.handlers.onRevoked(payload);
    } finally {
      this.#socket?.close(1000, 'revoked');
      this.#socket = null;
      this.#setState('revoked');
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  #send(type: string, payload: unknown): boolean {
    if (this.#socket === null || this.#state !== 'connected') {
      // Dropped rather than queued. A status update for a meeting that has since
      // moved on is worse than no update, and queued permission requests could be
      // voiced long after the moment they referred to.
      log.debug('connection.send_dropped', { type, state: this.#state });
      return false;
    }

    try {
      this.#socket.send(encode({ type, payload }));
      return true;
    } catch (cause) {
      log.warn('connection.send_failed', { type, error: errText(cause) });
      return false;
    }
  }

  sendHello(): boolean {
    return this.#sendHello();
  }

  #sendHello(): boolean {
    return this.#send('daemon.hello', {
      employeeId: this.#options.employeeId,
      agentKind: this.#options.agentKind,
      capabilities: [...this.#options.capabilities],
      daemonVersion: this.#options.daemonVersion,
      platform: this.#options.platform,
    });
  }

  sendStatus(
    taskId: string,
    state: 'queued' | 'running' | 'awaiting_permission' | 'done' | 'failed',
    note?: string,
  ): boolean {
    return this.#send('agent.status', {
      taskId,
      state,
      // Omitted rather than sent as undefined: the schema treats an absent note
      // and a present-but-undefined one differently.
      ...(note === undefined ? {} : { note: note.slice(0, 200) }),
    });
  }

  sendResult(result: {
    taskId: string;
    ok: boolean;
    answer: string;
    truncated: boolean;
    error?: string;
  }): boolean {
    return this.#send('task.result', {
      taskId: result.taskId,
      ok: result.ok,
      answer: result.answer,
      truncated: result.truncated,
      ...(result.error === undefined ? {} : { error: result.error.slice(0, 500) }),
    });
  }

  sendPermissionRequest(request: {
    taskId: string;
    requestId: string;
    kind: string;
    detail: string;
    reason?: string;
  }): boolean {
    return this.#send('permission.request', {
      taskId: request.taskId,
      requestId: request.requestId,
      kind: request.kind,
      detail: request.detail,
      ...(request.reason === undefined ? {} : { reason: request.reason.slice(0, 300) }),
    });
  }

  sendDnd(enabled: boolean): boolean {
    return this.#send('dnd.set', { enabled });
  }
}

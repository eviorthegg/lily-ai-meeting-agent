/**
 * Real daemon connections, over the documented wire protocol.
 *
 * A WebSocket server the employee daemon dials directly. In a deployed stage
 * the daemon connects to the API's WebSocket endpoint and the API relays; when
 * the orchestrator is the local process the hop is not useful, so the daemon
 * points at this port instead. The frames on the wire are byte-identical either
 * way — `encode` / `decodeFromDaemon` from `@lily/shared/protocol` on both
 * sides, `PROTOCOL_VERSION` enforced by the envelope schema.
 *
 * Every inbound frame is validated before it is looked at. The daemon runs on
 * someone's laptop; that it speaks our protocol is a hope, not a fact.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { daemonHelloSchema, decodeFromDaemon, encode } from '@lily/shared/protocol';
import { log } from '../util/log.js';
import {
  DaemonNotConnectedError,
  Emitter,
  type AgentStatus,
  type DaemonLink,
  type FromEmployee,
  type PermissionRequest,
  type PermissionResponse,
  type TaskCancel,
  type TaskDispatch,
  type TaskResult,
  type Unsubscribe,
} from './link.js';

interface Connection {
  readonly socket: WebSocket;
  employeeId: string | null;
  agentKind: string | null;
  capabilities: readonly string[];
  dnd: boolean;
}

export interface WsDaemonLinkOptions {
  readonly port?: number;
  readonly host?: string;
  /**
   * Called before a daemon is accepted. Returns the employeeId the connection
   * is allowed to act as, or null to reject.
   *
   * Locally this is roster membership. In a deployed stage it is the hashed
   * device-token lookup — which is the API's job, and why this hook is injected
   * rather than implemented here.
   */
  readonly authorize?: (hello: {
    employeeId: string;
    agentKind: string;
    token: string | null;
  }) => boolean;
}

export class WsDaemonLink implements DaemonLink {
  readonly kind = 'websocket' as const;

  readonly #options: WsDaemonLinkOptions;
  readonly #connections = new Set<Connection>();
  readonly #byEmployee = new Map<string, Connection>();

  readonly #status = new Emitter<[FromEmployee<AgentStatus>]>();
  readonly #result = new Emitter<[FromEmployee<TaskResult>]>();
  readonly #permission = new Emitter<[FromEmployee<PermissionRequest>]>();
  readonly #presence = new Emitter<[string, boolean]>();

  #http: Server | null = null;
  #wss: WebSocketServer | null = null;

  constructor(options: WsDaemonLinkOptions = {}) {
    this.#options = options;
  }

  get url(): string {
    const address = this.#http?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      return `ws://${this.#options.host ?? '127.0.0.1'}:${this.#options.port ?? 0}/daemon`;
    }
    return `ws://${this.#options.host ?? '127.0.0.1'}:${(address as AddressInfo).port}/daemon`;
  }

  async listen(): Promise<string> {
    if (this.#http !== null) return this.url;

    const http = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('This endpoint speaks the Lily daemon WebSocket protocol.');
    });
    const wss = new WebSocketServer({ noServer: true });

    http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path !== '/daemon') {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        this.#accept(client, req);
      });
    });

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(this.#options.port ?? 0, this.#options.host ?? '127.0.0.1', () => {
        http.removeListener('error', reject);
        resolve();
      });
    });

    this.#http = http;
    this.#wss = wss;
    log.info('daemon_link.listening', { url: this.url });
    return this.url;
  }

  connectedEmployees(): readonly string[] {
    return [...this.#byEmployee.keys()];
  }

  isConnected(employeeId: string): boolean {
    return this.#byEmployee.has(employeeId);
  }

  isDnd(employeeId: string): boolean {
    return this.#byEmployee.get(employeeId)?.dnd ?? false;
  }

  async dispatch(employeeId: string, payload: TaskDispatch): Promise<void> {
    this.#send(employeeId, 'task.dispatch', payload);
  }

  async cancel(employeeId: string, payload: TaskCancel): Promise<void> {
    // A cancel for a daemon that has already gone is not an error: the task
    // died with the connection.
    if (!this.isConnected(employeeId)) return;
    this.#send(employeeId, 'task.cancel', payload);
  }

  async respondToPermission(employeeId: string, payload: PermissionResponse): Promise<void> {
    this.#send(employeeId, 'permission.response', payload);
  }

  onStatus(handler: (event: FromEmployee<AgentStatus>) => void): Unsubscribe {
    return this.#status.on(handler);
  }
  onResult(handler: (event: FromEmployee<TaskResult>) => void): Unsubscribe {
    return this.#result.on(handler);
  }
  onPermissionRequest(handler: (event: FromEmployee<PermissionRequest>) => void): Unsubscribe {
    return this.#permission.on(handler);
  }
  onPresenceChange(handler: (employeeId: string, connected: boolean) => void): Unsubscribe {
    return this.#presence.on(handler);
  }

  async close(): Promise<void> {
    for (const connection of this.#connections) {
      try {
        connection.socket.close(1001, 'meeting ended');
      } catch {
        // Already gone.
      }
    }
    this.#connections.clear();
    this.#byEmployee.clear();

    this.#wss?.close();
    const http = this.#http;
    if (http !== null) {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections?.();
      });
    }
    this.#http = null;
    this.#wss = null;
  }

  // -------------------------------------------------------------------------

  #send(employeeId: string, type: string, payload: unknown): void {
    const connection = this.#byEmployee.get(employeeId);
    if (connection === undefined) throw new DaemonNotConnectedError(employeeId);
    connection.socket.send(encode({ type, payload }));
  }

  #accept(socket: WebSocket, req: IncomingMessage): void {
    const connection: Connection = {
      socket,
      employeeId: null,
      agentKind: null,
      capabilities: [],
      dnd: false,
    };
    this.#connections.add(connection);

    const token = extractToken(req);

    socket.on('message', (raw: Buffer | string) => {
      const decoded = decodeFromDaemon(typeof raw === 'string' ? raw : raw);
      if (!decoded.ok) {
        // Closing with a reason beats mis-parsing a frame from an old client.
        log.warn('daemon_link.rejected_frame', { reason: decoded.error.slice(0, 160) });
        socket.close(1008, 'protocol violation');
        return;
      }

      const message = decoded.message;

      if (message.type === 'daemon.hello') {
        const hello = daemonHelloSchema.parse(message.payload);
        const allowed =
          this.#options.authorize?.({
            employeeId: hello.employeeId,
            agentKind: hello.agentKind,
            token,
          }) ?? true;

        if (!allowed) {
          log.warn('daemon_link.unauthorized', { employeeId: hello.employeeId });
          socket.close(1008, 'not authorized for this meeting');
          return;
        }

        connection.employeeId = hello.employeeId;
        connection.agentKind = hello.agentKind;
        connection.capabilities = hello.capabilities;

        // Last connection wins: a daemon that reconnected after a network blip
        // must supersede the stale socket, not sit behind it.
        this.#byEmployee.set(hello.employeeId, connection);
        this.#presence.emit(hello.employeeId, true);
        log.info('daemon_link.hello', {
          employeeId: hello.employeeId,
          agentKind: hello.agentKind,
          capabilityCount: hello.capabilities.length,
        });
        return;
      }

      const employeeId = connection.employeeId;
      if (employeeId === null) {
        socket.close(1008, 'daemon.hello must be the first message');
        return;
      }

      switch (message.type) {
        case 'presence.heartbeat':
          connection.dnd = message.payload.dnd;
          return;
        case 'dnd.set':
          connection.dnd = message.payload.enabled;
          return;
        case 'agent.status':
          this.#status.emit({ employeeId, payload: message.payload });
          return;
        case 'task.result':
          this.#result.emit({ employeeId, payload: message.payload });
          return;
        case 'permission.request':
          this.#permission.emit({ employeeId, payload: message.payload });
          return;
      }
    });

    const drop = (): void => {
      this.#connections.delete(connection);
      const employeeId = connection.employeeId;
      if (employeeId !== null && this.#byEmployee.get(employeeId) === connection) {
        this.#byEmployee.delete(employeeId);
        this.#presence.emit(employeeId, false);
      }
    };

    socket.on('close', drop);
    socket.on('error', drop);
  }
}

/**
 * Read the device token from the handshake.
 *
 * Header first. The query string is accepted because some WebSocket clients
 * cannot set headers on the upgrade, but a token there lands in access logs, so
 * it is a fallback and not the documented path.
 */
function extractToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }
  const url = req.url ?? '';
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return null;
  return new URLSearchParams(url.slice(queryStart + 1)).get('token');
}

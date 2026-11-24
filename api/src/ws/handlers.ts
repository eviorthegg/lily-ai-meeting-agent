import type { ObjectId } from 'mongodb';
import {
  decodeFromDaemon,
  encode,
  type DaemonToServer,
  type WsPusher,
} from '@lily/shared';
import { connections, users } from '../db/collections.js';

/**
 * WebSocket route handlers.
 *
 * These run unchanged in all three stages. In dev/prod they are invoked by API
 * Gateway; locally they are invoked by the shim in ../local/ws-shim.ts, which
 * reproduces the same event contract. That is the whole point of the shim —
 * local development exercises this exact code rather than a parallel mock.
 *
 * The API Gateway route selection expression is `$request.body.type`, which is
 * why the protocol envelope carries `type` at the top level.
 */

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DaemonIdentity {
  userId: ObjectId;
  orgId: ObjectId;
  employeeId: string;
}

/**
 * Verifies a daemon device token.
 *
 * Injected rather than imported so the WebSocket layer does not hard-depend on
 * the auth module's internals, and so tests can drive these handlers without a
 * real token store.
 */
export interface DaemonAuthenticator {
  verify(rawToken: string): Promise<DaemonIdentity | null>;
}

export interface WsDeps {
  auth: DaemonAuthenticator;
  pusher: WsPusher;
  /** Injected for deterministic tests. */
  now?: () => Date;
}

export interface WsEvent {
  connectionId: string;
  routeKey: string;
  body?: string | undefined;
  queryStringParameters?: Record<string, string | undefined> | undefined;
  headers?: Record<string, string | undefined> | undefined;
}

export interface WsResponse {
  statusCode: number;
  body?: string;
}

const ok: WsResponse = { statusCode: 200 };
const unauthorized: WsResponse = { statusCode: 401, body: 'unauthorized' };

/** Connections expire if a container dies without a clean $disconnect. */
const CONNECTION_TTL_SEC = 180;

// ---------------------------------------------------------------------------
// $connect
// ---------------------------------------------------------------------------

/**
 * Token arrives as a query parameter because browsers and most WebSocket
 * clients cannot set arbitrary headers on the upgrade request. It is therefore
 * treated as exposed-in-transit-metadata: short-lived, single-purpose, rotated
 * on every reconnect, and never logged. See SECURITY.md.
 */
export async function handleConnect(event: WsEvent, deps: WsDeps): Promise<WsResponse> {
  const token = event.queryStringParameters?.['token'] ?? extractBearer(event.headers);
  if (token === undefined || token === '') return unauthorized;

  const identity = await deps.auth.verify(token);
  if (identity === null) return unauthorized;

  const now = (deps.now ?? (() => new Date()))();

  const usersCol = await users();
  const user = await usersCol.findOne({ _id: identity.userId });

  // A removed or suspended employee must not be able to reconnect, even holding
  // a token that has not yet been swept.
  if (user === null || user.status === 'removed' || user.status === 'suspended') {
    return unauthorized;
  }

  const connectionsCol = await connections();
  await connectionsCol.updateOne(
    { _id: event.connectionId },
    {
      $set: {
        orgId: identity.orgId,
        userId: identity.userId,
        employeeId: identity.employeeId,
        connectedAt: now,
        lastHeartbeatAt: now,
        // DND defaults to off on connect; the daemon reports its real state in
        // the first heartbeat, which is why heartbeats carry it every time.
        dnd: false,
        agentKind: user.agentKind,
        agentCapabilities: user.agentCapabilities ?? [],
        expiresAt: new Date(now.getTime() + CONNECTION_TTL_SEC * 1000),
      },
    },
    { upsert: true },
  );

  await usersCol.updateOne({ _id: identity.userId }, { $set: { lastSeenAt: now } });

  return ok;
}

function extractBearer(headers?: Record<string, string | undefined>): string | undefined {
  const raw = headers?.['authorization'] ?? headers?.['Authorization'];
  if (raw === undefined) return undefined;
  const [scheme, value] = raw.split(' ');
  return scheme?.toLowerCase() === 'bearer' ? value : undefined;
}

// ---------------------------------------------------------------------------
// $disconnect
// ---------------------------------------------------------------------------

export async function handleDisconnect(event: WsEvent): Promise<WsResponse> {
  const connectionsCol = await connections();
  await connectionsCol.deleteOne({ _id: event.connectionId });
  return ok;
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

export interface MessageContext {
  connectionId: string;
  orgId: ObjectId;
  userId: ObjectId;
  employeeId: string;
  message: DaemonToServer;
  deps: WsDeps;
}

/** Handlers for messages that originate at a daemon, keyed by protocol type. */
export type MessageRouter = {
  [K in DaemonToServer['type']]?: (ctx: MessageContext) => Promise<void>;
};

/**
 * Routes an inbound frame.
 *
 * The connection row is the authority on identity: the frame is NOT trusted to
 * say who it is from. A daemon claiming another employee's id in the payload
 * would otherwise be able to answer on their behalf.
 */
export async function handleMessage(
  event: WsEvent,
  deps: WsDeps,
  router: MessageRouter,
): Promise<WsResponse> {
  const decoded = decodeFromDaemon(event.body ?? '');
  if (!decoded.ok) {
    return { statusCode: 400, body: `invalid frame: ${decoded.error}` };
  }

  const connectionsCol = await connections();
  const connection = await connectionsCol.findOne({ _id: event.connectionId });

  // No connection row means the socket outlived its registration — treat as
  // unauthenticated rather than trusting whatever the frame asserts.
  if (connection === null) return unauthorized;

  const now = (deps.now ?? (() => new Date()))();
  const message = decoded.message;

  // Every frame refreshes the TTL, so an active daemon never expires mid-session.
  const update: Record<string, unknown> = {
    lastHeartbeatAt: now,
    expiresAt: new Date(now.getTime() + CONNECTION_TTL_SEC * 1000),
  };

  if (message.type === 'presence.heartbeat') {
    update['dnd'] = message.payload.dnd;
  } else if (message.type === 'dnd.set') {
    update['dnd'] = message.payload.enabled;
  } else if (message.type === 'daemon.hello') {
    // Capability names only — what the agent can reach, never what it can see.
    update['agentKind'] = message.payload.agentKind;
    update['agentCapabilities'] = message.payload.capabilities;
  }

  await connectionsCol.updateOne({ _id: event.connectionId }, { $set: update });

  if (message.type === 'daemon.hello') {
    const usersCol = await users();
    await usersCol.updateOne(
      { _id: connection.userId },
      {
        $set: {
          agentKind: message.payload.agentKind,
          agentCapabilities: message.payload.capabilities,
          daemonEnrolled: true,
          lastSeenAt: now,
          updatedAt: now,
        },
      },
    );
  }

  const handler = router[message.type];
  if (handler !== undefined) {
    await handler({
      connectionId: event.connectionId,
      orgId: connection.orgId,
      userId: connection.userId,
      employeeId: connection.employeeId,
      message,
      deps,
    });
  }

  return ok;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/**
 * Sends to an employee's daemon.
 *
 * Resolution is by employeeId scoped to org — a task addressed to Employee B
 * can never reach Employee A's agent. Returns false when the employee is not
 * connected or has Do Not Disturb on, which callers must treat as a normal
 * outcome rather than an error: DND is employee-owned and declining is allowed.
 */
export async function sendToEmployee(
  orgId: ObjectId,
  employeeId: string,
  payload: { type: string; payload: unknown },
  pusher: WsPusher,
): Promise<{ delivered: boolean; reason?: 'offline' | 'dnd' }> {
  const connectionsCol = await connections();
  const connection = await connectionsCol.findOne({ orgId, employeeId });

  if (connection === null) return { delivered: false, reason: 'offline' };
  if (connection.dnd) return { delivered: false, reason: 'dnd' };

  const result = await pusher.push(connection._id, JSON.parse(encode(payload)));

  if (result === 'gone') {
    // Authoritative: the socket is dead. Leaving the row would make presence
    // lie and route later dispatches into nothing.
    await connectionsCol.deleteOne({ _id: connection._id });
    return { delivered: false, reason: 'offline' };
  }

  return { delivered: true };
}

/**
 * Revokes an employee's live connection.
 *
 * Called on removal and on token revocation. The acceptance requirement is that
 * this lands within 5 seconds, so it notifies before closing rather than
 * dropping the socket silently — a daemon that knows why it was revoked stops
 * retrying instead of reconnect-looping.
 */
export async function revokeEmployeeConnections(
  orgId: ObjectId,
  userId: ObjectId,
  reason: 'employee_removed' | 'token_revoked' | 'reuse_detected' | 'org_suspended',
  pusher: WsPusher,
): Promise<number> {
  const connectionsCol = await connections();
  const live = await connectionsCol.find({ orgId, userId }).toArray();

  await Promise.all(
    live.map(async (connection) => {
      try {
        await pusher.push(
          connection._id,
          JSON.parse(encode({ type: 'connection.revoked', payload: { reason } })),
        );
      } catch {
        // Best effort — the close below is what actually matters.
      }
      await pusher.disconnect(connection._id);
    }),
  );

  await connectionsCol.deleteMany({ orgId, userId });
  return live.length;
}

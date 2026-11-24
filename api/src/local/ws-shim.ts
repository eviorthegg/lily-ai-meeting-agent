import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { MessageRouter, WsDeps, WsEvent } from '../ws/handlers.js';
import { handleConnect, handleDisconnect, handleMessage } from '../ws/handlers.js';

/**
 * Local reproduction of the API Gateway WebSocket API.
 *
 * `sam local` has no WebSocket support — there is no `sam local start-websocket`
 * — and the daemon connection IS the product, so "everything local" would be
 * meaningless without this. Rather than mocking the daemon, this shim
 * reproduces API Gateway's contract precisely:
 *
 *   - a generated `connectionId` per socket
 *   - `$connect` / `$disconnect` / route-key dispatch, where the route key is
 *     `$request.body.type` exactly as configured in template.yaml
 *   - a non-200 from `$connect` rejects the upgrade
 *   - a management endpoint for server-initiated pushes, returning 410 for a
 *     connection that has gone away
 *
 * The handlers in ../ws/handlers.ts are invoked unchanged, so local development
 * exercises production code rather than a parallel implementation.
 */

export interface WsShimOptions {
  socketPort?: number;
  controlPort?: number;
  deps: WsDeps;
  router: MessageRouter;
  onLog?: (line: string) => void;
}

export interface WsShim {
  socketPort: number;
  controlPort: number;
  connectionCount(): number;
  close(): Promise<void>;
}

export async function startWsShim(options: WsShimOptions): Promise<WsShim> {
  const socketPort = options.socketPort ?? 3001;
  const controlPort = options.controlPort ?? 3002;
  const log = options.onLog ?? ((line: string) => console.info(`[ws-shim] ${line}`));

  const sockets = new Map<string, WebSocket>();

  const socketServer = createServer();
  const wss = new WebSocketServer({ noServer: true });

  // --- upgrade: this is where $connect runs -------------------------------
  socketServer.on('upgrade', (request, socket, head) => {
    void (async () => {
      const connectionId = randomUUID();
      const event = toConnectEvent(connectionId, request);

      let statusCode = 500;
      try {
        ({ statusCode } = await handleConnect(event, options.deps));
      } catch (error) {
        log(`$connect threw: ${(error as Error).message}`);
      }

      // API Gateway refuses the upgrade when $connect is non-200. Reproducing
      // that here is what lets auth failures be tested locally at all.
      if (statusCode !== 200) {
        socket.write(`HTTP/1.1 ${statusCode} Unauthorized\r\n\r\n`);
        socket.destroy();
        log(`rejected connection (${statusCode})`);
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        sockets.set(connectionId, ws);
        log(`connected ${connectionId} (${sockets.size} live)`);

        ws.on('message', (raw: Buffer) => {
          void (async () => {
            const body = raw.toString('utf8');
            try {
              const response = await handleMessage(
                { connectionId, routeKey: routeKeyOf(body), body },
                options.deps,
                options.router,
              );
              if (response.statusCode >= 400) {
                log(`message rejected (${response.statusCode}): ${response.body ?? ''}`);
              }
            } catch (error) {
              log(`message handler threw: ${(error as Error).message}`);
            }
          })();
        });

        ws.on('close', () => {
          sockets.delete(connectionId);
          void handleDisconnect({ connectionId, routeKey: '$disconnect' }).catch(
            (error: unknown) => log(`$disconnect threw: ${(error as Error).message}`),
          );
          log(`disconnected ${connectionId} (${sockets.size} live)`);
        });

        ws.on('error', (error) => log(`socket error: ${error.message}`));
      });
    })();
  });

  // --- control plane: what ApiGatewayManagementApi does in deployed stages --
  const controlServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${controlPort}`);
    const pushMatch = /^\/_control\/push\/(.+)$/.exec(url.pathname);
    const disconnectMatch = /^\/_control\/disconnect\/(.+)$/.exec(url.pathname);

    if (req.method === 'POST' && pushMatch?.[1] !== undefined) {
      const connectionId = decodeURIComponent(pushMatch[1]);
      const ws = sockets.get(connectionId);

      // 410 Gone is the contract API Gateway uses for a stale connection, and
      // callers depend on it to clean up their connectionId mapping.
      if (ws === undefined) {
        res.writeHead(410).end('gone');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        ws.send(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200).end('ok');
      });
      return;
    }

    if (req.method === 'POST' && disconnectMatch?.[1] !== undefined) {
      const connectionId = decodeURIComponent(disconnectMatch[1]);
      const ws = sockets.get(connectionId);
      if (ws === undefined) {
        res.writeHead(410).end('gone');
        return;
      }
      ws.close(1008, 'revoked');
      sockets.delete(connectionId);
      res.writeHead(200).end('ok');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/_control/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, connections: sockets.size }));
      return;
    }

    res.writeHead(404).end('not found');
  });

  await Promise.all([
    listen(socketServer, socketPort, 'websocket'),
    listen(controlServer, controlPort, 'ws control'),
  ]);

  log(`websocket on ws://127.0.0.1:${socketPort}, control on http://127.0.0.1:${controlPort}`);

  return {
    socketPort,
    controlPort,
    connectionCount: () => sockets.size,
    async close() {
      for (const ws of sockets.values()) ws.close(1001, 'shutting down');
      sockets.clear();
      wss.close();
      await Promise.all([closeServer(socketServer), closeServer(controlServer)]);
    },
  };
}

/**
 * API Gateway selects a route with `$request.body.type`, falling back to
 * `$default` when the expression does not resolve. Mirrored here so an
 * unparseable frame takes the same path it would in a deployed stage.
 */
function routeKeyOf(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      const type = (parsed as { type: unknown }).type;
      if (typeof type === 'string') return type;
    }
  } catch {
    // falls through
  }
  return '$default';
}

function toConnectEvent(connectionId: string, request: IncomingMessage): WsEvent {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const queryStringParameters: Record<string, string> = {};
  for (const [key, value] of url.searchParams) queryStringParameters[key] = value;

  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key] = Array.isArray(value) ? value.join(',') : value;
  }

  return { connectionId, routeKey: '$connect', queryStringParameters, headers };
}

function listen(server: Server, port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${port} (${label}) is already in use. Is dev:local already running?`)
          : error,
      );
    });
    server.listen(port, '127.0.0.1', resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

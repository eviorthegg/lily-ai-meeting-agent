import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createProviders, getConfig, type LilyConfig, type Providers } from '@lily/shared';
import { analyticsRoutes } from '../routes/analytics.js';
import { auditRoutes } from '../routes/audit.js';
import { authRoutes } from '../routes/auth.js';
import { daemonRoutes } from '../routes/daemon.js';
import { meetingRoutes } from '../routes/meetings.js';
import { orgRoutes } from '../routes/orgs.js';
import { taskRoutes } from '../routes/tasks.js';
import { teamRoutes } from '../routes/team.js';
import {
  HttpError,
  Router,
  errorResponse,
  type ApiRequest,
  type ApiResponse,
  type Route,
  type RouteDeps,
} from '../routes/http.js';

/**
 * The local HTTP API.
 *
 * `sam local start-api` is deliberately not used. It cannot serve WebSockets —
 * there is no `sam local start-websocket` — and the daemon connection *is* the
 * product, so running the HTTP half under SAM and the socket half under a shim
 * would make local two runtimes with different behaviour.
 *
 * Handlers are framework-free functions taking `ApiRequest` and returning
 * `ApiResponse`, so the same code runs here and behind API Gateway later. This
 * file is only an adapter: parse, route, serialise.
 */

/**
 * Every route the API serves.
 *
 * Order is irrelevant — the router matches on an exact pattern rather than
 * first-prefix-wins — so these are listed in the order someone meets them:
 * authenticate, create an org, fill it with people, connect a machine, then the
 * screens that read what all of that produced.
 */
const ROUTES: readonly Route[] = [
  ...authRoutes,
  ...orgRoutes,
  ...teamRoutes,
  ...daemonRoutes,
  ...meetingRoutes,
  ...taskRoutes,
  ...auditRoutes,
  ...analyticsRoutes,
];

export interface LocalApiOptions {
  readonly port?: number;
  readonly config?: LilyConfig;
  readonly providers?: Providers;
  readonly now?: () => Date;
  readonly onLog?: (line: string) => void;
}

export interface LocalApi {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** Bounded so a malformed or hostile request cannot exhaust memory. */
const MAX_BODY_BYTES = 1_000_000;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'validation_failed', 'Request body too large.');
    chunks.push(buffer);
  }

  if (chunks.length === 0) return null;

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return null;

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'validation_failed', 'Body is not valid JSON.');
  }
}

function toApiRequest(
  req: IncomingMessage,
  url: URL,
  params: Record<string, string>,
  body: unknown,
): ApiRequest {
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    // Lowercased by node already; joined so a repeated header is not silently
    // reduced to its first value.
    if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(',') : value;
  }

  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    params,
    query,
    headers,
    body,
    // Trusting x-forwarded-for is only safe behind a proxy that sets it; locally
    // there is none, so the socket address is the honest answer.
    ip: req.socket.remoteAddress ?? null,
  };
}

export async function startLocalApi(options: LocalApiOptions = {}): Promise<LocalApi> {
  const config = options.config ?? getConfig();
  const providers = options.providers ?? createProviders(config);
  const log = options.onLog ?? ((line: string) => console.info(`[api] ${line}`));
  const port = options.port ?? Number(new URL(config.apiBaseUrl).port || 3000);

  const router = new Router(ROUTES);
  const deps: RouteDeps = { config, providers, now: options.now ?? (() => new Date()) };

  // The dashboard runs on a different port, so it is a cross-origin caller. The
  // allowlist is the configured web origin only — not `*`, because these
  // responses carry authenticated data.
  const allowedOrigin = config.webBaseUrl;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const started = Date.now();

      const cors: Record<string, string> = {
        'access-control-allow-origin': allowedOrigin,
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'access-control-allow-credentials': 'true',
        vary: 'origin',
      };

      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
      }

      let response: ApiResponse;
      try {
        const matched = router.match(req.method ?? 'GET', url.pathname);

        if (matched === 'not_found') {
          response = errorResponse(new HttpError(404, 'not_found', `No route for ${url.pathname}`));
        } else if (matched === 'method_not_allowed') {
          response = errorResponse(
            new HttpError(405, 'not_found', `${req.method} is not allowed on ${url.pathname}`),
          );
        } else {
          const body = await readBody(req);
          response = await matched.handler(toApiRequest(req, url, matched.params, body), deps);
        }
      } catch (error) {
        if (error instanceof HttpError) {
          response = errorResponse(error);
        } else {
          // Unexpected failures are logged in full locally but never returned —
          // a stack trace in a response body is how internal paths leak.
          log(`unhandled: ${(error as Error).stack ?? String(error)}`);
          response = errorResponse(
            new HttpError(500, 'server_error', 'Something went wrong. Check the API log.'),
          );
        }
      }

      log(`${req.method} ${url.pathname} → ${response.status} (${Date.now() - started}ms)`);
      res.writeHead(response.status, { ...cors, ...response.headers }).end(response.body);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is already in use. Is dev:local already running?`)
          : error,
      );
    });
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

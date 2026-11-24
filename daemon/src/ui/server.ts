import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { errText, log } from '../log.js';
import { STATUS_PAGE } from './page.js';

/**
 * Local status and Do Not Disturb page.
 *
 * Bound to 127.0.0.1 only. This is the one HTTP listener the daemon has and it
 * must never be reachable from the network — the whole security posture is
 * "outbound connections only", and a status page that answered on 0.0.0.0 would
 * quietly undo that.
 *
 * Three defences, because a loopback bind alone is not enough once a browser is
 * involved:
 *
 *  1. Loopback bind — nothing off-box can open a socket.
 *  2. Host header allowlist — stops DNS rebinding, where an attacker's page
 *     resolves their domain to 127.0.0.1 and the browser happily connects here
 *     with their origin.
 *  3. A required custom request header on every route — a cross-origin <form> or
 *     img can issue a request but cannot set headers, and anything that could
 *     (fetch/XHR) is forced into a CORS preflight that this server never
 *     approves. No CORS headers are ever sent, so no other origin can read a
 *     response either.
 */

export interface UiTaskView {
  readonly taskId: string;
  readonly label: string;
  readonly mode: string;
  readonly state: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly ok: boolean | null;
}

export interface UiState {
  readonly connection: string;
  readonly employeeId: string;
  readonly agent: { readonly label: string; readonly kind: string };
  readonly capabilities: readonly string[];
  readonly dnd: boolean;
  readonly tokenBackend: string;
  readonly tokenInsecure: boolean;
  readonly daemonVersion: string;
  readonly tasks: readonly UiTaskView[];
}

export interface UiServerDeps {
  readonly port: number;
  readonly getState: () => UiState;
  /** Employee-owned. This is the ONLY path that can change DND. */
  readonly setDnd: (enabled: boolean) => Promise<void>;
}

const REQUIRED_HEADER = 'x-lily-ui';

export class UiServer {
  readonly #deps: UiServerDeps;
  #server: Server | null = null;
  #port = 0;

  constructor(deps: UiServerDeps) {
    this.#deps = deps;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.#handle(req, res).catch((cause: unknown) => {
          log.error('ui.handler_failed', { error: errText(cause) });
          this.#json(res, 500, { error: 'internal error' });
        });
      });

      server.on('error', reject);
      server.listen(this.#deps.port, '127.0.0.1', () => {
        const address = server.address();
        this.#port = typeof address === 'object' && address !== null ? address.port : this.#deps.port;
        this.#server = server;
        log.info('ui.listening', { url: this.url });
        resolve(this.url);
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Only loopback names on our own port are acceptable. */
  #hostAllowed(host: string | undefined): boolean {
    if (host === undefined) return false;
    const allowed = [
      `127.0.0.1:${this.#port}`,
      `localhost:${this.#port}`,
      `[::1]:${this.#port}`,
    ];
    return allowed.includes(host.toLowerCase());
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#hostAllowed(req.headers.host)) {
      this.#json(res, 403, { error: 'bad host' });
      return;
    }

    // An Origin header at all means a browser considers this cross-site; ours is
    // a same-origin page, which sends none for top-level navigations and only
    // ever our own origin for fetch.
    const origin = req.headers.origin;
    if (origin !== undefined && !this.#hostAllowed(origin.replace(/^https?:\/\//, ''))) {
      this.#json(res, 403, { error: 'bad origin' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.#port}`);
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The page is entirely self-contained; nothing external may load or connect.
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(STATUS_PAGE);
      return;
    }

    if (req.headers[REQUIRED_HEADER] !== '1') {
      this.#json(res, 403, { error: `missing ${REQUIRED_HEADER} header` });
      return;
    }

    if (req.method === 'GET' && path === '/api/state') {
      this.#json(res, 200, this.#deps.getState());
      return;
    }

    if (req.method === 'POST' && path === '/api/dnd') {
      const body = await readBody(req);
      let enabled: unknown;
      try {
        enabled = (JSON.parse(body) as { enabled?: unknown }).enabled;
      } catch {
        this.#json(res, 400, { error: 'invalid JSON' });
        return;
      }

      if (typeof enabled !== 'boolean') {
        this.#json(res, 400, { error: 'enabled must be a boolean' });
        return;
      }

      await this.#deps.setDnd(enabled);
      this.#json(res, 200, { dnd: enabled });
      return;
    }

    this.#json(res, 404, { error: 'not found' });
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }
}

/** Bounded: a status page never posts more than a few bytes. */
function readBody(req: IncomingMessage, limit = 4_096): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > limit) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

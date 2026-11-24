/**
 * The pages Lily shows: the shared board, and her own avatar card.
 *
 * ===========================================================================
 * WHY THESE ARE SERVED LOCALLY AND NOT PUT SOMEWHERE PUBLIC
 * ===========================================================================
 * Screensharing works by pointing `getDisplayMedia` at a browser window and
 * letting `--auto-select-desktop-capture-source` pick it by title. That window
 * has to be showing something, and what it shows is this meeting's action
 * items — which are meeting content.
 *
 * So the page is served from 127.0.0.1 inside the same instance, by a server
 * that exists for the length of the share and is torn down with it. Nothing is
 * uploaded, nothing gets a public URL, and there is no window left showing a
 * previous meeting's items after the call ends.
 *
 * The board markup itself is reused from the local simulated room rather than
 * written twice, so what a Zoom call sees and what the dev room shows cannot
 * drift apart.
 * ===========================================================================
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { escapeHtml, renderBoardPage, type BoardTaskRow } from '../local/page.js';

export interface SurfaceStatus {
  readonly state: string;
  readonly note: string | null;
}

export interface SurfaceOptions {
  readonly meetingId: string;
  readonly botDisplayName: string;
  readonly rows: () => readonly BoardTaskRow[];
  readonly status: () => SurfaceStatus | null;
  readonly host?: string;
  readonly port?: number;
}

/**
 * The avatar card.
 *
 * Read in a meeting grid at thumbnail size, so: the fact that this is an AI
 * first and largest, the name second, the current activity third. Everything
 * else is decoration and is left out.
 */
export function renderAvatarPage(options: {
  botDisplayName: string;
  status: SurfaceStatus | null;
}): string {
  const state = options.status?.state ?? 'listening';
  const note = options.status?.note ?? null;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(options.botDisplayName)}</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; background: #12151d; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font: 15px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #e7eaf2; text-align: center; padding: 24px;
  }
  .badge {
    font-size: 13px; letter-spacing: .18em; text-transform: uppercase;
    color: #0b0d12; background: #38d3a8; padding: 6px 14px; border-radius: 999px;
    font-weight: 700;
  }
  .name { margin-top: 18px; font-size: 30px; font-weight: 650; }
  .state { margin-top: 14px; font-size: 17px; color: #38d3a8; }
  .note { margin-top: 6px; font-size: 14px; color: #8b93a7; max-width: 32ch; }
</style></head>
<body>
  <div class="badge">AI participant</div>
  <div class="name">${escapeHtml(options.botDisplayName)}</div>
  <div class="state">${escapeHtml(state)}</div>
  ${note === null ? '' : `<div class="note">${escapeHtml(note)}</div>`}
</body></html>`;
}

/**
 * The local server behind both pages.
 *
 * Bound to loopback, port 0 by default. It exists only while something is being
 * shared or rendered and is closed on `leave`.
 */
export class MeetingSurface {
  readonly #options: SurfaceOptions;
  #server: Server | null = null;

  constructor(options: SurfaceOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#server !== null;
  }

  /** Unique per meeting, so `--auto-select-desktop-capture-source` cannot match the wrong window. */
  get windowTitle(): string {
    return `Lily board ${this.#options.meetingId}`;
  }

  get origin(): string {
    const address = this.#server?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      return `http://${this.#options.host ?? '127.0.0.1'}:${this.#options.port ?? 0}`;
    }
    return `http://${this.#options.host ?? '127.0.0.1'}:${(address as AddressInfo).port}`;
  }

  get boardUrl(): string {
    return `${this.origin}/board`;
  }

  get avatarUrl(): string {
    return `${this.origin}/avatar`;
  }

  async start(): Promise<void> {
    if (this.#server !== null) return;

    const server = createServer((req, res) => this.#handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#options.port ?? 0, this.#options.host ?? '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.#server = server;
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    const send = (status: number, body: string): void => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      res.end(body);
    };

    if (path === '/board' || path === '/') {
      // The document title is what Chrome's desktop-capture auto-select matches
      // on, so it has to be this meeting's and only this meeting's. The board
      // markup itself is the local room's, unchanged — retitled here rather
      // than forked, so the two cannot drift.
      const board = renderBoardPage(this.#options.meetingId, [...this.#options.rows()]).replace(
        '<title>Action items</title>',
        `<title>${escapeHtml(this.windowTitle)}</title>`,
      );
      send(200, board);
      return;
    }

    if (path === '/avatar') {
      send(
        200,
        renderAvatarPage({
          botDisplayName: this.#options.botDisplayName,
          status: this.#options.status(),
        }),
      );
      return;
    }

    send(404, '<!doctype html><title>not found</title>');
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
}

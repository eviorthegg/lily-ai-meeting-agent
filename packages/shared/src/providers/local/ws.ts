import type { PushResult, WsPusher } from '../types.js';

/**
 * Local-stage WebSocket push.
 *
 * The sockets themselves live in the local WS shim process (see
 * `api/src/local/ws-shim.ts`), which reproduces the API Gateway WebSocket
 * contract — `$connect` / `$disconnect` / route keys, `connectionId`, and the
 * same event envelope — so handler code is identical across stages.
 *
 * This provider reaches that process over a loopback control port, mirroring
 * what `ApiGatewayManagementApi` does in deployed stages, including the 410
 * semantics that tell callers a connection is gone.
 */
export class LocalWsPusher implements WsPusher {
  readonly #controlUrl: string;

  constructor(controlUrl?: string) {
    this.#controlUrl = (
      controlUrl ??
      process.env['LILY_LOCAL_WS_CONTROL_URL'] ??
      'http://127.0.0.1:3002'
    ).replace(/\/$/, '');
  }

  async push(connectionId: string, payload: unknown): Promise<PushResult> {
    const res = await fetch(
      `${this.#controlUrl}/_control/push/${encodeURIComponent(connectionId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    ).catch((cause: unknown) => {
      throw new Error(
        `Local WS shim is not reachable at ${this.#controlUrl}. Start it with \`npm run dev:local\`.`,
        { cause },
      );
    });

    // Same contract as API Gateway: 410 means the connection is gone and the
    // caller must clean up its connectionId mapping.
    if (res.status === 410) return 'gone';

    if (!res.ok) {
      throw new Error(`Local WS shim push failed: ${res.status} ${await res.text()}`);
    }

    return 'delivered';
  }

  async disconnect(connectionId: string): Promise<void> {
    const res = await fetch(
      `${this.#controlUrl}/_control/disconnect/${encodeURIComponent(connectionId)}`,
      { method: 'POST' },
    );

    // Already gone is success — disconnect is idempotent in both stages.
    if (!res.ok && res.status !== 410) {
      throw new Error(`Local WS shim disconnect failed: ${res.status}`);
    }
  }
}

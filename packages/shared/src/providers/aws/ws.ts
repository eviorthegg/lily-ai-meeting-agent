import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import type { PushResult, WsPusher } from '../types.js';

/**
 * Pushes to daemons over the API Gateway WebSocket API.
 *
 * `GoneException` (HTTP 410) is a normal outcome, not an error: laptops sleep and
 * networks drop without a clean `$disconnect`. It is surfaced as `'gone'` so the
 * caller deletes the stale connectionId mapping — otherwise presence lies and
 * dispatches are routed into a dead socket.
 */
export class AwsWsPusher implements WsPusher {
  readonly #client: ApiGatewayManagementApiClient;

  constructor(opts: {
    /** e.g. https://abc123.execute-api.eu-central-1.amazonaws.com/prod */
    endpoint: string;
    region?: string;
    client?: ApiGatewayManagementApiClient;
  }) {
    this.#client =
      opts.client ??
      new ApiGatewayManagementApiClient({
        endpoint: opts.endpoint,
        ...(opts.region === undefined ? {} : { region: opts.region }),
      });
  }

  async push(connectionId: string, payload: unknown): Promise<PushResult> {
    try {
      await this.#client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify(payload), 'utf8'),
        }),
      );
      return 'delivered';
    } catch (error) {
      if (error instanceof GoneException) return 'gone';
      throw error;
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    try {
      await this.#client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
    } catch (error) {
      // Already disconnected is the desired end state, not a failure.
      if (error instanceof GoneException) return;
      throw error;
    }
  }
}

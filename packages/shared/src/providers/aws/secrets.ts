import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { SecretsProvider } from '../types.js';

interface CacheEntry {
  readonly value: string;
  readonly fetchedAt: number;
}

/**
 * Secrets Manager backed, with a short in-process cache.
 *
 * The cache is not an optimisation detail — Secrets Manager is billed per API
 * call and a warm Lambda container can serve thousands of requests, so an
 * uncached read is both slow and expensive. The TTL is short enough that a
 * rotation propagates within one cycle without a redeploy.
 */
export class AwsSecretsProvider implements SecretsProvider {
  readonly #client: SecretsManagerClient;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #ttlMs: number;

  constructor(opts?: { region?: string; ttlMs?: number; client?: SecretsManagerClient }) {
    this.#client =
      opts?.client ??
      new SecretsManagerClient(opts?.region === undefined ? {} : { region: opts.region });
    this.#ttlMs = opts?.ttlMs ?? 5 * 60 * 1000;
  }

  async get(secretName: string): Promise<string> {
    const cached = this.#cache.get(secretName);
    if (cached !== undefined && Date.now() - cached.fetchedAt < this.#ttlMs) {
      return cached.value;
    }

    const result = await this.#client.send(
      new GetSecretValueCommand({ SecretId: secretName }),
    );

    const value =
      result.SecretString ??
      (result.SecretBinary === undefined
        ? undefined
        : Buffer.from(result.SecretBinary).toString('utf8'));

    if (value === undefined || value === '') {
      throw new Error(`Secret "${secretName}" resolved to an empty value.`);
    }

    this.#cache.set(secretName, { value, fetchedAt: Date.now() });
    return value;
  }

  invalidate(secretName?: string): void {
    if (secretName === undefined) {
      this.#cache.clear();
    } else {
      this.#cache.delete(secretName);
    }
  }
}

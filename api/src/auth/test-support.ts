import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { resetConfigCache } from '@lily/shared';
import { resetAuthKeyCache } from './keys.js';
import type { AuthStore } from './store.js';

/**
 * Test-only support. Nothing in this file is imported by production code, and it
 * is not re-exported from ./index.ts.
 *
 * It exists so the auth suites can run against a real mongod without depending on
 * the developer's own `.env.local` or on their `lily_local` database.
 */

/**
 * `directConnection=true` because docker-compose runs a single-node replica set:
 * without it the driver tries to discover the other members that a real set would
 * have and stalls until the server-selection timeout.
 */
export const TEST_MONGO_URI = 'mongodb://127.0.0.1:27017/?directConnection=true';

const CONNECT_TIMEOUT_MS = 2_000;

/**
 * Install fixed, throwaway key material.
 *
 * `LocalSecretsProvider` reads `process.env` before it reads `.env.local`, so
 * this uses the seam the provider already has rather than adding an override hook
 * to production code. Values are fixed rather than random so a failure is
 * reproducible; they are worthless by construction and never leave this process.
 */
export function useTestAuthSecrets(): void {
  process.env['LILY_STAGE'] = 'local';
  process.env['LILY_LOCAL_JWT_SIGNING_KEY'] = 'test-jwt-signing-key-0000000000000000';
  process.env['LILY_LOCAL_TOKEN_PEPPER'] = 'test-token-pepper-000000000000000000';
  process.env['LILY_LOCAL_MFA_ENCRYPTION_KEY'] = 'test-mfa-encryption-key-00000000000';

  resetConfigCache();
  resetAuthKeyCache();
}

export interface TestDatabase {
  readonly store: AuthStore;
  readonly dbName: string;
  drop(): Promise<void>;
}

/**
 * Point the *process-wide* connection singleton at a throwaway database.
 *
 * `openTestDatabase` hands back its own client, which is right for the auth
 * primitives because they take a store argument. Route handlers do not — they
 * resolve through `db/collections.ts`, which is the singleton — so a route test
 * has to redirect the singleton itself.
 *
 * Both levers used here already exist for this purpose and are honoured only in
 * the local stage: `LILY_LOCAL_MONGO_URI` is the secret the local provider reads,
 * and `LILY_LOCAL_MONGO_DB_NAME` is the override `db/client.ts` documents. No
 * production code path is being widened to make this possible.
 *
 * Returns null when mongod is unreachable, so a suite can skip rather than fail.
 */
export async function useTestDatabaseSingleton(
  label: string,
): Promise<{ dbName: string; drop: () => Promise<void> } | null> {
  const probe = new MongoClient(TEST_MONGO_URI, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    ignoreUndefined: true,
  });

  try {
    await probe.connect();
    await probe.db('admin').command({ hello: 1 });
  } catch {
    await probe.close().catch(() => undefined);
    return null;
  }
  await probe.close();

  const dbName = `lily_routetest_${label}_${randomBytes(4).toString('hex')}`;

  useTestAuthSecrets();
  process.env['LILY_LOCAL_MONGO_URI'] = TEST_MONGO_URI;
  process.env['LILY_LOCAL_MONGO_DB_NAME'] = dbName;
  resetConfigCache();
  resetAuthKeyCache();

  return {
    dbName,
    async drop(): Promise<void> {
      const { closeClient, getDb } = await import('../db/client.js');
      const db = await getDb();
      await db.dropDatabase();
      await closeClient();
    },
  };
}

/**
 * Open a uniquely-named throwaway database.
 *
 * Returns null when mongod is unreachable so a suite can skip rather than fail —
 * an absent local docker-compose is a missing prerequisite, not a broken
 * implementation, and reporting it as a test failure trains people to ignore red.
 */
export async function openTestDatabase(label: string): Promise<TestDatabase | null> {
  const client = new MongoClient(TEST_MONGO_URI, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    ignoreUndefined: true,
  });

  try {
    await client.connect();
    // A replica set is required for transactions; `hello` also proves the
    // connection is genuinely usable rather than merely constructed.
    await client.db('admin').command({ hello: 1 });
  } catch {
    await client.close().catch(() => undefined);
    return null;
  }

  const dbName = `lily_authtest_${label}_${randomBytes(4).toString('hex')}`;
  const db = client.db(dbName);

  return {
    store: { client, db },
    dbName,
    async drop(): Promise<void> {
      await db.dropDatabase();
      await client.close();
    },
  };
}

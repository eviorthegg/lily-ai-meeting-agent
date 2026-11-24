import { MongoClient, type Db } from 'mongodb';
import { getConfig, createProviders, isLocal, type LilyConfig } from '@lily/shared';

/**
 * Connection singleton.
 *
 * Lambda reuses a warm container across invocations, so the client is cached at
 * module scope and deliberately never closed inside a handler. Connecting per
 * invocation would add handshake latency to every request and exhaust Atlas
 * connection limits under concurrency.
 *
 * The cached value is the *promise*, not the resolved client: concurrent
 * invocations during a cold start would otherwise each open their own client.
 */
let clientPromise: Promise<MongoClient> | null = null;

async function connect(): Promise<MongoClient> {
  const config = getConfig();
  const providers = createProviders(config);
  const uri = await providers.secrets.get(config.mongo.uri.secretName);

  const client = new MongoClient(uri, {
    maxPoolSize: config.mongo.maxPoolSize,
    minPoolSize: config.mongo.minPoolSize,
    serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
    // Retryable writes let a transient primary election resolve without
    // surfacing an error to the caller.
    retryWrites: true,
    ignoreUndefined: true,
  });

  await client.connect();
  return client;
}

export async function getClient(): Promise<MongoClient> {
  // If a cold-start connection fails, drop the rejected promise so the next
  // invocation retries instead of serving the same cached failure forever.
  clientPromise ??= connect().catch((error: unknown) => {
    clientPromise = null;
    throw error;
  });
  return clientPromise;
}

/**
 * The database this process reads and writes.
 *
 * `LILY_LOCAL_MONGO_DB_NAME` exists so a test suite can point the process-wide
 * singleton at a throwaway database instead of the developer's `lily_local`.
 * It is honoured ONLY in the local stage: the check is on `config.stage`, not on
 * the variable's presence, so setting it in a deployed environment does nothing
 * at all rather than silently redirecting production writes. That asymmetry is
 * the whole reason this is safe to have.
 */
function databaseName(config: LilyConfig): string {
  const override = process.env['LILY_LOCAL_MONGO_DB_NAME'];
  if (isLocal(config.stage) && override !== undefined && override !== '') return override;
  return config.mongo.dbName;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(databaseName(getConfig()));
}

/** Tests and local scripts only — Lambda must never close the shared client. */
export async function closeClient(): Promise<void> {
  if (clientPromise === null) return;
  const client = await clientPromise;
  clientPromise = null;
  await client.close();
}

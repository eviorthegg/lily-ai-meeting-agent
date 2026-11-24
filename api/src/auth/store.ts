import type { ClientSession, Collection, Db, MongoClient } from 'mongodb';
import { getClient, getDb } from '../db/client.js';
import { COLLECTIONS } from '../db/collections.js';
import type {
  DaemonTokenDoc,
  RefreshTokenDoc,
  SessionDoc,
  UserDoc,
  WebAuthnCredentialDoc,
} from '../db/schema.js';

/**
 * The database handles the auth layer writes through.
 *
 * `../db/collections.ts` resolves everything through the process-wide singleton,
 * which is right for handlers and wrong for tests: a suite that has to prove
 * family revocation against a real replica set needs its own throwaway database,
 * not the one the developer is using. Taking the handle as an ordinary optional
 * argument keeps that seam explicit — no module-level override that could
 * silently redirect production writes.
 *
 * Collection *names* still come from `COLLECTIONS`, so there is one source of
 * truth for them.
 */
export interface AuthStore {
  /** Needed for `startSession()` — token rotation is transactional. */
  readonly client: MongoClient;
  readonly db: Db;
}

export async function resolveStore(store?: AuthStore): Promise<AuthStore> {
  if (store !== undefined) return store;
  const [client, db] = await Promise.all([getClient(), getDb()]);
  return { client, db };
}

export function usersIn(db: Db): Collection<UserDoc> {
  return db.collection<UserDoc>(COLLECTIONS.users);
}

export function refreshTokensIn(db: Db): Collection<RefreshTokenDoc> {
  return db.collection<RefreshTokenDoc>(COLLECTIONS.refreshTokens);
}

export function daemonTokensIn(db: Db): Collection<DaemonTokenDoc> {
  return db.collection<DaemonTokenDoc>(COLLECTIONS.daemonTokens);
}

export function sessionsIn(db: Db): Collection<SessionDoc> {
  return db.collection<SessionDoc>(COLLECTIONS.sessions);
}

export function webauthnCredentialsIn(db: Db): Collection<WebAuthnCredentialDoc> {
  return db.collection<WebAuthnCredentialDoc>(COLLECTIONS.webauthnCredentials);
}

/**
 * `exactOptionalPropertyTypes` makes `{ session: undefined }` a type error rather
 * than a no-op, so the property has to be absent when there is no session.
 */
export function withSession(session?: ClientSession): { session?: ClientSession } {
  return session === undefined ? {} : { session };
}

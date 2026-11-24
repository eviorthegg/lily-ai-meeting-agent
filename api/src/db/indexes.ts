import type { Db, IndexDescription } from 'mongodb';
import { COLLECTIONS, type CollectionName } from './collections.js';
import { getDb } from './client.js';

/**
 * Index definitions, applied by `npm run db:migrate` and by the local bootstrap.
 *
 * Retention is implemented as TTL indexes on `purgeAfter` rather than a sweeper
 * job: the database enforces it whether or not our code is running, which is the
 * right property for a deletion guarantee we make to customers.
 *
 * `audit_log` deliberately has no TTL. It is the record of who authorised what
 * and must outlive the task and meeting rows it refers to.
 */
const INDEXES: Partial<Record<CollectionName, IndexDescription[]>> = {
  [COLLECTIONS.orgs]: [
    { key: { ownerUserId: 1 }, name: 'org_owner' },
    { key: { 'billing.lemonSqueezySubscriptionId': 1 }, name: 'org_ls_subscription', sparse: true },
    { key: { 'billing.cycleResetsAt': 1 }, name: 'org_cycle_reset' },
  ],

  [COLLECTIONS.users]: [
    // Employee ids are the routing key and must be unique within an org.
    { key: { orgId: 1, employeeId: 1 }, name: 'user_org_employee', unique: true },
    { key: { emailNormalized: 1 }, name: 'user_email', unique: true },
    { key: { orgId: 1, status: 1 }, name: 'user_org_status' },
    { key: { orgId: 1, role: 1 }, name: 'user_org_role' },
  ],

  [COLLECTIONS.daemonTokens]: [
    { key: { tokenHash: 1 }, name: 'daemon_token_hash', unique: true },
    { key: { userId: 1, revokedAt: 1 }, name: 'daemon_token_user' },
    { key: { orgId: 1 }, name: 'daemon_token_org' },
    { key: { rotatesAt: 1 }, name: 'daemon_token_rotation_due' },
  ],

  [COLLECTIONS.refreshTokens]: [
    { key: { tokenHash: 1 }, name: 'refresh_token_hash', unique: true },
    // Reuse detection revokes by family, so this lookup is on the hot path.
    { key: { familyId: 1 }, name: 'refresh_token_family' },
    { key: { userId: 1 }, name: 'refresh_token_user' },
    { key: { expiresAt: 1 }, name: 'refresh_token_ttl', expireAfterSeconds: 0 },
  ],

  [COLLECTIONS.sessions]: [
    { key: { userId: 1, revokedAt: 1 }, name: 'session_user' },
    { key: { familyId: 1 }, name: 'session_family' },
    { key: { absoluteExpiresAt: 1 }, name: 'session_ttl', expireAfterSeconds: 0 },
  ],

  [COLLECTIONS.webauthnCredentials]: [
    { key: { credentialId: 1 }, name: 'webauthn_credential_id', unique: true },
    { key: { userId: 1 }, name: 'webauthn_user' },
  ],

  [COLLECTIONS.installTokens]: [
    { key: { tokenHash: 1 }, name: 'install_token_hash', unique: true },
    { key: { userId: 1 }, name: 'install_token_user' },
    // Single-use and short-lived; expiry is enforced by the database too.
    { key: { expiresAt: 1 }, name: 'install_token_ttl', expireAfterSeconds: 0 },
  ],

  [COLLECTIONS.connections]: [
    // Dispatch resolves employee → connection on every routed task.
    { key: { employeeId: 1 }, name: 'connection_employee' },
    { key: { userId: 1 }, name: 'connection_user' },
    { key: { orgId: 1 }, name: 'connection_org' },
    // Backstop for connections that vanish without a clean $disconnect.
    { key: { expiresAt: 1 }, name: 'connection_ttl', expireAfterSeconds: 0 },
  ],

  [COLLECTIONS.meetings]: [
    { key: { orgId: 1, startedAt: -1 }, name: 'meeting_org_recent' },
    { key: { orgId: 1, status: 1 }, name: 'meeting_org_status' },
    { key: { purgeAfter: 1 }, name: 'meeting_retention', expireAfterSeconds: 0 },
  ],

  [COLLECTIONS.tasks]: [
    { key: { orgId: 1, ownerEmployeeId: 1, status: 1 }, name: 'task_org_owner_status' },
    { key: { meetingId: 1 }, name: 'task_meeting' },
    { key: { orgId: 1, due: 1 }, name: 'task_org_due' },
    { key: { purgeAfter: 1 }, name: 'task_retention', expireAfterSeconds: 0 },
  ],

  [COLLECTIONS.auditLog]: [
    { key: { orgId: 1, at: -1 }, name: 'audit_org_recent' },
    { key: { orgId: 1, action: 1, at: -1 }, name: 'audit_org_action' },
    { key: { meetingId: 1 }, name: 'audit_meeting', sparse: true },
    // No TTL by design — see the note at the top of this file.
  ],

  [COLLECTIONS.usageEvents]: [
    { key: { orgId: 1, at: -1 }, name: 'usage_org_recent' },
    { key: { meetingId: 1 }, name: 'usage_meeting' },
  ],

  [COLLECTIONS.promotions]: [
    { key: { code: 1 }, name: 'promotion_code', unique: true },
    { key: { active: 1, trigger: 1 }, name: 'promotion_active_trigger' },
  ],

  [COLLECTIONS.redemptions]: [
    { key: { promotionId: 1 }, name: 'redemption_promotion' },
    // Enforces the per-customer limit rather than merely reporting on it.
    { key: { orgId: 1, promotionId: 1 }, name: 'redemption_org_promotion' },
  ],

  [COLLECTIONS.consents]: [
    { key: { anonymousId: 1, at: -1 }, name: 'consent_anonymous' },
    { key: { orgId: 1 }, name: 'consent_org', sparse: true },
  ],

  [COLLECTIONS.offerState]: [{ key: { orgId: 1 }, name: 'offer_state_org', unique: true }],
};

export interface EnsureIndexesResult {
  collection: string;
  created: string[];
}

/**
 * Idempotent. Safe to run on every deploy — Mongo ignores an index that already
 * exists with the same definition, and reports a conflict if a definition
 * changed, which is a signal worth failing a deploy over rather than papering
 * over with a silent drop-and-recreate.
 */
export async function ensureIndexes(db?: Db): Promise<EnsureIndexesResult[]> {
  const database = db ?? (await getDb());
  const results: EnsureIndexesResult[] = [];

  for (const [name, specs] of Object.entries(INDEXES)) {
    if (specs === undefined || specs.length === 0) continue;
    const created = await database.collection(name).createIndexes(specs);
    results.push({ collection: name, created });
  }

  return results;
}

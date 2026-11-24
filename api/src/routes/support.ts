import { ObjectId } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { auditLog, orgs, users } from '../db/collections.js';
import { policyChecked } from '../db/data-policy.js';
import type { AuditAction, AuditLogDoc, OrgDoc, UserDoc } from '../db/schema.js';
import { notFound } from './http.js';

/**
 * Small pieces every route file needs, in one place so they cannot drift.
 *
 * Nothing here makes an authorization decision. These are the mechanical parts —
 * write an audit row, load an org, mint an employee id — kept out of the handlers
 * so a handler reads as the policy it enforces rather than as plumbing.
 */

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditInput {
  readonly orgId: ObjectId;
  readonly action: AuditAction;
  /** Null only for system-initiated entries, per the note on `AuditLogDoc`. */
  readonly actorUserId: ObjectId | null;
  readonly subjectUserId?: ObjectId | null;
  readonly meetingId?: ObjectId | null;
  /** What was done, in words. The command — never its output. */
  readonly detail: string;
  readonly ip: string | null;
  readonly at: Date;
}

/**
 * Append to the audit log.
 *
 * `detail` is capped at the data-policy limit here rather than at the call site,
 * because a truncated audit line is strictly better than a write that throws and
 * loses the entry entirely — the log's job is to record that the thing happened.
 * `policyChecked` still runs, so a forbidden *field name* is a hard failure.
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  const collection = await auditLog();

  await collection.insertOne(
    policyChecked<AuditLogDoc>({
      _id: new ObjectId(),
      orgId: input.orgId,
      action: input.action,
      actorUserId: input.actorUserId,
      subjectUserId: input.subjectUserId ?? null,
      meetingId: input.meetingId ?? null,
      detail: input.detail.slice(0, 1_000),
      ip: input.ip,
      at: input.at,
    }),
  );
}

// ---------------------------------------------------------------------------
// Orgs
// ---------------------------------------------------------------------------

/**
 * Load the caller's org.
 *
 * Answers 404 rather than 500 when the row is absent, because there is one
 * legitimate way to hold a valid session with no org document: a user who has
 * signed up and verified but has not yet created their organisation. Their
 * `orgId` is reserved at signup and the document appears at `POST /orgs`.
 */
export async function loadOrg(orgId: ObjectId): Promise<OrgDoc> {
  const collection = await orgs();
  const org = await collection.findOne({ _id: orgId, deletedAt: null });
  if (org === null) throw notFound('No such organisation.');
  return org;
}

/** Null instead of throwing, for the paths where "no org yet" is expected. */
export async function findOrg(orgId: ObjectId): Promise<OrgDoc | null> {
  const collection = await orgs();
  return collection.findOne({ _id: orgId, deletedAt: null });
}

/** Everyone who still counts as a member. Removed users are excluded. */
export async function memberCount(orgId: ObjectId): Promise<number> {
  const collection = await users();
  return collection.countDocuments({ orgId, status: { $ne: 'removed' } });
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Public routing identifier for an employee.
 *
 * Distinct from `_id` so it can appear in logs, in Lily's spoken context and in
 * a daemon's config file without exposing a database key — see the note on
 * `UserDoc.employeeId`. Random rather than derived from the name: a derived id
 * would leak the person's identity into every place the id travels, and would
 * collide the moment two people share a first name.
 */
export function newEmployeeId(): string {
  return `emp_${randomBytes(8).toString('hex')}`;
}

/** Case-insensitive comparison key. The display form is stored separately. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Resolve an employee within an org.
 *
 * The org is part of the query rather than checked afterwards, so another
 * tenant's employee id is indistinguishable from one that does not exist.
 */
export async function findEmployee(
  orgId: ObjectId,
  employeeId: string,
): Promise<UserDoc | null> {
  const collection = await users();
  return collection.findOne({ orgId, employeeId });
}

/** Display names for audit presentation, keyed by hex user id. */
export async function nameLookup(
  ids: readonly ObjectId[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Map(ids.map((id) => [id.toHexString(), id])).values()];
  if (unique.length === 0) return new Map();

  const collection = await users();
  const rows = await collection
    .find({ _id: { $in: unique } }, { projection: { name: 1 } })
    .toArray();

  return new Map(rows.map((row) => [row._id.toHexString(), row.name]));
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 quoting.
 *
 * The leading-character guard is not about CSV at all — it stops a spreadsheet
 * from executing a cell that begins `=`, `+`, `-` or `@`. Audit detail is
 * attacker-influenced text (it names commands people asked for), and an export
 * that opens in Excel is exactly where a formula injection lands.
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

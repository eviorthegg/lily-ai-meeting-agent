import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import { auditLog, users } from '../db/collections.js';
import type { AuditLogDoc } from '../db/schema.js';
import { MANAGER_ROLES, authenticate, requireOrg, requireRole, requireStepUpFor } from './context.js';
import {
  badRequest,
  csv,
  ok,
  parseQuery,
  requireParam,
  type RouteHandler,
} from './http.js';
import { presentAuditEntry } from './present.js';
import { csvCell, nameLookup, writeAudit } from './support.js';

/**
 * The audit log.
 *
 * This is the compliance record — who authorised what — and it is the one
 * collection with no TTL, because it must outlive the tasks and meetings it
 * refers to. Everything here is read-only: there is no endpoint that edits or
 * deletes an entry, and hard-delete leaves this collection alone on purpose.
 *
 * Export is gated behind step-up while reading is not. The distinction is the
 * threat: a hijacked session browsing the log sees what is on screen, whereas an
 * export hands the attacker the whole history of the organisation in a file. That
 * is the same reasoning that puts `audit.export` in STEP_UP_ACTIONS.
 */

const AUDIT_ACTIONS = [
  'permission.granted',
  'permission.denied',
  'permission.timed_out',
  'task.dispatched',
  'employee.invited',
  'employee.removed',
  'token.rotated',
  'token.reuse_detected',
  'policy.changed',
  'billing.changed',
  'audit.exported',
  'install_token.issued',
  'meeting.started',
  'meeting.ended',
  'data.hard_deleted',
] as const;

const auditQuerySchema = z.object({
  search: z.string().max(200).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  cursor: z.string().max(20).optional(),
});

/**
 * Upper bound on an export.
 *
 * A whole-history export is assembled in memory before it is sent, so it needs a
 * ceiling. Fifty thousand rows is far beyond any real org's log and well inside
 * what a single response can hold.
 */
const EXPORT_MAX_ROWS = 50_000;

/** User input goes into a `$regex`; without this a `.*` is a full table scan. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseBound(value: string | undefined, field: string): Date | null {
  if (value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest('That is not a valid date.', { [field]: 'Use an ISO date.' });
  }
  return parsed;
}

type AuditQuery = z.infer<typeof auditQuerySchema>;

/**
 * Build the Mongo filter for a query.
 *
 * The free-text search has to cover actor and subject *names*, which live in
 * `users` rather than on the entry. Those are resolved to ids first and folded
 * into the `$or` — one extra query, versus loading the entire log into memory to
 * filter it after a join.
 */
async function buildFilter(orgId: ObjectId, query: AuditQuery): Promise<Record<string, unknown>> {
  const filter: Record<string, unknown> = { orgId };

  if (query.action !== undefined) filter['action'] = query.action;

  const from = parseBound(query.from, 'from');
  const to = parseBound(query.to, 'to');
  if (from !== null || to !== null) {
    filter['at'] = {
      ...(from === null ? {} : { $gte: from }),
      ...(to === null ? {} : { $lte: to }),
    };
  }

  const needle = query.search?.trim() ?? '';
  if (needle === '') return filter;

  const pattern = new RegExp(escapeRegex(needle), 'i');

  const usersCol = await users();
  const matchedPeople = await usersCol
    .find({ orgId, name: { $regex: pattern } }, { projection: { _id: 1 } })
    .limit(200)
    .toArray();

  const ids = matchedPeople.map((person) => person._id);

  filter['$or'] = [
    { detail: { $regex: pattern } },
    { action: { $regex: pattern } },
    { ip: { $regex: pattern } },
    ...(ids.length === 0
      ? []
      : [{ actorUserId: { $in: ids } }, { subjectUserId: { $in: ids } }]),
  ];

  return filter;
}

/** Resolve every name a page of entries refers to, in one round trip. */
async function presentPage(entries: readonly AuditLogDoc[]): Promise<unknown[]> {
  const referenced = entries.flatMap((entry) =>
    [entry.actorUserId, entry.subjectUserId].filter((id): id is ObjectId => id !== null),
  );
  const names = await nameLookup(referenced);
  return entries.map((entry) => presentAuditEntry(entry, names));
}

// ---------------------------------------------------------------------------
// GET /orgs/:orgId/audit
// ---------------------------------------------------------------------------

export const listAudit: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const query = parseQuery(auditQuerySchema, req.query);
  const filter = await buildFilter(orgId, query);

  // Offset paging rather than a keyset cursor. The log is browsed with filters
  // and a page count, not scrolled infinitely, and `total` — which this screen
  // displays — cannot be produced from a keyset cursor anyway.
  const parsedOffset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
  const offset = Number.isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;

  const collection = await auditLog();
  const [total, rows] = await Promise.all([
    collection.countDocuments(filter),
    collection.find(filter).sort({ at: -1 }).skip(offset).limit(query.limit).toArray(),
  ]);

  const next = offset + query.limit;

  return ok({
    entries: await presentPage(rows),
    nextCursor: next < total ? String(next) : null,
    total,
  });
};

// ---------------------------------------------------------------------------
// GET /orgs/:orgId/audit/export
// ---------------------------------------------------------------------------

export const exportAudit: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const now = deps.now();
  requireStepUpFor(actor, 'audit.export', now);

  const query = parseQuery(auditQuerySchema, req.query);
  const filter = await buildFilter(orgId, query);

  const collection = await auditLog();
  const rows = await collection.find(filter).sort({ at: -1 }).limit(EXPORT_MAX_ROWS).toArray();

  const referenced = rows.flatMap((entry) =>
    [entry.actorUserId, entry.subjectUserId].filter((id): id is ObjectId => id !== null),
  );
  const names = await nameLookup(referenced);

  const header = 'at,action,actor,subject,meeting_id,detail,ip';
  const body = rows
    .map((entry) =>
      [
        entry.at.toISOString(),
        entry.action,
        entry.actorUserId === null ? '' : (names.get(entry.actorUserId.toHexString()) ?? ''),
        entry.subjectUserId === null ? '' : (names.get(entry.subjectUserId.toHexString()) ?? ''),
        entry.meetingId === null ? '' : entry.meetingId.toHexString(),
        entry.detail,
        entry.ip ?? '',
      ]
        .map(csvCell)
        .join(','),
    )
    .join('\n');

  // Exporting the audit log is itself an audited action — written after the rows
  // are gathered so the export does not appear in its own output and confuse a
  // later reconciliation.
  await writeAudit({
    orgId,
    action: 'audit.exported',
    actorUserId: actor.userId,
    detail: `Exported ${rows.length} audit entries as CSV`,
    ip: req.ip,
    at: now,
  });

  const stamp = now.toISOString().slice(0, 10);
  return csv(`lily-audit-${stamp}.csv`, `${header}\n${body}\n`);
};

export const auditRoutes = [
  { method: 'GET', pattern: '/orgs/:orgId/audit', handler: listAudit },
  { method: 'GET', pattern: '/orgs/:orgId/audit/export', handler: exportAudit },
] as const satisfies readonly { method: string; pattern: string; handler: RouteHandler }[];

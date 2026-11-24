import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { meetings, tasks } from '../db/collections.js';
import type { TaskDoc } from '../db/schema.js';
import { MANAGER_ROLES, authenticate, requireOrg, requireRole } from './context.js';
import {
  badRequest,
  ok,
  parseQuery,
  requireParam,
  type RouteHandler,
} from './http.js';
import { presentTask } from './present.js';
import { loadOrg } from './support.js';

/**
 * Tasks.
 *
 * Two readers with different rights, which is why there are two endpoints rather
 * than one with a flag:
 *
 *   `GET /tasks` is the caller asking about their own work. It is scoped to the
 *   caller's own employee id, always, with no parameter that could widen it.
 *
 *   `GET /orgs/:orgId/tasks` is the manager view of everyone. It respects
 *   `settings.taskVisibility`: an org that has chosen `owner_and_managers` is
 *   saying admins should not read task text, and that choice is honoured here
 *   rather than in the dashboard where it would be advisory.
 *
 * Task text is one of only two pieces of derived meeting content this system
 * stores (see the data policy in ../db/schema.ts). The agent's *output* is not
 * here and never will be — only whether the dispatch succeeded.
 */

const TASK_STATUSES = ['unconfirmed', 'confirmed', 'in_progress', 'done', 'cancelled'] as const;

const myTasksQuerySchema = z.object({
  meetingId: z.string().max(64).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const orgTasksQuerySchema = z.object({
  ownerEmployeeId: z.string().max(64).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  /** Inclusive ISO bounds on `due`, matching `OrgTasksQuery` in the dashboard. */
  dueFrom: z.string().max(40).optional(),
  dueTo: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** Rejects a malformed date rather than silently dropping the filter. */
function parseBound(value: string | undefined, field: string): Date | null {
  if (value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest('That is not a valid date.', { [field]: 'Use an ISO date.' });
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// GET /tasks
// ---------------------------------------------------------------------------

export const listMyTasks: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  const query = parseQuery(myTasksQuerySchema, req.query);

  const filter: Record<string, unknown> = {
    orgId: actor.orgId,
    // Not a parameter. There is no request shape through which a caller could
    // ask for someone else's tasks on this route.
    ownerEmployeeId: actor.user.employeeId,
  };

  if (query.status !== undefined) filter['status'] = query.status;

  if (query.meetingId !== undefined && query.meetingId !== '') {
    // An unparseable id matches nothing rather than erroring: a stale link in a
    // browser tab should return an empty list, not a 400.
    if (!ObjectId.isValid(query.meetingId)) return ok([]);
    filter['meetingId'] = new ObjectId(query.meetingId);
  }

  const collection = await tasks();
  const rows = await collection
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(query.limit)
    .toArray();

  return ok(rows.map((row) => presentTask(row)));
};

// ---------------------------------------------------------------------------
// GET /orgs/:orgId/tasks
// ---------------------------------------------------------------------------

export const listOrgTasks: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);
  const orgId = requireOrg(actor, requireParam(req, 'orgId'));

  const query = parseQuery(orgTasksQuerySchema, req.query);
  const org = await loadOrg(orgId);

  const filter: Record<string, unknown> = { orgId };

  if (query.status !== undefined) filter['status'] = query.status;
  if (query.ownerEmployeeId !== undefined && query.ownerEmployeeId !== '') {
    filter['ownerEmployeeId'] = query.ownerEmployeeId;
  }

  const from = parseBound(query.dueFrom, 'dueFrom');
  const to = parseBound(query.dueTo, 'dueTo');
  if (from !== null || to !== null) {
    filter['due'] = {
      ...(from === null ? {} : { $gte: from }),
      ...(to === null ? {} : { $lte: to }),
    };
  }

  // The org's own visibility policy, enforced server-side. An admin in an org
  // that chose `owner_and_managers` sees their own tasks and no one else's.
  if (org.settings.taskVisibility === 'owner_and_managers' && actor.role === 'admin') {
    filter['ownerEmployeeId'] = actor.user.employeeId;
  }

  const collection = await tasks();
  const rows: TaskDoc[] = await collection
    .find(filter)
    .sort({ due: 1, createdAt: -1 })
    .limit(query.limit)
    .toArray();

  return ok(rows.map((row) => presentTask(row)));
};

// ---------------------------------------------------------------------------
// GET /meetings/:meetingId/tasks
// ---------------------------------------------------------------------------

/** Convenience for the meeting detail screen; same org scoping as everything else. */
export const listMeetingTasks: RouteHandler = async (req) => {
  const actor = await authenticate(req);
  requireRole(actor, MANAGER_ROLES);

  const raw = requireParam(req, 'meetingId');
  if (!ObjectId.isValid(raw)) return ok([]);

  const meetingsCol = await meetings();
  const meeting = await meetingsCol.findOne({ _id: new ObjectId(raw), orgId: actor.orgId });
  if (meeting === null) return ok([]);

  const collection = await tasks();
  const rows = await collection.find({ orgId: actor.orgId, meetingId: meeting._id }).toArray();

  return ok(rows.map((row) => presentTask(row)));
};

export const taskRoutes = [
  { method: 'GET', pattern: '/tasks', handler: listMyTasks },
  { method: 'GET', pattern: '/orgs/:orgId/tasks', handler: listOrgTasks },
  { method: 'GET', pattern: '/meetings/:meetingId/tasks', handler: listMeetingTasks },
] as const satisfies readonly { method: string; pattern: string; handler: RouteHandler }[];

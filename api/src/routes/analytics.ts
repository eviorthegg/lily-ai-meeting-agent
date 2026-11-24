import { z } from 'zod';
import {
  connections,
  meetings,
  promotions,
  redemptions,
  tasks,
  usageEvents,
  users,
} from '../db/collections.js';
import type { MeetingDoc, OrgDoc } from '../db/schema.js';
import { planFor } from '../billing/plans.js';
import { authenticate } from './context.js';
import { forbidden, ok, parseQuery, type RouteHandler } from './http.js';
import { loadOrg } from './support.js';

/**
 * Owner analytics.
 *
 * ============================================================================
 * SCOPE — read this before comparing against the dashboard's mock
 * ============================================================================
 * `web/src/lib/api/types.ts` describes `LiveSnapshot` as "across every org", and
 * the mock returns platform-wide figures. This implementation is scoped to the
 * **caller's own organisation**, deliberately, and the deviation is the security
 * requirement rather than an omission: MRR, churn and live counts across every
 * tenant are the platform operator's numbers, and every `owner` in the system is
 * an ordinary customer. Serving them cross-tenant aggregates would contradict the
 * rule that a tenant cannot learn that another tenant exists.
 *
 * A genuine platform-operator view needs a role that does not exist in
 * `db/schema.ts` — there is no super-admin — so building one would mean inventing
 * an authorization tier rather than implementing an endpoint.
 * ============================================================================
 *
 * The second rule here: a number that cannot be derived from a real collection is
 * reported as unavailable, with the reason, rather than estimated. `unavailable`
 * on the response names every such field. Three of them exist today and each is
 * missing an *event history* rather than a calculation:
 *
 *   - paid conversions and churn need subscription lifecycle events, and nothing
 *     writes them yet (there is no LemonSqueezy webhook in this build).
 *   - COGS needs metered vendor spend. `MeetingDoc.costCents` is nullable and the
 *     orchestrator does not populate it, so cost is summed from what has actually
 *     been recorded — which today is nothing, and is reported as nothing rather
 *     than as a plausible-looking guess.
 *   - visit counts live in the client analytics pipeline (PostHog/GA4), which
 *     this API does not read.
 */

const GRAINS = ['day', 'week', 'month'] as const;
type Grain = (typeof GRAINS)[number];

const analyticsQuerySchema = z.object({
  grain: z.enum(GRAINS).default('week'),
  periods: z.coerce.number().int().min(1).max(120).default(26),
});

// ---------------------------------------------------------------------------
// Period arithmetic
// ---------------------------------------------------------------------------

/**
 * All bucketing is UTC.
 *
 * Local-time buckets would make the same meeting land in different periods for
 * two people looking at the same dashboard, and there is no single "the org's
 * timezone" in the schema to use instead.
 */
function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** ISO weeks start on Monday, which is what `AcquisitionSeriesPoint` documents. */
function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  const shift = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - shift * 86_400_000);
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function bucketStart(date: Date, grain: Grain): Date {
  if (grain === 'day') return startOfDay(date);
  if (grain === 'week') return startOfWeek(date);
  return startOfMonth(date);
}

/** 'YYYY-MM' for months; an ISO date for days and for the Monday of a week. */
function periodKey(date: Date, grain: Grain): string {
  const start = bucketStart(date, grain);
  return grain === 'month' ? start.toISOString().slice(0, 7) : start.toISOString().slice(0, 10);
}

/** The buckets to report, oldest first, ending with the one `now` falls in. */
function periodStarts(grain: Grain, count: number, now: Date): Date[] {
  const out: Date[] = [];
  let cursor = bucketStart(now, grain);

  for (let index = 0; index < count; index += 1) {
    out.unshift(cursor);
    if (grain === 'month') {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
    } else {
      cursor = new Date(cursor.getTime() - (grain === 'day' ? 1 : 7) * 86_400_000);
    }
  }

  return out;
}

/** Days in a bucket, used to spread a monthly subscription across the series. */
function periodDays(start: Date, grain: Grain): number {
  if (grain === 'day') return 1;
  if (grain === 'week') return 7;
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return Math.round((next.getTime() - start.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Unavailable figures
// ---------------------------------------------------------------------------

interface UnavailableFigure {
  readonly field: string;
  readonly reason: string;
}

const UNAVAILABLE: readonly UnavailableFigure[] = [
  {
    field: 'series.paidConversions',
    reason:
      'Needs subscription lifecycle events. No billing webhook writes them in this build, so a conversion has no date to be counted on.',
  },
  {
    field: 'revenue.churnRatePct',
    reason: 'Needs cancellation events over a trailing window; none are recorded yet.',
  },
  {
    field: 'revenue.expansionCents',
    reason:
      'Top-up purchases are not recorded as transactions — only the remaining token balance is stored, which cannot be turned back into revenue.',
  },
  {
    field: 'margin.costCents',
    reason:
      'Real COGS requires metered vendor spend per meeting. MeetingDoc.costCents is nullable and nothing populates it, so cost is the sum of what was actually measured — currently zero — and not an estimate.',
  },
  {
    field: 'acquisition.visits',
    reason:
      'Visit counts live in the client analytics pipeline (PostHog/GA4). This API never receives them.',
  },
];

// ---------------------------------------------------------------------------
// GET /admin/analytics
// ---------------------------------------------------------------------------

export const getOwnerAnalytics: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);

  // Owner only. Not a nav-visibility decision — this is the check that matters,
  // and it is repeated by the dashboard purely so the user sees a sentence.
  if (actor.role !== 'owner') throw forbidden('Owner access only.');

  const query = parseQuery(analyticsQuerySchema, req.query);
  const now = deps.now();
  const org = await loadOrg(actor.orgId);

  const starts = periodStarts(query.grain, query.periods, now);
  const firstStart = starts[0] ?? bucketStart(now, query.grain);

  const [usersCol, meetingsCol, usageCol] = await Promise.all([users(), meetings(), usageEvents()]);

  const [members, orgMeetings, usage] = await Promise.all([
    usersCol.find({ orgId: org._id }).toArray(),
    meetingsCol.find({ orgId: org._id }).sort({ createdAt: 1 }).toArray(),
    usageCol.find({ orgId: org._id, at: { $gte: firstStart } }).toArray(),
  ]);

  // --- series ------------------------------------------------------------

  const signupsByPeriod = new Map<string, number>();
  for (const member of members) {
    const key = periodKey(member.createdAt, query.grain);
    signupsByPeriod.set(key, (signupsByPeriod.get(key) ?? 0) + 1);
  }

  // Activation is "first meeting actually run", once, in the period it happened.
  // Anything else double-counts a returning customer as a new activation.
  const firstRealMeeting = orgMeetings.find((meeting) => meeting.status !== 'failed');
  const activationKey =
    firstRealMeeting === undefined
      ? null
      : periodKey(firstRealMeeting.startedAt ?? firstRealMeeting.createdAt, query.grain);

  const series = starts.map((start) => {
    const key = periodKey(start, query.grain);
    return {
      period: key,
      signups: signupsByPeriod.get(key) ?? 0,
      activations: key === activationKey ? 1 : 0,
      // See UNAVAILABLE — this is a zero meaning "not measured", not "none".
      paidConversions: 0,
    };
  });

  // --- funnel ------------------------------------------------------------

  const verified = members.filter((member) => member.emailVerifiedAt !== null).length;
  const enrolledDaemons = members.filter((member) => member.daemonEnrolled).length;
  const ranMeetings = orgMeetings.filter((meeting) => meeting.status !== 'failed').length;

  const funnel = [
    { id: 'signed_up', label: 'Accounts created', count: members.length },
    { id: 'verified', label: 'Email verified', count: verified },
    { id: 'org_created', label: 'Organisation created', count: 1 },
    { id: 'invited', label: 'Teammates invited', count: Math.max(0, members.length - 1) },
    { id: 'daemon_enrolled', label: 'Daemons enrolled', count: enrolledDaemons },
    { id: 'meeting_run', label: 'Meetings run', count: ranMeetings },
  ];

  // --- revenue -----------------------------------------------------------

  const plan = planFor(org.billing.plan);
  const paying = plan.priceCents > 0 && org.billing.status === 'active';
  const mrrCents = paying ? plan.priceCents : 0;

  const revenue = {
    mrrCents,
    arrCents: mrrCents * 12,
    // One org in scope, so ARPU is MRR. Written as a division anyway so the shape
    // is right the day this aggregates over more than one.
    arpuCents: paying ? mrrCents : 0,
    churnRatePct: 0,
    expansionCents: 0,
    paidOrgs: paying ? 1 : 0,
    trialOrgs: paying ? 0 : 1,
  };

  // --- margin ------------------------------------------------------------

  const tokensByPeriod = new Map<string, number>();
  for (const event of usage) {
    const key = periodKey(event.at, query.grain);
    tokensByPeriod.set(key, (tokensByPeriod.get(key) ?? 0) + event.tokens);
  }

  // Usage events are the meter of record, but a meeting that has not flushed one
  // still knows what it consumed. Falling back keeps a fresh org from showing an
  // empty chart next to a non-empty meetings list.
  const meetingsByPeriod = new Map<string, MeetingDoc[]>();
  for (const meeting of orgMeetings) {
    const key = periodKey(meeting.startedAt ?? meeting.createdAt, query.grain);
    const bucket = meetingsByPeriod.get(key);
    if (bucket === undefined) meetingsByPeriod.set(key, [meeting]);
    else bucket.push(meeting);
  }

  const margin = starts.map((start) => {
    const key = periodKey(start, query.grain);
    const inPeriod = meetingsByPeriod.get(key) ?? [];

    const meteredTokens = tokensByPeriod.get(key);
    const tokens =
      meteredTokens ?? inPeriod.reduce((sum, meeting) => sum + meeting.tokensConsumed, 0);

    // Only what was genuinely recorded. A null costCents contributes nothing
    // rather than a modelled figure — see UNAVAILABLE.
    const costCents = inPeriod.reduce((sum, meeting) => sum + (meeting.costCents ?? 0), 0);

    // A monthly subscription spread evenly over the days in the bucket, and only
    // for buckets that fall after the org started paying.
    const days = periodDays(start, query.grain);
    const active = paying && start.getTime() >= startOfDay(org.createdAt).getTime();
    const revenueCents = active ? Math.round(((mrrCents * 12) / 365) * days) : 0;

    return {
      period: key,
      meetings: inPeriod.length,
      tokens,
      revenueCents,
      costCents,
      grossMarginPct:
        revenueCents === 0 ? 0 : Math.round(((revenueCents - costCents) / revenueCents) * 100),
      costPerMeetingCents: inPeriod.length === 0 ? 0 : Math.round(costCents / inPeriod.length),
      revenuePerMeetingCents:
        inPeriod.length === 0 ? 0 : Math.round(revenueCents / inPeriod.length),
    };
  });

  // --- acquisition -------------------------------------------------------

  const acquisition = buildAcquisition(org, paying);

  // --- discounts ---------------------------------------------------------

  const [redemptionsCol, promotionsCol] = await Promise.all([redemptions(), promotions()]);
  const orgRedemptions = await redemptionsCol.find({ orgId: org._id }).toArray();

  const promotionIds = [...new Set(orgRedemptions.map((row) => row.promotionId.toHexString()))];
  const promotionDocs =
    promotionIds.length === 0
      ? []
      : await promotionsCol.find({ _id: { $in: orgRedemptions.map((r) => r.promotionId) } }).toArray();

  const codeById = new Map(promotionDocs.map((row) => [row._id.toHexString(), row.code]));

  const discountTotals = new Map<string, { redemptions: number; discountCents: number }>();
  for (const row of orgRedemptions) {
    const code = codeById.get(row.promotionId.toHexString()) ?? 'unknown';
    const entry = discountTotals.get(code) ?? { redemptions: 0, discountCents: 0 };
    entry.redemptions += 1;
    entry.discountCents += row.valueAppliedCents;
    discountTotals.set(code, entry);
  }

  const discounts = [...discountTotals].map(([code, totals]) => ({
    code,
    redemptions: totals.redemptions,
    discountCents: totals.discountCents,
    // The revenue this org contributes, which is the counterweight to what the
    // code cost. Real, because it is this org's own subscription.
    attributedRevenueCents: mrrCents,
  }));

  return ok({
    grain: query.grain,
    generatedAt: now.toISOString(),
    series,
    funnel,
    revenue,
    margin,
    acquisition,
    discounts,
    unavailable: UNAVAILABLE,
  });
};

function buildAcquisition(org: OrgDoc, paying: boolean): unknown[] {
  const touch = org.attribution.firstTouch;
  if (touch === null) {
    return [
      {
        source: null,
        medium: null,
        campaign: null,
        // Not measured here; see UNAVAILABLE.
        visits: 0,
        signups: 1,
        paid: paying ? 1 : 0,
      },
    ];
  }

  return [
    {
      source: touch.source,
      medium: touch.medium,
      campaign: touch.campaign,
      visits: 0,
      signups: 1,
      paid: paying ? 1 : 0,
    },
  ];
}

// ---------------------------------------------------------------------------
// GET /admin/analytics/live
// ---------------------------------------------------------------------------

const LIVE_STATUSES = ['launching', 'joining', 'live', 'ending'] as const;

export const getLiveSnapshot: RouteHandler = async (req, deps) => {
  const actor = await authenticate(req);
  if (actor.role !== 'owner') throw forbidden('Owner access only.');

  const now = deps.now();
  const [meetingsCol, connectionsCol, tasksCol] = await Promise.all([
    meetings(),
    connections(),
    tasks(),
  ]);

  const [meetingsRunning, daemonsConnected, tasksInFlight] = await Promise.all([
    meetingsCol.countDocuments({ orgId: actor.orgId, status: { $in: LIVE_STATUSES } }),
    connectionsCol.countDocuments({ orgId: actor.orgId }),
    tasksCol.countDocuments({ orgId: actor.orgId, status: 'in_progress' }),
  ]);

  return ok({
    at: now.toISOString(),
    meetingsRunning,
    // Scoped to this tenant, so it is 0 or 1 — see the scope note at the top.
    orgsOnline: daemonsConnected > 0 ? 1 : 0,
    daemonsConnected,
    tasksInFlight,
  });
};

export const analyticsRoutes = [
  { method: 'GET', pattern: '/admin/analytics', handler: getOwnerAnalytics },
  { method: 'GET', pattern: '/admin/analytics/live', handler: getLiveSnapshot },
] as const satisfies readonly { method: string; pattern: string; handler: RouteHandler }[];

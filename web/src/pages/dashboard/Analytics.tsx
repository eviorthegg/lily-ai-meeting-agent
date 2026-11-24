import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarGroups, Funnel, Sparkline, Stat, type ChartSeries } from '@/components/ui/Chart';
import { RowTh, Table, TableScroll, Tbody, Td, Th, Thead } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Status';
import {
  ErrorState,
  ForbiddenState,
  LoadingRows,
  PageHeader,
  Panel,
  StaleNotice,
} from '@/components/ui/States';
import {
  api,
  type AnalyticsGrain,
  type LiveSnapshot,
  type OwnerAnalytics,
  type UnavailableFigure,
} from '@/lib/api';
import { useApi } from '@/lib/api/useApi';
import { useAuth } from '@/lib/auth/AuthProvider';
import { isOwner } from '@/lib/auth/roles';
import { compact, money, number, percent, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * Owner analytics.
 *
 * This is the product owner's view of the business and is not a customer
 * feature. It is gated three ways and the third is the only one that counts:
 * the nav item is hidden for non-owners, this component checks the role, and the
 * API returns 403 — which lands here as `ForbiddenState`, not a crash. Anyone
 * who types the URL gets the third one.
 *
 * Everything on the page is a number someone would act on. There is no "total
 * page views" tile, no cumulative-signups line that can only go up, and no
 * percentage without its denominator. The one number the whole thing exists for
 * is gross margin per meeting, because it decides whether the $20 tier is a
 * business or a subsidy.
 */

const GRAINS: ReadonlyArray<{ id: AnalyticsGrain; label: string; periods: number }> = [
  { id: 'day', label: 'Daily', periods: 30 },
  { id: 'week', label: 'Weekly', periods: 26 },
  { id: 'month', label: 'Monthly', periods: 12 },
];

const LIVE_POLL_MS = 15_000;

export function Analytics() {
  const { user } = useAuth();
  const [grain, setGrain] = useState<AnalyticsGrain>('week');
  const periods = GRAINS.find((entry) => entry.id === grain)?.periods ?? 26;

  const loadAnalytics = useCallback(
    () => api.getOwnerAnalytics({ grain, periods }),
    [grain, periods],
  );
  const analytics = useApi<OwnerAnalytics>(loadAnalytics, [grain, periods]);

  const loadLive = useCallback(() => api.getLiveSnapshot(), []);
  const live = useApi<LiveSnapshot>(loadLive, []);

  // Polled rather than pushed: the dashboard socket carries this org's presence,
  // not a cross-org rollup, and inventing a fan-out for one tile would be the
  // wrong trade.
  const reloadLive = live.reload;
  useEffect(() => {
    const timer = setInterval(reloadLive, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [reloadLive]);

  const data = analytics.data;

  const acquisitionSeries = useMemo<ChartSeries[]>(() => {
    if (data === null) return [];
    return [
      { key: 'signups', label: 'Signups', tone: 'ink', values: data.series.map((p) => p.signups) },
      {
        key: 'activations',
        label: 'Activations (first meeting)',
        tone: 'green',
        values: data.series.map((p) => p.activations),
      },
      {
        key: 'paid',
        label: 'Paid conversions',
        tone: 'grey',
        values: data.series.map((p) => p.paidConversions),
      },
    ];
  }, [data]);

  const marginSeries = useMemo<ChartSeries[]>(() => {
    if (data === null) return [];
    return [
      {
        key: 'revenue',
        label: 'Revenue',
        tone: 'ink',
        values: data.margin.map((row) => row.revenueCents),
      },
      { key: 'cost', label: 'Lily runtime cost', tone: 'green', values: data.margin.map((row) => row.costCents) },
    ];
  }, [data]);

  // Role check in the browser, which the API repeats and which is the one that
  // matters. Both are here because a wrong-role user should see a sentence, not
  // a failed request.
  if (user !== null && !isOwner(user.role)) return <ForbiddenState what="owner analytics" />;
  if (analytics.forbidden) return <ForbiddenState what="owner analytics" />;
  if (analytics.loading) return <LoadingRows rows={9} label="Loading analytics" />;
  if (analytics.error !== null && data === null) {
    return <ErrorState error={analytics.error} onRetry={analytics.reload} what="analytics" />;
  }
  if (data === null) return null;

  const totals = data.margin.reduce(
    (sum, row) => ({
      meetings: sum.meetings + row.meetings,
      tokens: sum.tokens + row.tokens,
      revenueCents: sum.revenueCents + row.revenueCents,
      costCents: sum.costCents + row.costCents,
    }),
    { meetings: 0, tokens: 0, revenueCents: 0, costCents: 0 },
  );

  const blendedMarginPct =
    totals.revenueCents === 0
      ? 0
      : ((totals.revenueCents - totals.costCents) / totals.revenueCents) * 100;
  const costPerMeeting = totals.meetings === 0 ? 0 : totals.costCents / totals.meetings;
  const revenuePerMeeting = totals.meetings === 0 ? 0 : totals.revenueCents / totals.meetings;
  // What the $20 tier actually buys before it stops paying for itself.
  const meetingsCoveredByTier = costPerMeeting === 0 ? 0 : Math.floor(2_000 / costPerMeeting);

  return (
    <>
      <PageHeader
        eyebrow="owner only"
        title="Analytics"
        intro="Not visible to customers. Acquisition, revenue, and the unit economics of a meeting."
        actions={
          <div className="flex gap-2" role="group" aria-label="Time grain">
            {GRAINS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={grain === entry.id}
                onClick={() => setGrain(entry.id)}
                className={cn(
                  'h-10 rounded-pill border px-4 text-[14px] font-medium transition-colors',
                  grain === entry.id
                    ? 'border-ink bg-ink text-white'
                    : 'border-hair bg-white text-grey hover:text-ink',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
        }
      />

      {analytics.stale ? <StaleNotice fetchedAt={analytics.fetchedAt} onRetry={analytics.reload} /> : null}

      <NotMeasured entries={data.unavailable} />

      {/* --- live ---------------------------------------------------------- */}
      <section aria-labelledby="live-heading" className="mb-9">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="live-heading" className="text-[17px] font-medium tracking-headline">
            Right now
          </h2>
          <p className="text-[13px] text-grey" aria-live="polite">
            {live.error !== null && live.data !== null
              ? `Last good reading ${relativeTime(live.fetchedAt)} — refresh failed`
              : live.data === null
                ? 'Reading…'
                : `Updated ${relativeTime(live.fetchedAt)}`}
          </p>
        </div>

        {live.data === null && live.error !== null ? (
          <Panel>
            <p className="text-[14px] text-grey">
              The live counters are unavailable. Everything below is historical and unaffected.
            </p>
          </Panel>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Meetings running"
              value={live.data === null ? '—' : number(live.data.meetingsRunning)}
              tone="green"
            />
            <Stat label="Orgs online" value={live.data === null ? '—' : number(live.data.orgsOnline)} />
            <Stat
              label="Daemons connected"
              value={live.data === null ? '—' : number(live.data.daemonsConnected)}
            />
            <Stat
              label="Tasks in flight"
              value={live.data === null ? '—' : number(live.data.tasksInFlight)}
            />
          </div>
        )}
      </section>

      {/* --- revenue ------------------------------------------------------- */}
      <section aria-labelledby="revenue-heading" className="mb-9">
        <h2 id="revenue-heading" className="mb-4 text-[17px] font-medium tracking-headline">
          Revenue
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="MRR" value={money(data.revenue.mrrCents, { compact: true })} note={`${data.revenue.paidOrgs} paying orgs`} />
          <Stat label="ARR" value={money(data.revenue.arrCents, { compact: true })} />
          <Stat label="ARPU" value={money(data.revenue.arpuCents)} note="per paying org, per month" />
          <Stat
            label="Churn"
            value={percent(data.revenue.churnRatePct)}
            note="logo, trailing period"
            tone={data.revenue.churnRatePct > 5 ? 'danger' : 'ink'}
          />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Stat
            label="Expansion from top-ups"
            value={money(data.revenue.expansionCents, { compact: true })}
            note="packs bought above the allowance"
            tone="green"
          />
          <Stat label="Orgs on the free tier" value={number(data.revenue.trialOrgs)} note="no card, no countdown" />
        </div>
      </section>

      {/* --- margin -------------------------------------------------------- */}
      <section aria-labelledby="margin-heading" className="mb-9">
        <h2 id="margin-heading" className="text-[17px] font-medium tracking-headline">
          Unit economics
        </h2>
        <p className="mb-4 mt-2 max-w-[46rem] text-[14px] leading-relaxed text-grey">
          Cost is Lily&apos;s own metered runtime — realtime audio, the orchestrator box, TTS,
          search and reasoning — and never an employee&apos;s own agent usage, which we do not pay
          for. Token allowances are still provisional, so treat the absolute figures as directional
          and the trend as real.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Gross margin"
            value={percent(blendedMarginPct)}
            note="blended, over the shown range"
            tone={blendedMarginPct < 50 ? 'danger' : 'green'}
          />
          <Stat label="Cost per meeting" value={money(Math.round(costPerMeeting))} />
          <Stat label="Revenue per meeting" value={money(Math.round(revenuePerMeeting))} />
          <Stat
            label="Meetings the $20 tier covers"
            value={String(meetingsCoveredByTier)}
            note="before that seat stops paying for itself"
            tone={meetingsCoveredByTier < 20 ? 'danger' : 'ink'}
          />
        </div>

        <Panel className="mt-4">
          <BarGroups
            caption={`Revenue against Lily runtime cost, per ${grain}`}
            periods={data.margin.map((row) => row.period)}
            series={marginSeries}
            formatValue={(value) => money(value)}
          />
        </Panel>

        <Panel className="mt-4">
          <h3 className="mb-3 text-[14px] font-medium">Gross margin over time</h3>
          <Sparkline
            caption={`Gross margin percentage per ${grain}`}
            periods={data.margin.map((row) => row.period)}
            values={data.margin.map((row) => row.grossMarginPct)}
            formatValue={(value) => percent(value)}
            tone="green"
          />
        </Panel>

        <TableScroll label="Unit economics by period" className="mt-4">
          <Table
            caption="Meetings, tokens, revenue, cost and gross margin for each period"
            minWidth="58rem"
          >
            <Thead>
              <Th width="8rem">Period</Th>
              <Th width="7rem">Meetings</Th>
              <Th width="8rem">Tokens</Th>
              <Th width="8rem">Revenue</Th>
              <Th width="8rem">Cost</Th>
              <Th width="7rem">Margin</Th>
              <Th width="9rem">Cost / meeting</Th>
            </Thead>
            <Tbody>
              {[...data.margin].reverse().map((row) => (
                <tr key={row.period} className="hover:bg-paper">
                  <RowTh className="data font-normal">{row.period}</RowTh>
                  <Td className="data text-grey">{number(row.meetings)}</Td>
                  <Td className="data text-grey">{compact(row.tokens)}</Td>
                  <Td className="data">{money(row.revenueCents)}</Td>
                  <Td className="data text-grey">{money(row.costCents)}</Td>
                  <Td
                    className={cn('data', row.grossMarginPct < 50 ? 'text-[#b42318]' : 'text-green-deep')}
                  >
                    {percent(row.grossMarginPct)}
                  </Td>
                  <Td className="data text-grey">{money(row.costPerMeetingCents)}</Td>
                </tr>
              ))}
            </Tbody>
          </Table>
        </TableScroll>
      </section>

      {/* --- acquisition --------------------------------------------------- */}
      <section aria-labelledby="acquisition-heading" className="mb-9">
        <h2 id="acquisition-heading" className="mb-4 text-[17px] font-medium tracking-headline">
          Signups, activations, conversions
        </h2>
        <Panel>
          <BarGroups
            caption={`Signups, activations and paid conversions per ${grain}`}
            periods={data.series.map((point) => point.period)}
            series={acquisitionSeries}
          />
          <p className="mt-4 border-t border-hair pt-4 text-[13px] text-grey">
            An activation is a first meeting actually run — not a signup, not an install. It is the
            only definition used anywhere in this dashboard.
          </p>
        </Panel>
      </section>

      {/* --- funnel -------------------------------------------------------- */}
      <section aria-labelledby="funnel-heading" className="mb-9 grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 id="funnel-heading" className="mb-4 text-[17px] font-medium tracking-headline">
            Funnel
          </h2>
          <Funnel caption="Conversion from first visit through to paid" stages={data.funnel} />
          <p className="mt-4 border-t border-hair pt-4 text-[13px] text-grey">
            Percentages are against the stage immediately above, which is the one that tells you
            where to spend the week.
          </p>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-[17px] font-medium tracking-headline">Discount codes</h2>
          <TableScroll label="Discount code performance">
            <Table
              caption="Discount codes with redemptions, discount given and revenue attributed"
              minWidth="34rem"
            >
              <Thead>
                <Th width="9rem">Code</Th>
                <Th width="7rem">Uses</Th>
                <Th width="8rem">Given away</Th>
                <Th width="9rem">Revenue after</Th>
              </Thead>
              <Tbody>
                {data.discounts.map((row) => (
                  <tr key={row.code} className="hover:bg-paper">
                    <RowTh className="data font-normal">{row.code}</RowTh>
                    <Td className="data text-grey">{number(row.redemptions)}</Td>
                    <Td className="data text-grey">{money(row.discountCents)}</Td>
                    <Td className="data">
                      {money(row.attributedRevenueCents)}
                      <span
                        className={cn(
                          'ml-2 text-[12px]',
                          row.attributedRevenueCents > row.discountCents * 2
                            ? 'text-green-deep'
                            : 'text-[#b42318]',
                        )}
                      >
                        {(row.attributedRevenueCents / Math.max(1, row.discountCents)).toFixed(1)}×
                      </span>
                    </Td>
                  </tr>
                ))}
              </Tbody>
            </Table>
          </TableScroll>
        </Panel>
      </section>

      {/* --- attribution --------------------------------------------------- */}
      <section aria-labelledby="utm-heading">
        <h2 id="utm-heading" className="mb-4 text-[17px] font-medium tracking-headline">
          Acquisition by source
        </h2>
        <TableScroll label="Acquisition by UTM source, medium and campaign">
          <Table
            caption="Visits, signups and paid conversions by UTM source, medium and campaign"
            minWidth="64rem"
          >
            <Thead>
              <Th width="11rem">Source</Th>
              <Th width="9rem">Medium</Th>
              <Th width="11rem">Campaign</Th>
              <Th width="8rem">Visits</Th>
              <Th width="8rem">Signups</Th>
              <Th width="7rem">Paid</Th>
              <Th width="9rem">Visit → paid</Th>
            </Thead>
            <Tbody>
              {data.acquisition.map((row) => {
                const rate = row.visits === 0 ? 0 : (row.paid / row.visits) * 100;
                return (
                  <tr key={`${row.source}-${row.medium}-${row.campaign}`} className="hover:bg-paper">
                    <RowTh className="font-normal">{row.source ?? <span className="text-grey">direct</span>}</RowTh>
                    <Td className="text-grey">{row.medium ?? '—'}</Td>
                    <Td className="text-grey">{row.campaign ?? '—'}</Td>
                    <Td className="data text-grey">{number(row.visits)}</Td>
                    <Td className="data text-grey">{number(row.signups)}</Td>
                    <Td className="data">{number(row.paid)}</Td>
                    <Td>
                      <Badge tone={rate >= 1 ? 'positive' : 'muted'}>{percent(rate, 2)}</Badge>
                    </Td>
                  </tr>
                );
              })}
            </Tbody>
          </Table>
        </TableScroll>
        <p className="mt-3 text-[13px] text-grey">
          First touch is immutable once written; last touch is overwritten on every landing that
          carries campaign parameters. These rows are first touch.
        </p>
      </section>
    </>
  );
}

/**
 * Figures the server could not derive, named rather than faked.
 *
 * This panel is the reason the numbers next to it can be trusted. Where an event
 * history does not exist yet — subscription lifecycle, metered vendor spend —
 * the API reports zero *and says so here*, instead of modelling a plausible
 * value. A margin chart built on an invented cost is worse than no margin chart,
 * because someone will price against it.
 *
 * Renders nothing when everything is measurable, which is also what the demo
 * fixture produces.
 */
function NotMeasured({ entries }: { entries: readonly UnavailableFigure[] }) {
  if (entries.length === 0) return null;

  return (
    <section aria-labelledby="not-measured-heading" className="mb-9">
      <Panel>
        <h2 id="not-measured-heading" className="text-[15px] font-medium tracking-headline">
          Not measured yet
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-grey">
          These show as zero below because nothing records them, not because they are zero.
        </p>
        <ul className="mt-4 flex flex-col gap-3 border-t border-hair pt-4">
          {entries.map((entry) => (
            <li key={entry.field} className="text-[14px] leading-relaxed">
              <span className="data text-ink">{entry.field}</span>
              <span className="mt-1 block text-grey">{entry.reason}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { RowTh, SpanRow, Table, TableScroll, Tbody, Td, Th, Thead } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Status';
import {
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingRows,
  PageHeader,
  StaleNotice,
} from '@/components/ui/States';
import { api, type AuditAction, type AuditPage, type AuditQuery } from '@/lib/api';
import { useApi, useApiAction } from '@/lib/api/useApi';
import { useAuth } from '@/lib/auth/AuthProvider';
import { downloadText } from '@/lib/csv';
import { absoluteTime, humanise, relativeTime } from '@/lib/format';

/**
 * Audit log.
 *
 * Search and the action filter are server-side query parameters, and export runs
 * the same query — so what you download is exactly what you were looking at,
 * not the page of it that happened to be loaded. Exporting is itself an audited
 * action, which is why the table refreshes afterwards.
 *
 * Audit entries outlive the retention sweep that clears summaries and task text.
 * They are the compliance record of who authorised what, and deleting them with
 * the content they describe would defeat the point.
 */

const ACTIONS: readonly AuditAction[] = [
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
];

const SEVERE = new Set<string>([
  'permission.denied',
  'token.reuse_detected',
  'employee.removed',
  'data.hard_deleted',
]);

const PAGE_SIZE = 25;

export function Audit() {
  const { org } = useAuth();
  const orgId = org?.id ?? null;

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);

  // Debounced, so typing a name is one request when you stop rather than one
  // per keystroke against a collection that only grows.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setCursor(null);
      setCursorStack([]);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query: AuditQuery = {
    search: search === '' ? null : search,
    action: action === '' ? null : (action as AuditAction),
    from: from === '' ? null : `${from}T00:00:00.000Z`,
    to: to === '' ? null : `${to}T23:59:59.999Z`,
    limit: PAGE_SIZE,
    cursor,
  };

  const load = useCallback(
    () =>
      orgId === null
        ? Promise.resolve<AuditPage>({ entries: [], nextCursor: null, total: 0 })
        : api.listAudit(orgId, query),
    // The query object is rebuilt each render; its fields are the real deps.
    [orgId, search, action, from, to, cursor],
  );
  const page = useApi(load, [orgId, search, action, from, to, cursor]);
  const exporting = useApiAction();

  const entries = page.data?.entries ?? [];
  const total = page.data?.total ?? 0;
  const filtered = search !== '' || action !== '' || from !== '' || to !== '';

  async function onExport() {
    if (orgId === null) return;
    // No cursor and no limit: export the whole filtered set, not this page.
    const csv = await exporting.run(() =>
      api.exportAudit(orgId, { ...query, limit: null, cursor: null }),
    );
    if (csv === null) return;
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`lily-audit-${stamp}.csv`, csv);
    page.reload();
  }

  function clearFilters() {
    setSearchInput('');
    setSearch('');
    setAction('');
    setFrom('');
    setTo('');
    setCursor(null);
    setCursorStack([]);
  }

  return (
    <>
      <PageHeader
        eyebrow="audit"
        title="Audit log"
        intro="Who authorised what, and when. Kept beyond the retention window on purpose."
        actions={
          <Button variant="secondary" onClick={() => void onExport()} disabled={exporting.busy || total === 0}>
            {exporting.busy ? 'Preparing…' : `Export ${total} as CSV`}
          </Button>
        }
      />

      {exporting.error !== null ? (
        <p role="alert" className="mb-5 rounded-card border border-[#f3d3d0] bg-[#fdf4f3] px-4 py-3 text-[14px] text-[#b42318]">
          {exporting.error.message}
        </p>
      ) : null}

      <form
        className="mb-5 grid gap-3 rounded-card border border-hair bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => event.preventDefault()}
        aria-label="Filter the audit log"
      >
        <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-1">
          <label htmlFor="audit-search" className="text-[13px] font-medium">
            Search
          </label>
          <input
            id="audit-search"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Person, command, IP"
            className="h-11 rounded-card border border-hair bg-white px-3 text-[15px] placeholder:text-grey focus:border-ink"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-action" className="text-[13px] font-medium">
            Action
          </label>
          <select
            id="audit-action"
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              setCursor(null);
              setCursorStack([]);
            }}
            className="h-11 rounded-card border border-hair bg-white px-3 text-[15px] focus:border-ink"
          >
            <option value="">Every action</option>
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-from" className="text-[13px] font-medium">
            From
          </label>
          <input
            id="audit-from"
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setCursor(null);
              setCursorStack([]);
            }}
            className="h-11 rounded-card border border-hair bg-white px-3 text-[15px] focus:border-ink"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-to" className="text-[13px] font-medium">
            To
          </label>
          <input
            id="audit-to"
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setCursor(null);
              setCursorStack([]);
            }}
            className="h-11 rounded-card border border-hair bg-white px-3 text-[15px] focus:border-ink"
          />
        </div>
      </form>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Badge tone="neutral">{total} entries</Badge>
        {filtered ? (
          <button
            type="button"
            onClick={clearFilters}
            className="text-[14px] text-green-deep underline underline-offset-4"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {page.stale ? <StaleNotice fetchedAt={page.fetchedAt} onRetry={page.reload} /> : null}

      {page.forbidden ? (
        <ForbiddenState what="the audit log" />
      ) : page.loading ? (
        <LoadingRows rows={8} label="Loading the audit log" />
      ) : page.error !== null && page.data === null ? (
        <ErrorState error={page.error} onRetry={page.reload} what="the audit log" />
      ) : entries.length === 0 && !filtered ? (
        <EmptyState
          title="Nothing logged yet"
          body="Every permission decision, invite, policy change and token rotation lands here as it happens."
        />
      ) : (
        <>
          <TableScroll label="Audit entries">
            <Table
              caption="Audit entries: what happened, who did it, to whom, and when"
              minWidth="62rem"
            >
              <Thead>
                <Th width="13rem">Action</Th>
                <Th>Detail</Th>
                <Th width="10rem">Actor</Th>
                <Th width="10rem">Subject</Th>
                <Th width="10rem">When</Th>
              </Thead>
              <Tbody>
                {entries.length === 0 ? (
                  <SpanRow columns={5}>
                    Nothing matches those filters.{' '}
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="text-green-deep underline underline-offset-4"
                    >
                      Clear them
                    </button>
                    .
                  </SpanRow>
                ) : (
                  entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-paper">
                      <RowTh className="font-normal">
                        <Badge tone={SEVERE.has(entry.action) ? 'danger' : 'neutral'}>
                          {humanise(entry.action)}
                        </Badge>
                      </RowTh>
                      <Td className="data">
                        {entry.detail}
                        {entry.meetingId === null ? null : (
                          <Link
                            to={`/app/meetings/${encodeURIComponent(entry.meetingId)}`}
                            className="ml-2 text-[13px] text-green-deep underline underline-offset-4"
                          >
                            meeting
                          </Link>
                        )}
                      </Td>
                      <Td className="text-grey">
                        {entry.actorName ?? <span className="text-[13px]">system</span>}
                        {entry.ip === null ? null : (
                          <span className="mt-0.5 block text-[12px]">{entry.ip}</span>
                        )}
                      </Td>
                      <Td className="text-grey">{entry.subjectName ?? '—'}</Td>
                      <Td className="text-grey">
                        <span title={absoluteTime(entry.at)}>{relativeTime(entry.at)}</span>
                      </Td>
                    </tr>
                  ))
                )}
              </Tbody>
            </Table>
          </TableScroll>

          <nav className="mt-5 flex items-center justify-between gap-4" aria-label="Audit pages">
            <button
              type="button"
              disabled={cursorStack.length === 0}
              onClick={() => {
                setCursorStack((stack) => {
                  const next = [...stack];
                  const previous = next.pop() ?? null;
                  setCursor(previous);
                  return next;
                });
              }}
              className="h-11 rounded-pill border border-hair px-5 text-[14px] font-medium disabled:opacity-45"
            >
              Previous
            </button>
            <p className="text-[13px] text-grey">
              {entries.length === 0
                ? 'No entries'
                : `${cursorStack.length * PAGE_SIZE + 1}–${cursorStack.length * PAGE_SIZE + entries.length} of ${total}`}
            </p>
            <button
              type="button"
              disabled={page.data?.nextCursor == null}
              onClick={() => {
                const next = page.data?.nextCursor ?? null;
                if (next === null) return;
                setCursorStack((stack) => [...stack, cursor]);
                setCursor(next);
              }}
              className="h-11 rounded-pill border border-hair px-5 text-[14px] font-medium disabled:opacity-45"
            >
              Next
            </button>
          </nav>
        </>
      )}
    </>
  );
}

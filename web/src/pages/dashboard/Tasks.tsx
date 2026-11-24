import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RowTh, SpanRow, Table, TableScroll, Tbody, Td, Th, Thead } from '@/components/ui/DataTable';
import { Badge, TaskStatusBadge } from '@/components/ui/Status';
import {
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingRows,
  PageHeader,
  StaleNotice,
} from '@/components/ui/States';
import { api, type Task, type TaskStatus, type TeamMember } from '@/lib/api';
import { useApi } from '@/lib/api/useApi';
import { useAuth } from '@/lib/auth/AuthProvider';
import { dateOnly, humanise, relativeTime } from '@/lib/format';
import { useLive } from '@/lib/live/LiveProvider';
import { cn } from '@/lib/cn';

/**
 * Tasks across every meeting.
 *
 * Filtering happens on the server — owner, status and the due-date window are
 * query parameters, not a client-side `.filter()` over everything. At this data
 * volume either would work; doing it on the server is what keeps working when a
 * year of tasks exists, and it means the filter state and the request are the
 * same thing rather than two things that can disagree.
 *
 * The live column is `agent.status` off the socket: a task that is being worked
 * on right now says so, including when it is sitting waiting for someone to
 * approve a permission — which is the state a manager most often wants to catch.
 */

const STATUSES: readonly TaskStatus[] = [
  'unconfirmed',
  'confirmed',
  'in_progress',
  'done',
  'cancelled',
];

const AGENT_STATE_TONE: Readonly<Record<string, 'neutral' | 'warning' | 'positive' | 'danger'>> = {
  queued: 'neutral',
  running: 'neutral',
  awaiting_permission: 'warning',
  done: 'positive',
  failed: 'danger',
};

export function Tasks() {
  const { org } = useAuth();
  const orgId = org?.id ?? null;
  const { agentStatusFor, isLive } = useLive();

  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState('');
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');

  const loadTeam = useCallback(
    () => (orgId === null ? Promise.resolve<TeamMember[]>([]) : api.listTeam(orgId)),
    [orgId],
  );
  const team = useApi(loadTeam, [orgId]);

  const loadTasks = useCallback(
    () =>
      orgId === null
        ? Promise.resolve<Task[]>([])
        : api.listOrgTasks(orgId, {
            ownerEmployeeId: owner === '' ? null : owner,
            status: status === '' ? null : (status as TaskStatus),
            // Dates arrive as YYYY-MM-DD; the API compares ISO strings, so the
            // window is widened to cover the whole of both boundary days.
            dueFrom: dueFrom === '' ? null : `${dueFrom}T00:00:00.000Z`,
            dueTo: dueTo === '' ? null : `${dueTo}T23:59:59.999Z`,
            limit: 200,
          }),
    [orgId, owner, status, dueFrom, dueTo],
  );
  const tasks = useApi(loadTasks, [orgId, owner, status, dueFrom, dueTo]);

  const nameByEmployeeId = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of team.data ?? []) map.set(member.employeeId, member.name);
    return map;
  }, [team.data]);

  const rows = tasks.data ?? [];
  const filtered = owner !== '' || status !== '' || dueFrom !== '' || dueTo !== '';
  const overdue = rows.filter(
    (task) =>
      task.due !== null &&
      Date.parse(task.due) < Date.now() &&
      task.status !== 'done' &&
      task.status !== 'cancelled',
  ).length;

  function clearFilters() {
    setOwner('');
    setStatus('');
    setDueFrom('');
    setDueTo('');
  }

  return (
    <>
      <PageHeader
        eyebrow="tasks"
        title="Tasks"
        intro="Everything Lily created or assigned, across every meeting."
      />

      <form
        className="mb-5 grid gap-3 rounded-card border border-hair bg-white p-4 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => event.preventDefault()}
        aria-label="Filter tasks"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="task-owner" className="text-[13px] font-medium">
            Owner
          </label>
          <select
            id="task-owner"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            className="h-11 rounded-card border border-hair bg-white px-3 text-[15px] focus:border-ink"
          >
            <option value="">Anyone</option>
            {(team.data ?? []).map((member) => (
              <option key={member.employeeId} value={member.employeeId}>
                {member.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="task-status" className="text-[13px] font-medium">
            Status
          </label>
          <select
            id="task-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="h-11 rounded-card border border-hair bg-white px-3 text-[15px] focus:border-ink"
          >
            <option value="">Any status</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="task-due-from" className="text-[13px] font-medium">
            Due from
          </label>
          <input
            id="task-due-from"
            type="date"
            value={dueFrom}
            onChange={(event) => setDueFrom(event.target.value)}
            className="h-11 rounded-card border border-hair bg-white px-3 text-[15px] focus:border-ink"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="task-due-to" className="text-[13px] font-medium">
            Due to
          </label>
          <input
            id="task-due-to"
            type="date"
            value={dueTo}
            onChange={(event) => setDueTo(event.target.value)}
            className="h-11 rounded-card border border-hair bg-white px-3 text-[15px] focus:border-ink"
          />
        </div>

        <div className="flex items-end">
          <button
            type="button"
            onClick={clearFilters}
            disabled={!filtered}
            className="h-11 w-full rounded-pill border border-hair px-4 text-[14px] font-medium transition-colors hover:border-[#dfe2e6] disabled:opacity-45"
          >
            Clear filters
          </button>
        </div>
      </form>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{rows.length} shown</Badge>
        {overdue > 0 ? <Badge tone="warning">{overdue} past due</Badge> : null}
        {isLive ? null : <Badge tone="muted">agent status not live</Badge>}
      </div>

      {tasks.stale ? <StaleNotice fetchedAt={tasks.fetchedAt} onRetry={tasks.reload} /> : null}

      {tasks.forbidden ? (
        <ForbiddenState what="this organization's tasks" />
      ) : tasks.loading ? (
        <LoadingRows rows={6} label="Loading tasks" />
      ) : tasks.error !== null && tasks.data === null ? (
        <ErrorState error={tasks.error} onRetry={tasks.reload} what="tasks" />
      ) : rows.length === 0 && !filtered ? (
        <EmptyState
          title="No tasks yet"
          body="Tasks appear here as soon as Lily creates one in a meeting — either something she does herself, or something she assigns to a person."
        />
      ) : (
        <TableScroll label="Tasks">
          <Table
            caption="Tasks across all meetings with owner, status, due date and live agent state"
            minWidth="64rem"
          >
            <Thead>
              <Th>Task</Th>
              <Th width="10rem">Owner</Th>
              <Th width="9rem">Status</Th>
              <Th width="11rem">Agent</Th>
              <Th width="8rem">Due</Th>
              <Th width="8rem">Meeting</Th>
            </Thead>
            <Tbody>
              {rows.length === 0 ? (
                <SpanRow columns={6}>
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
                rows.map((task) => {
                  const live = agentStatusFor(task.id);
                  const isOverdue =
                    task.due !== null &&
                    Date.parse(task.due) < Date.now() &&
                    task.status !== 'done' &&
                    task.status !== 'cancelled';
                  return (
                    <tr key={task.id} className="align-top hover:bg-paper">
                      <RowTh className="font-normal">
                        <span className="block max-w-[28rem]">{task.text}</span>
                        <span className="mt-1 block text-[12px] text-grey">
                          {task.type === 'lily_action' ? 'Lily ran this' : 'assigned to a person'} ·
                          created {relativeTime(task.createdAt)}
                        </span>
                      </RowTh>
                      <Td className="text-grey">
                        {nameByEmployeeId.get(task.ownerEmployeeId) ?? (
                          <span className="data">{task.ownerEmployeeId}</span>
                        )}
                      </Td>
                      <Td>
                        <TaskStatusBadge status={task.status} />
                      </Td>
                      <Td>
                        {live !== null && isLive ? (
                          <span className="flex flex-col items-start gap-1">
                            <Badge tone={AGENT_STATE_TONE[live.state] ?? 'neutral'}>
                              {humanise(live.state)}
                            </Badge>
                            {live.note === null ? null : (
                              <span className="text-[12px] text-grey">{live.note}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-[13px] text-grey">
                            {task.type === 'lily_action' ? humanise(task.dispatchOutcome) : '—'}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <span className={cn('text-[14px]', isOverdue ? 'text-[#b42318]' : 'text-grey')}>
                          {dateOnly(task.due)}
                        </span>
                      </Td>
                      <Td>
                        {task.meetingId === null ? (
                          <span className="text-[13px] text-grey">—</span>
                        ) : (
                          <Link
                            to={`/app/meetings/${encodeURIComponent(task.meetingId)}`}
                            className="text-[13px] text-green-deep underline underline-offset-4"
                          >
                            Open
                          </Link>
                        )}
                      </Td>
                    </tr>
                  );
                })
              )}
            </Tbody>
          </Table>
        </TableScroll>
      )}
    </>
  );
}

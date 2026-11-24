import { useCallback, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RowTh, Table, TableScroll, Tbody, Td, Th, Thead } from '@/components/ui/DataTable';
import {
  Badge,
  MeetingStatusBadge,
  PermissionBadge,
  TaskStatusBadge,
} from '@/components/ui/Status';
import {
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingRows,
  Panel,
  StaleNotice,
} from '@/components/ui/States';
import { Stat } from '@/components/ui/Chart';
import { api } from '@/lib/api';
import { useApi } from '@/lib/api/useApi';
import { ROLE_LABEL } from '@/lib/auth/roles';
import { absoluteTime, compact, dateOnly, durationFromSec, humanise, relativeTime } from '@/lib/format';

/**
 * One meeting.
 *
 * The permissions section is the reason this page exists in the shape it does.
 * A list of what was approved is a compliance artefact; a list of what was
 * approved *and refused* is a record of how the gate actually behaved, and
 * refusals are the half that tells a manager whether the policy is too tight or
 * an agent is asking for things it should not. Denials, timeouts and hard blocks
 * are shown with the same weight as grants, not folded away behind a filter.
 *
 * What is not here, and cannot be: transcript, recording, agent output, file
 * contents. None of it is persisted (see the data policy header in
 * api/src/db/schema.ts), so there is nothing to render and no placeholder for it
 * either — an empty "Transcript" panel would imply the feature is coming.
 */
export function MeetingDetail() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const id = meetingId ?? '';

  const load = useCallback(() => api.getMeetingDetail(id), [id]);
  const detail = useApi(load, [id]);

  /**
   * Names are resolved by joining against the participants in this response
   * rather than being duplicated onto every task and permission row — the same
   * rule `MeetingDoc` follows, where participants are ids and names come from a
   * join. Somebody who has since left the org is not in the participant list any
   * more, so the raw employee id remains the fallback and is shown as one.
   */
  const nameByEmployeeId = useMemo(() => {
    const map = new Map<string, string>();
    for (const person of detail.data?.participants ?? []) map.set(person.employeeId, person.name);
    return map;
  }, [detail.data]);

  if (detail.forbidden) return <ForbiddenState what="this meeting" />;
  if (detail.loading) return <LoadingRows rows={8} label="Loading the meeting" />;
  if (detail.error !== null && detail.data === null) {
    return <ErrorState error={detail.error} onRetry={detail.reload} what="this meeting" />;
  }
  if (detail.data === null) return null;

  const { meeting, participants, tasks, permissions } = detail.data;
  const confirmed = tasks.filter(
    (task) => task.status !== 'unconfirmed' && task.status !== 'cancelled',
  ).length;
  const unconfirmed = tasks.filter((task) => task.status === 'unconfirmed').length;
  const granted = permissions.filter((event) => event.decision === 'granted');
  const refused = permissions.filter((event) => event.decision !== 'granted');

  return (
    <>
      {detail.stale ? <StaleNotice fetchedAt={detail.fetchedAt} onRetry={detail.reload} /> : null}

      <nav aria-label="Breadcrumb" className="mb-4">
        <Link to="/app/meetings" className="text-[14px] text-grey underline-offset-4 hover:underline">
          ← All meetings
        </Link>
      </nav>

      <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">{meeting.platform}</p>
          <h1 className="mt-3 text-[26px] font-semibold tracking-headline sm:text-[30px]">
            {meeting.title ?? 'Untitled meeting'}
          </h1>
          <p className="mt-2 text-[14px] text-grey" title={absoluteTime(meeting.startedAt)}>
            {meeting.startedAt === null ? 'Not started' : relativeTime(meeting.startedAt)}
            {meeting.durationSec === null ? '' : ` · ${durationFromSec(meeting.durationSec)}`}
          </p>
        </div>
        <MeetingStatusBadge status={meeting.status} />
      </div>

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Participants" value={String(participants.length)} note={
          meeting.externalParticipantCount > 0
            ? `+ ${meeting.externalParticipantCount} external, not identified`
            : 'no external attendees'
        } />
        <Stat label="Tasks created" value={String(tasks.length)} note={`${confirmed} confirmed, ${unconfirmed} not`} />
        <Stat
          label="Permissions"
          value={String(permissions.length)}
          note={`${granted.length} granted, ${refused.length} refused`}
          tone={refused.length > granted.length ? 'danger' : 'ink'}
        />
        <Stat label="Lily tokens" value={compact(meeting.tokensConsumed)} note="her runtime only" />
      </div>

      {meeting.summary === null ? (
        <Panel className="mb-8">
          <h2 className="text-[17px] font-medium tracking-headline">Summary</h2>
          <p className="mt-3 max-w-measure text-[15px] leading-relaxed text-grey">
            {meeting.status === 'failed'
              ? 'This meeting failed before it produced one.'
              : 'Written when the meeting ends.'}
          </p>
        </Panel>
      ) : (
        <Panel className="mb-8">
          <h2 className="text-[17px] font-medium tracking-headline">Summary</h2>
          <p className="mt-3 max-w-[46rem] text-[15px] leading-relaxed">{meeting.summary}</p>
          {meeting.decisions.length > 0 ? (
            <>
              <h3 className="mt-6 text-[13px] font-medium uppercase tracking-[.06em] text-grey">
                Decisions
              </h3>
              <ul className="mt-3 flex flex-col gap-2">
                {meeting.decisions.map((decision) => (
                  <li key={decision} className="flex gap-3 text-[15px] leading-relaxed">
                    <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-green" />
                    {decision}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="mt-6 border-t border-hair pt-4 text-[13px] text-grey">
            The summary and the task text below are the only derived content stored from a meeting,
            and both are deleted with the org&apos;s retention window.
          </p>
        </Panel>
      )}

      <section aria-labelledby="participants-heading" className="mb-8">
        <h2 id="participants-heading" className="mb-4 text-[17px] font-medium tracking-headline">
          Participants
        </h2>
        {participants.length === 0 ? (
          <EmptyState title="No participants recorded" body="Nobody from the org was matched to this meeting." />
        ) : (
          <ul className="flex flex-wrap gap-2">
            {participants.map((person) => (
              <li key={person.userId}>
                <span className="inline-flex items-center gap-2 rounded-pill border border-hair bg-white px-3.5 py-2 text-[14px]">
                  {person.name}
                  <span className="text-[12px] text-grey">{ROLE_LABEL[person.role]}</span>
                  {person.daemonEnrolled ? null : <Badge tone="muted">no daemon</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="tasks-heading" className="mb-8">
        <h2 id="tasks-heading" className="mb-4 text-[17px] font-medium tracking-headline">
          Tasks
        </h2>
        {tasks.length === 0 ? (
          <EmptyState title="No tasks" body="Nothing was assigned or dispatched in this meeting." />
        ) : (
          <TableScroll label="Tasks created in this meeting">
            <Table
              caption="Tasks created in this meeting with their owner, status and dispatch outcome"
              minWidth="54rem"
            >
              <Thead>
                <Th>Task</Th>
                <Th width="9rem">Owner</Th>
                <Th width="9rem">Status</Th>
                <Th width="9rem">Dispatch</Th>
                <Th width="8rem">Due</Th>
              </Thead>
              <Tbody>
                {tasks.map((task) => (
                  <tr key={task.id} className="hover:bg-paper">
                    <RowTh className="font-normal">{task.text}</RowTh>
                    <Td className="text-grey">
                      {nameByEmployeeId.get(task.ownerEmployeeId) ?? (
                        <span className="data">{task.ownerEmployeeId}</span>
                      )}
                    </Td>
                    <Td>
                      <TaskStatusBadge status={task.status} />
                    </Td>
                    <Td className="text-grey">
                      {task.type === 'human_assignment' ? (
                        <span className="text-[13px]">assigned to a person</span>
                      ) : (
                        <span className="text-[13px]">{humanise(task.dispatchOutcome)}</span>
                      )}
                    </Td>
                    <Td className="text-grey">{dateOnly(task.due)}</Td>
                  </tr>
                ))}
              </Tbody>
            </Table>
          </TableScroll>
        )}
      </section>

      <section aria-labelledby="permissions-heading">
        <h2 id="permissions-heading" className="text-[17px] font-medium tracking-headline">
          Permissions
        </h2>
        <p className="mb-4 mt-2 max-w-measure text-[14px] leading-relaxed text-grey">
          Every gated action an agent asked for, and what happened. Refusals are listed with grants
          on purpose — what was turned down says as much about the policy as what was allowed. The
          command is recorded; its output never is.
        </p>

        {permissions.length === 0 ? (
          <EmptyState
            title="Nothing was gated"
            body="No agent asked to do anything that needed spoken approval in this meeting."
          />
        ) : (
          <TableScroll label="Permission decisions">
            <Table
              caption="Permission decisions in this meeting: who asked, what for, and the outcome"
              minWidth="58rem"
            >
              <Thead>
                <Th width="10rem">Decision</Th>
                <Th>What was asked for</Th>
                <Th width="8rem">Kind</Th>
                <Th width="9rem">Employee</Th>
                <Th width="10rem">When</Th>
              </Thead>
              <Tbody>
                {permissions.map((event) => (
                  <tr key={event.id} className="hover:bg-paper">
                    <RowTh className="font-normal">
                      <PermissionBadge decision={event.decision} />
                    </RowTh>
                    <Td className="data">{event.detail}</Td>
                    {/* Null when the stored audit row predates the
                        "<kind>: <command>" convention the API writes. An em dash
                        is the honest rendering: the decision is recorded, its
                        category is not, and guessing one would be worse. */}
                    <Td className="text-grey">
                      {event.kind === null ? '—' : humanise(event.kind)}
                    </Td>
                    <Td className="text-grey">
                      {nameByEmployeeId.get(event.employeeId) ?? (
                        <span className="data">{event.employeeId}</span>
                      )}
                    </Td>
                    <Td className="text-grey">
                      <span title={absoluteTime(event.at)}>{relativeTime(event.at)}</span>
                    </Td>
                  </tr>
                ))}
              </Tbody>
            </Table>
          </TableScroll>
        )}
      </section>
    </>
  );
}

import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { RowTh, SpanRow, Table, TableScroll, Tbody, Td, Th, Thead } from '@/components/ui/DataTable';
import { MeetingStatusBadge } from '@/components/ui/Status';
import {
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingRows,
  PageHeader,
  StaleNotice,
} from '@/components/ui/States';
import { api, type ListMeetingsQuery, type Meeting } from '@/lib/api';
import { useApi } from '@/lib/api/useApi';
import { useAuth } from '@/lib/auth/AuthProvider';
import { absoluteTime, compact, durationFromSec, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { StartMeetingModal } from './StartMeetingModal';

/**
 * Meetings, in flight and finished.
 *
 * "Upcoming" here means launching, joining, live or ending — not scheduled.
 * There is no scheduling model anywhere in the system: `MeetingDoc` has a
 * status and a `startedAt`, and a meeting comes into existence when someone
 * hands Lily a join link. Rather than invent a calendar the backend cannot
 * populate, the tab says what it actually contains.
 */

const PLATFORM_LABEL: Readonly<Record<string, string>> = {
  jitsi: 'Jitsi',
  zoom: 'Zoom',
  meet: 'Google Meet',
  teams: 'Teams',
  local: 'Simulated',
};

type Window = ListMeetingsQuery['window'];

const TABS: ReadonlyArray<{ id: Window; label: string }> = [
  { id: 'upcoming', label: 'In progress' },
  { id: 'past', label: 'Past' },
  { id: 'all', label: 'All' },
];

export function Meetings() {
  const { org } = useAuth();
  const orgId = org?.id ?? null;
  const [window, setWindow] = useState<Window>('upcoming');
  const [starting, setStarting] = useState(false);

  const load = useCallback(
    () =>
      orgId === null
        ? Promise.resolve<Meeting[]>([])
        : api.listMeetings(orgId, { window, limit: 100 }),
    [orgId, window],
  );
  const meetings = useApi(load, [orgId, window]);
  const rows = meetings.data ?? [];

  return (
    <>
      <PageHeader
        eyebrow="meetings"
        title="Meetings"
        intro="Metadata and outcomes only. No recording, no transcript — neither is stored anywhere in this system."
        actions={
          <Button type="button" onClick={() => setStarting(true)}>
            Start a meeting
          </Button>
        }
      />

      <StartMeetingModal
        open={starting}
        onClose={() => setStarting(false)}
        onStarted={() => {
          // A newly launched meeting is 'launching', which belongs in the
          // in-progress tab — switch there so it is visible rather than
          // appearing to have done nothing.
          setWindow('upcoming');
          void meetings.reload();
        }}
      />

      <div className="mb-5 flex flex-wrap items-center gap-2" role="tablist" aria-label="Meeting window">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={window === tab.id}
            onClick={() => setWindow(tab.id)}
            className={cn(
              'h-10 rounded-pill border px-4 text-[14px] font-medium transition-colors',
              window === tab.id
                ? 'border-ink bg-ink text-white'
                : 'border-hair bg-white text-grey hover:text-ink',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {meetings.stale ? <StaleNotice fetchedAt={meetings.fetchedAt} onRetry={meetings.reload} /> : null}

      {meetings.forbidden ? (
        <ForbiddenState what="this organization's meetings" />
      ) : meetings.loading ? (
        <LoadingRows rows={5} label="Loading meetings" />
      ) : meetings.error !== null && meetings.data === null ? (
        <ErrorState error={meetings.error} onRetry={meetings.reload} what="meetings" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={window === 'past' ? 'No finished meetings yet' : 'Nothing running'}
          body={
            window === 'past'
              ? 'A meeting appears here once it ends, with its summary, the tasks it produced and every permission decision that was made in it.'
              : 'A meeting exists from the moment someone gives Lily a join link. There is no calendar to schedule against — she joins when she is asked to.'
          }
        />
      ) : (
        <TableScroll label="Meetings">
          <Table
            caption="Meetings with their platform, status, duration, participants and Lily's token usage"
            minWidth="58rem"
          >
            <Thead>
              <Th>Meeting</Th>
              <Th width="9rem">Status</Th>
              <Th width="11rem">Started</Th>
              <Th width="7rem">Length</Th>
              <Th width="9rem">People</Th>
              <Th width="8rem">Lily tokens</Th>
            </Thead>
            <Tbody>
              {rows.length === 0 ? (
                <SpanRow columns={6}>Nothing to show.</SpanRow>
              ) : (
                rows.map((meeting) => (
                  <tr key={meeting.id} className="hover:bg-paper">
                    <RowTh>
                      <Link
                        to={`/app/meetings/${encodeURIComponent(meeting.id)}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {meeting.title ?? 'Untitled meeting'}
                      </Link>
                      <span className="mt-0.5 block text-[13px] font-normal text-grey">
                        {PLATFORM_LABEL[meeting.platform] ?? meeting.platform}
                      </span>
                    </RowTh>
                    <Td>
                      <MeetingStatusBadge status={meeting.status} />
                    </Td>
                    <Td>
                      <span className="text-grey" title={absoluteTime(meeting.startedAt)}>
                        {meeting.startedAt === null ? '—' : relativeTime(meeting.startedAt)}
                      </span>
                    </Td>
                    <Td className="text-grey">{durationFromSec(meeting.durationSec)}</Td>
                    <Td className="text-grey">
                      {meeting.participantUserIds.length} internal
                      {meeting.externalParticipantCount > 0 ? (
                        <span className="block text-[12px]">
                          + {meeting.externalParticipantCount} external
                        </span>
                      ) : null}
                    </Td>
                    <Td className="data text-grey">{compact(meeting.tokensConsumed)}</Td>
                  </tr>
                ))
              )}
            </Tbody>
          </Table>
        </TableScroll>
      )}
    </>
  );
}

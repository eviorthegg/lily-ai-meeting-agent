import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { RowTh, SpanRow, Table, TableScroll, Tbody, Td, Th, Thead } from '@/components/ui/DataTable';
import { ConfirmModal } from '@/components/ui/Modal';
import { Badge, PresenceBadge } from '@/components/ui/Status';
import {
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingRows,
  PageHeader,
  StaleNotice,
} from '@/components/ui/States';
import { api, type TeamMember } from '@/lib/api';
import { useApi, useApiAction } from '@/lib/api/useApi';
import { useAuth } from '@/lib/auth/AuthProvider';
import { ROLE_LABEL } from '@/lib/auth/roles';
import { absoluteTime, relativeTime } from '@/lib/format';
import { useLive } from '@/lib/live/LiveProvider';
import { BulkInviteModal } from './BulkInviteModal';
import { InviteModal } from './InviteModal';

/**
 * The team table.
 *
 * Presence is the only column that is live, and it is deliberately the most
 * conservative thing on the page: the badge comes from the socket when the
 * socket is delivering, and from the last REST response — labelled as
 * historical, with its timestamp — at every other moment. There is no state in
 * which this table shows a green "online" badge it cannot currently vouch for.
 */
export function Team() {
  const { org, user } = useAuth();
  const orgId = org?.id ?? null;
  const { presenceFor, connection } = useLive();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<TeamMember | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(
    () => (orgId === null ? Promise.resolve<TeamMember[]>([]) : api.listTeam(orgId)),
    [orgId],
  );
  const team = useApi(load, [orgId]);
  const removal = useApiAction();

  const members = team.data ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle === ''
        ? members
        : members.filter((member) =>
            [member.name, member.email, member.jobDescription, member.role]
              .join(' ')
              .toLowerCase()
              .includes(needle),
          ),
    [members, needle],
  );

  async function confirmRemoval() {
    const target = pendingRemoval;
    if (target === null || orgId === null) return;
    const done = await removal.run(() => api.removeEmployee(orgId, target.employeeId));
    setPendingRemoval(null);
    if (done !== null || removal.error === null) team.reload();
  }

  const enrolled = members.filter((member) => member.daemonEnrolled).length;
  const onlineNow = members.filter(
    (member) => presenceFor(member.employeeId)?.online === true,
  ).length;

  return (
    <>
      <PageHeader
        eyebrow="team"
        title="Team"
        intro="Everyone Lily can route work to, and whether their machine is currently reachable."
        actions={
          <>
            <Button variant="secondary" onClick={() => setBulkOpen(true)}>
              Bulk invite
            </Button>
            <Button onClick={() => setInviteOpen(true)}>Invite someone</Button>
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-grey">
          <Badge tone="neutral">{members.length} on the team</Badge>
          <Badge tone="neutral">{enrolled} with a daemon</Badge>
          {connection === 'open' ? (
            <Badge tone="positive">{onlineNow} online now</Badge>
          ) : (
            <Badge tone="muted">presence not live</Badge>
          )}
        </div>

        <div className="w-full sm:w-64">
          <label htmlFor="team-filter" className="sr-only">
            Filter the team
          </label>
          <input
            id="team-filter"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name, email or what they do"
            className="h-11 w-full rounded-card border border-hair bg-white px-4 text-[15px] transition-colors placeholder:text-grey focus:border-ink"
          />
        </div>
      </div>

      {team.stale ? <StaleNotice fetchedAt={team.fetchedAt} onRetry={team.reload} /> : null}
      {removal.error !== null ? (
        <p role="alert" className="mb-4 rounded-card border border-[#f3d3d0] bg-[#fdf4f3] px-4 py-3 text-[14px] text-[#b42318]">
          {removal.error.message}
        </p>
      ) : null}

      {team.forbidden ? (
        <ForbiddenState what="the team list" />
      ) : team.loading ? (
        <LoadingRows rows={6} label="Loading the team" />
      ) : team.error !== null && team.data === null ? (
        <ErrorState error={team.error} onRetry={team.reload} what="the team" />
      ) : members.length === 0 ? (
        <EmptyState
          title="Nobody here yet"
          body="Invite the people who will be in meetings with Lily. She routes by what they do, so the description matters more than the job title."
          action={<Button onClick={() => setInviteOpen(true)}>Invite someone</Button>}
        />
      ) : (
        <TableScroll label="Team members">
          <Table
            caption="Team members, their role, what they do, and their daemon status"
            minWidth="64rem"
          >
            <Thead>
              <Th width="17rem">Name</Th>
              <Th width="7rem">Role</Th>
              <Th>What they do</Th>
              <Th width="11rem">Daemon</Th>
              <Th width="9rem">Last seen</Th>
              <Th width="6rem">
                <span className="sr-only">Actions</span>
              </Th>
            </Thead>
            <Tbody>
              {visible.length === 0 ? (
                <SpanRow columns={6}>Nobody matches “{filter}”.</SpanRow>
              ) : (
                visible.map((member) => {
                  const live = presenceFor(member.employeeId);
                  const seenAt = live?.at ?? member.lastSeenAt;
                  const isSelf = member.id === user?.id;
                  return (
                    <tr key={member.id} className="align-top hover:bg-paper">
                      <RowTh>
                        <span className="block">{member.name}</span>
                        <a
                          href={`mailto:${member.email}`}
                          className="mt-0.5 block truncate text-[13px] font-normal text-grey underline-offset-4 hover:underline"
                        >
                          {member.email}
                        </a>
                        {member.status === 'invited' ? (
                          <span className="mt-1.5 inline-block">
                            <Badge tone="warning">Invited, not joined</Badge>
                          </span>
                        ) : null}
                      </RowTh>

                      <Td>
                        <span>{ROLE_LABEL[member.role]}</span>
                        {!member.mfaEnrolled && member.role !== 'employee' ? (
                          <span className="mt-1.5 block">
                            <Badge tone="warning">No 2FA</Badge>
                          </span>
                        ) : null}
                      </Td>

                      <Td className="text-grey">
                        <span className="block max-w-[24rem]">{member.jobDescription || '—'}</span>
                        {member.agentCapabilities.length > 0 ? (
                          <span className="mt-1.5 block text-[12px] text-grey">
                            {member.agentKind ?? 'agent'} ·{' '}
                            {member.agentCapabilities.join(', ')}
                          </span>
                        ) : null}
                      </Td>

                      <Td>
                        <PresenceBadge
                          live={live}
                          fallbackOnline={member.daemonOnline}
                          fallbackAt={member.lastSeenAt}
                          enrolled={member.daemonEnrolled}
                        />
                      </Td>

                      <Td>
                        <span className="text-grey" title={absoluteTime(seenAt)}>
                          {seenAt === null ? 'never' : relativeTime(seenAt)}
                        </span>
                      </Td>

                      <Td align="right">
                        {member.role === 'owner' || isSelf ? (
                          <span className="text-[13px] text-grey">—</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPendingRemoval(member)}
                            className="rounded-pill border border-hair px-3 py-1.5 text-[13px] font-medium transition-colors hover:border-[#e6b5b0] hover:text-[#b42318]"
                          >
                            Remove
                            <span className="sr-only"> {member.name}</span>
                          </button>
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

      {orgId === null ? null : (
        <>
          <InviteModal
            open={inviteOpen}
            orgId={orgId}
            onClose={() => setInviteOpen(false)}
            onInvited={() => team.reload()}
          />
          <BulkInviteModal
            open={bulkOpen}
            orgId={orgId}
            onClose={() => setBulkOpen(false)}
            onDone={() => team.reload()}
          />
        </>
      )}

      <ConfirmModal
        open={pendingRemoval !== null}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={() => void confirmRemoval()}
        title={`Remove ${pendingRemoval?.name ?? ''}?`}
        confirmLabel="Remove"
        busy={removal.busy}
        body={
          <>
            <p>
              Their device token is revoked and their daemon connection is closed within seconds.
              Lily stops routing anything to them immediately.
            </p>
            <p className="mt-3">
              Tasks already assigned to them stay in the record, and so does everything in the audit
              log — that is the point of an audit log.
            </p>
          </>
        }
      />
    </>
  );
}

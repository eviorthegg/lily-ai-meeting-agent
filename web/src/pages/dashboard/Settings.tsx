import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
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
  type OrgSettings,
  type Role,
  type RolePermissionPolicy,
  type UpdateOrgSettingsRequest,
} from '@/lib/api';
import { useApi, useApiAction } from '@/lib/api/useApi';
import { useAuth } from '@/lib/auth/AuthProvider';
import { canEditSettings, ROLE_LABEL } from '@/lib/auth/roles';
import { absoluteTime, relativeTime, seconds } from '@/lib/format';

/**
 * Org settings.
 *
 * Read by managers, written by owners and admins. The form is rendered either
 * way and disabled for a manager rather than hidden, because "you cannot change
 * this" is more useful than a page that silently lacks half its content — and
 * because hiding it would be the only thing standing between a manager and the
 * endpoint, which is not where that decision belongs. The API refuses the write;
 * this just explains it in advance.
 *
 * Every control here is a security or privacy posture, so each one says what it
 * costs as well as what it does. A rotation interval with no explanation of the
 * trade is a number people set to the maximum.
 */

const ROTATION_CHOICES: readonly number[] = [3_600, 6 * 3_600, 12 * 3_600, 24 * 3_600, 7 * 24 * 3_600];
const RETENTION_CHOICES: readonly number[] = [7, 30, 90, 180, 365];

export function Settings() {
  const { org, user } = useAuth();
  const orgId = org?.id ?? null;
  const editable = user !== null && canEditSettings(user.role);

  const load = useCallback(
    () =>
      orgId === null
        ? Promise.reject(new Error('No organization'))
        : api.getOrgSettings(orgId),
    [orgId],
  );
  const settings = useApi<OrgSettings>(load, [orgId]);
  const save = useApiAction();
  const consent = useApiAction();

  const [draft, setDraft] = useState<UpdateOrgSettingsRequest | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data === null) return;
    setDraft({
      listeningMode: settings.data.listeningMode,
      deviceTokenRotationSec: settings.data.deviceTokenRotationSec,
      permissionPolicyByRole: settings.data.permissionPolicyByRole.map((policy) => ({ ...policy })),
      taskVisibility: settings.data.taskVisibility,
      retentionDays: settings.data.retentionDays,
    });
  }, [settings.data]);

  if (settings.forbidden) return <ForbiddenState what="this organization's settings" />;
  if (settings.loading || draft === null) return <LoadingRows rows={7} label="Loading settings" />;
  if (settings.error !== null && settings.data === null) {
    return <ErrorState error={settings.error} onRetry={settings.reload} what="settings" />;
  }
  if (settings.data === null) return null;

  const current = settings.data;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (orgId === null || draft === null) return;
    setSaved(false);
    const result = await save.run(() => api.updateOrgSettings(orgId, draft));
    if (result !== null) {
      setSaved(true);
      settings.reload();
    }
  }

  function setPolicy(role: Role, gatedAllowed: boolean) {
    setDraft((value) =>
      value === null
        ? value
        : {
            ...value,
            permissionPolicyByRole: value.permissionPolicyByRole.map((policy) =>
              policy.role === role ? { ...policy, gatedAllowed } : policy,
            ),
          },
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="settings"
        title="Settings"
        intro={
          editable
            ? 'Security and privacy posture for the whole organization.'
            : 'Security and privacy posture for the whole organization. Managers can read these; an owner or admin makes changes.'
        }
      />

      {settings.stale ? <StaleNotice fetchedAt={settings.fetchedAt} onRetry={settings.reload} /> : null}

      {save.error !== null ? (
        <p role="alert" className="mb-5 rounded-card border border-[#f3d3d0] bg-[#fdf4f3] px-4 py-3 text-[14px] text-[#b42318]">
          {save.error.message}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="mb-5 rounded-card border border-[#c9edd9] bg-[#eefaf3] px-4 py-3 text-[14px] text-green-deep">
          Saved. The change is in the audit log.
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <fieldset disabled={!editable} className="flex flex-col gap-6 border-0 p-0">
          <Panel>
            <h2 className="text-[17px] font-medium tracking-headline">Device tokens</h2>
            <p className="mt-2 max-w-measure text-[14px] leading-relaxed text-grey">
              Each daemon holds a token that is rotated on this interval and on every reconnect.
              Shorter means a stolen token is useful for less time; it does not mean more prompts
              for anyone, because rotation is invisible to the employee.
            </p>
            <div className="mt-5 max-w-xs">
              <label htmlFor="rotation" className="text-[13px] font-medium">
                Rotate every
              </label>
              <select
                id="rotation"
                value={draft.deviceTokenRotationSec}
                onChange={(event) =>
                  setDraft({ ...draft, deviceTokenRotationSec: Number(event.target.value) })
                }
                className="mt-1.5 h-11 w-full rounded-card border border-hair bg-white px-3 text-[15px] focus:border-ink disabled:bg-paper disabled:text-grey"
              >
                {ROTATION_CHOICES.map((value) => (
                  <option key={value} value={value}>
                    {seconds(value)}
                  </option>
                ))}
              </select>
            </div>
          </Panel>

          <Panel>
            <h2 className="text-[17px] font-medium tracking-headline">Permission policy by role</h2>
            <p className="mt-2 max-w-measure text-[14px] leading-relaxed text-grey">
              Gated actions — writing a file, running a shell command, installing a package,
              reaching the network — always need spoken approval from the person whose agent it is.
              Turning a role off here means those actions are not offered at all for that role, and
              Lily will not voice them as available.
            </p>
            <p className="mt-2 max-w-measure text-[14px] leading-relaxed text-grey">
              Reads and searches are always allowed. Deletes, deploys, pushes to protected branches
              and credential access are always blocked, for every role, and cannot be enabled here.
            </p>

            <ul className="mt-5 flex flex-col gap-2">
              {draft.permissionPolicyByRole.map((policy: RolePermissionPolicy) => (
                <li
                  key={policy.role}
                  className="flex items-center justify-between gap-4 rounded-card border border-hair px-4 py-3"
                >
                  <span className="text-[15px]">{ROLE_LABEL[policy.role]}</span>
                  <label className="flex items-center gap-2.5 text-[14px] text-grey">
                    <input
                      type="checkbox"
                      checked={policy.gatedAllowed}
                      onChange={(event) => setPolicy(policy.role, event.target.checked)}
                      className="h-4 w-4 accent-[color:var(--ink)]"
                    />
                    May be asked for gated actions
                  </label>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel>
            <h2 className="text-[17px] font-medium tracking-headline">Retention</h2>
            <p className="mt-2 max-w-measure text-[14px] leading-relaxed text-grey">
              How long meeting summaries and task text are kept. They are the only derived content
              this system stores — there is no recording, transcript or agent output to retain. Audit
              entries are excluded from this sweep by design: they are the record of who authorised
              what.
            </p>
            <div className="mt-5 max-w-xs">
              <label htmlFor="retention" className="text-[13px] font-medium">
                Keep for
              </label>
              <select
                id="retention"
                value={draft.retentionDays}
                onChange={(event) => setDraft({ ...draft, retentionDays: Number(event.target.value) })}
                className="mt-1.5 h-11 w-full rounded-card border border-hair bg-white px-3 text-[15px] focus:border-ink disabled:bg-paper disabled:text-grey"
              >
                {RETENTION_CHOICES.map((value) => (
                  <option key={value} value={value}>
                    {value} days
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-6 border-t border-hair pt-5">
              <h3 className="text-[14px] font-medium">Who can read task text</h3>
              <div className="mt-3 flex flex-col gap-2">
                {(
                  [
                    ['owner_and_managers', 'The owning employee and managers only'],
                    ['org', 'Anyone in the organization'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="flex items-center gap-2.5 text-[15px]">
                    <input
                      type="radio"
                      name="taskVisibility"
                      value={value}
                      checked={draft.taskVisibility === value}
                      onChange={() => setDraft({ ...draft, taskVisibility: value })}
                      className="h-4 w-4 accent-[color:var(--ink)]"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </Panel>

          <Panel>
            <h2 className="text-[17px] font-medium tracking-headline">Listening</h2>
            <p className="mt-2 max-w-measure text-[14px] leading-relaxed text-grey">
              Whether Lily responds to everything said in the room, or only when she is addressed by
              name.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              {(
                [
                  ['name_only', 'Only when someone says her name'],
                  ['always', 'Always listening while she is in the meeting'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2.5 text-[15px]">
                  <input
                    type="radio"
                    name="listeningMode"
                    value={value}
                    checked={draft.listeningMode === value}
                    onChange={() => setDraft({ ...draft, listeningMode: value })}
                    className="h-4 w-4 accent-[color:var(--ink)]"
                  />
                  {label}
                </label>
              ))}
            </div>
          </Panel>
        </fieldset>

        {editable ? (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.busy}>
              {save.busy ? 'Saving…' : 'Save changes'}
            </Button>
            <span className="text-[13px] text-grey">Changes are written to the audit log.</span>
          </div>
        ) : (
          <p className="rounded-card border border-hair bg-paper px-4 py-3 text-[14px] text-grey">
            You are signed in as a manager. An owner or admin can change these.
          </p>
        )}
      </form>

      <ConsentNoticePanel
        settings={current}
        canAcknowledge={user !== null}
        busy={consent.busy}
        onAcknowledge={async () => {
          if (orgId === null) return;
          const result = await consent.run(() => api.acknowledgeConsentNotice(orgId));
          if (result !== null) settings.reload();
        }}
      />

      <Panel className="mt-6">
        <h2 className="text-[17px] font-medium tracking-headline">Connected platforms</h2>
        <p className="mt-2 max-w-measure text-[14px] leading-relaxed text-grey">
          Where Lily can be sent to join. A join link is a credential — it is exchanged for a signed
          single-use payload and never stored.
        </p>
        <ul className="mt-5 flex flex-col gap-2">
          {current.connectedPlatforms.map((platform) => (
            <li
              key={platform.platform}
              className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-hair px-4 py-3"
            >
              <span className="text-[15px]">{platform.label}</span>
              <span className="flex items-center gap-3">
                {platform.connected ? (
                  <>
                    <Badge tone="positive">Connected</Badge>
                    <span className="text-[13px] text-grey" title={absoluteTime(platform.connectedAt)}>
                      {platform.connectedAt === null
                        ? ''
                        : `since ${relativeTime(platform.connectedAt)}`}
                    </span>
                  </>
                ) : (
                  <Badge tone="muted">Not connected</Badge>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function ConsentNoticePanel({
  settings,
  canAcknowledge,
  busy,
  onAcknowledge,
}: {
  settings: OrgSettings;
  canAcknowledge: boolean;
  busy: boolean;
  onAcknowledge: () => void | Promise<void>;
}) {
  const { consentNotice } = settings;
  const outstanding = consentNotice.acknowledgedAt === null;

  return (
    <Panel className="mt-6">
      <h2 className="text-[17px] font-medium tracking-headline">Meeting consent notice</h2>
      <p className="mt-2 max-w-measure text-[14px] leading-relaxed text-grey">
        Jurisdictions differ on whether an AI participant has to be disclosed, and on what counts as
        recording. Lily always joins named “Lily (AI assistant)” so nobody in the room is in any
        doubt — but the responsibility for telling attendees sits with the organization, and the
        acknowledgement is logged against a person.
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-card border border-hair px-4 py-3">
        <div>
          <p className="text-[14px]">
            Policy version <span className="data">{consentNotice.policyVersion}</span>
          </p>
          <p className="mt-1 text-[13px] text-grey">
            {outstanding ? (
              'Not acknowledged for this version.'
            ) : (
              <span title={absoluteTime(consentNotice.acknowledgedAt)}>
                Acknowledged by {consentNotice.acknowledgedByName ?? 'someone'}{' '}
                {relativeTime(consentNotice.acknowledgedAt)}
              </span>
            )}
          </p>
        </div>
        {outstanding && canAcknowledge ? (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void onAcknowledge()}>
            {busy ? 'Recording…' : 'Acknowledge'}
          </Button>
        ) : (
          <Badge tone={outstanding ? 'warning' : 'positive'}>
            {outstanding ? 'Outstanding' : 'On file'}
          </Badge>
        )}
      </div>
    </Panel>
  );
}

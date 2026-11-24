import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout } from '@/components/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Field, FormError, SelectField } from '@/components/ui/Field';
import { track } from '@/lib/analytics';
import { api, ApiError, type Invite, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth/AuthProvider';
import { cn } from '@/lib/cn';

/**
 * Three things stand between a new org and a working meeting. The checklist is
 * ordered by dependency, not by ease: without a daemon there is nothing to
 * dispatch to, so the meeting step comes last and says so.
 */

const INSTALL_COMMAND = 'npx @lily/daemon install';

type StepId = 'invite' | 'daemon' | 'meeting';

export function Onboarding() {
  const { org } = useAuth();
  const [openStep, setOpenStep] = useState<StepId>('invite');
  const [invites, setInvites] = useState<Invite[]>([]);
  const [daemonInstalled, setDaemonInstalled] = useState(false);
  const [copied, setCopied] = useState(false);

  const done: Record<StepId, boolean> = {
    invite: invites.length > 0,
    daemon: daemonInstalled,
    meeting: false,
  };

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission can be refused; the command is visible either way.
    }
  }

  return (
    <AuthLayout
      eyebrow="step 3 of 3"
      title={org === null ? 'Get set up' : `Get ${org.name} set up`}
      intro="Three things, then Lily can join a call."
      aside={
        <div className="card p-7">
          <p className="eyebrow">a reminder</p>
          <p className="mt-4 text-[15px] leading-relaxed text-grey">
            The daemon runs on each person&apos;s own machine and connects out to us. It never
            accepts an inbound connection, and nothing it can reach is uploaded.
          </p>
        </div>
      }
    >
      <ol className="flex max-w-xl flex-col gap-3">
        <StepShell
          index={1}
          id="invite"
          title="Invite your team"
          summary="Lily routes by what people do, so tell her."
          open={openStep === 'invite'}
          done={done['invite']}
          onOpen={setOpenStep}
        >
          <InviteForm
            orgId={org?.id ?? null}
            onInvited={(invite) => setInvites((current) => [...current, invite])}
          />
          {invites.length > 0 ? (
            <ul className="mt-6 border-t border-hair">
              {invites.map((invite) => (
                <li
                  key={invite.id}
                  className="flex items-center justify-between gap-4 border-b border-hair py-3 text-[15px]"
                >
                  <span>{invite.name}</span>
                  <span className="data text-grey">{invite.role} · invited</span>
                </li>
              ))}
            </ul>
          ) : null}
        </StepShell>

        <StepShell
          index={2}
          id="daemon"
          title="Install the daemon"
          summary="One command, on each person's own machine."
          open={openStep === 'daemon'}
          done={done['daemon']}
          onOpen={setOpenStep}
        >
          <p className="max-w-measure text-[15px] leading-relaxed text-grey">
            Everyone runs this themselves. It finds the coding agent they already use, registers
            what it can reach, and connects. Enrolling is their choice — you cannot do it for them.
          </p>

          <div className="mt-5 flex items-center justify-between gap-4 rounded-card border border-hair bg-ink px-4 py-3.5">
            <code className="data overflow-x-auto text-neon">{INSTALL_COMMAND}</code>
            <button
              type="button"
              onClick={copyCommand}
              className="data shrink-0 rounded-pill border border-[rgba(255,255,255,.22)] px-3 py-1.5 text-white transition-colors hover:border-neon"
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </div>

          <Button
            type="button"
            variant="secondary"
            className="mt-5"
            onClick={() => {
              setDaemonInstalled(true);
              track('daemon_installed', {});
              setOpenStep('meeting');
            }}
          >
            I have installed it
          </Button>
        </StepShell>

        <StepShell
          index={3}
          id="meeting"
          title="Start your first meeting"
          summary="Paste a join link and she turns up as a participant."
          open={openStep === 'meeting'}
          done={done['meeting']}
          onOpen={setOpenStep}
        >
          <p className="max-w-measure text-[15px] leading-relaxed text-grey">
            Lily joins named &ldquo;Lily (AI assistant)&rdquo; so nobody in the room is in any doubt.
            She will not dispatch to anyone who has not enrolled a daemon.
          </p>
          <Button
            type="button"
            className="mt-5"
            disabled={!done['daemon']}
            onClick={() => track('meeting_started', { platform: 'zoom' })}
          >
            Start a meeting
          </Button>
          {!done['daemon'] ? (
            <p className="mt-3 text-[14px] text-grey">
              Install the daemon first — there is nothing for her to dispatch to yet.
            </p>
          ) : null}
        </StepShell>
      </ol>

      <p className="mt-8 text-[14px] text-grey">
        <Link to="/" className="text-green-deep underline underline-offset-4">
          Back to the homepage
        </Link>
      </p>
    </AuthLayout>
  );
}

function StepShell({
  index,
  id,
  title,
  summary,
  open,
  done,
  onOpen,
  children,
}: {
  index: number;
  id: StepId;
  title: string;
  summary: string;
  open: boolean;
  done: boolean;
  onOpen: (id: StepId) => void;
  children: ReactNode;
}) {
  const panelId = `step-panel-${id}`;
  const buttonId = `step-button-${id}`;

  return (
    <li className="card overflow-hidden">
      <button
        id={buttonId}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpen(id)}
        className="flex w-full items-start gap-4 p-6 text-left"
      >
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[12px] font-medium',
            done ? 'border-ink bg-ink text-white' : 'border-hair text-grey',
          )}
        >
          {done ? '✓' : index}
        </span>
        <span>
          <span className="block text-[17px] font-medium tracking-headline">{title}</span>
          <span className="mt-1 block text-[14px] text-grey">{summary}</span>
        </span>
        {done ? <span className="sr-only">Completed</span> : null}
      </button>
      {open ? (
        <div id={panelId} role="region" aria-labelledby={buttonId} className="border-t border-hair p-6">
          {children}
        </div>
      ) : null}
    </li>
  );
}

const ROLES: readonly Role[] = ['employee', 'manager', 'admin'];

function InviteForm({
  orgId,
  onInvited,
}: {
  orgId: string | null;
  onInvited: (invite: Invite) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('employee');
  const [jobDescription, setJobDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (orgId === null) {
      setFormError('Create your organization first.');
      return;
    }
    setBusy(true);
    try {
      const invite = await api.invite(orgId, { email, name, role, jobDescription });
      onInvited(invite);
      // Role is an enum and safe to send. The name, email and job description
      // are not, and are not sent — see lib/analytics/events.ts.
      track('invite_sent', { org_id: orgId, role });
      setName('');
      setEmail('');
      setJobDescription('');
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Could not send that invite.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <FormError message={formError} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Field
          label="Email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <SelectField
        label="Role"
        value={role}
        onChange={(event) => setRole(event.target.value as Role)}
      >
        {ROLES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </SelectField>
      <Field
        label="What they do here"
        required
        value={jobDescription}
        onChange={(event) => setJobDescription(event.target.value)}
        hint="Plain words. This is how Lily decides a question is theirs — “owns billing and the payments service”."
      />
      <Button type="submit" disabled={busy} className="self-start">
        {busy ? 'Sending…' : 'Send invite'}
      </Button>
    </form>
  );
}

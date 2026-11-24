import { useId, useState, type FormEvent } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, FormError, SelectField } from '@/components/ui/Field';
import { track } from '@/lib/analytics';
import { api, type Invite, type Role } from '@/lib/api';
import { useApiAction } from '@/lib/api/useApi';
import { ASSIGNABLE_ROLES, ROLE_LABEL } from '@/lib/auth/roles';

/**
 * Invite one person.
 *
 * The interesting field is the last one. "What they do here" is not a profile
 * nicety — it is the routing context Lily reads to decide that a question about
 * the payment provider belongs to Noa without anyone having said so in the
 * meeting. A plain textarea labelled "job description" gets filled with a title
 * ("Senior Engineer"), which routes nothing.
 *
 * So the field states what it is for, shows examples of the shape that works,
 * and says out loud where the text ends up. Nothing else in this modal needs
 * explaining; this does.
 */

const EXAMPLES: readonly string[] = [
  'Owns billing and the payments service',
  'Runs the deploy pipeline and on-call',
  'Knows every open customer issue and who reported it',
];

export function InviteModal({
  open,
  orgId,
  onClose,
  onInvited,
}: {
  open: boolean;
  orgId: string;
  onClose: () => void;
  onInvited: (invite: Invite) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('employee');
  const [jobDescription, setJobDescription] = useState('');
  const { busy, error, run, clearError } = useApiAction();
  const jobId = useId();
  const jobHintId = `${jobId}-hint`;

  function reset() {
    setName('');
    setEmail('');
    setRole('employee');
    setJobDescription('');
    clearError();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invite = await run(() => api.invite(orgId, { email, name, role, jobDescription }));
    if (invite === null) return;
    // Role is an enum and safe to send. Name, email and the job description are
    // not, and are not sent — see lib/analytics/events.ts.
    track('invite_sent', { org_id: orgId, role });
    onInvited(invite);
    reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Invite someone"
      description="They get an email with a single-use install link. Enrolling a daemon is their choice — you cannot do it for them."
      size="lg"
    >
      <form id="invite-form" onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        <FormError message={error === null ? null : error.message} />

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Name"
            required
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            {...(error?.fields['name'] === undefined ? {} : { error: error.fields['name'] })}
          />
          <Field
            label="Work email"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            {...(error?.fields['email'] === undefined ? {} : { error: error.fields['email'] })}
          />
        </div>

        <SelectField
          label="Role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          hint="Managers and admins must enrol two-factor before they can open this dashboard."
        >
          {ASSIGNABLE_ROLES.map((option) => (
            <option key={option} value={option}>
              {ROLE_LABEL[option]}
            </option>
          ))}
        </SelectField>

        <div className="rounded-card border border-hair bg-paper p-5">
          <label htmlFor={jobId} className="text-[14px] font-medium">
            What they do at the company
          </label>
          <p id={jobHintId} className="mt-1.5 text-[13px] leading-relaxed text-grey">
            This is the one field Lily reads to route work. When someone asks a question in a
            meeting, she matches it against these descriptions to decide whose agent to ask. Write
            what they own, in plain words — a job title routes nothing.
          </p>

          <textarea
            id={jobId}
            required
            rows={3}
            value={jobDescription}
            onChange={(event) => setJobDescription(event.target.value)}
            aria-describedby={jobHintId}
            maxLength={280}
            className="mt-3 w-full rounded-card border border-hair bg-white px-4 py-3 text-[16px] transition-colors placeholder:text-grey focus:border-ink"
            placeholder="Owns billing and the payments service"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-grey">Try:</span>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setJobDescription(example)}
                className="rounded-pill border border-hair bg-white px-3 py-1 text-[12px] text-grey transition-colors hover:border-[#dfe2e6] hover:text-ink"
              >
                {example}
              </button>
            ))}
          </div>

          <p className="mt-3 text-[12px] text-grey">
            {jobDescription.length}/280 · stored on their user record, never sent to analytics.
          </p>
        </div>
      </form>

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={() => {
            reset();
            onClose();
          }}
          className="h-12 rounded-pill border border-hair px-5 text-[15px] font-medium transition-colors hover:border-[#dfe2e6]"
        >
          Cancel
        </button>
        <Button type="submit" form="invite-form" disabled={busy}>
          {busy ? 'Sending…' : 'Send invite'}
        </Button>
      </div>
    </Modal>
  );
}

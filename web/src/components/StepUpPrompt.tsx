import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Field, FormError } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { api, ApiError } from '@/lib/api';
import { setStepUpResolver } from '@/lib/api/http';

/**
 * The second factor, asked for at the moment it is needed.
 *
 * Mounted once, at the root, and driven by the transport rather than by any
 * screen. When the API refuses an administrative action with `step_up_required`,
 * `lib/api/http.ts` calls the resolver this component registers, waits for the
 * user to answer, and then retries the original request. The button the user
 * pressed simply takes a moment longer and then works.
 *
 * Doing it here rather than per screen is the whole point. The grace window
 * lapses on a timer, not on a navigation, so *any* administrative action can be
 * refused at *any* moment — including one that succeeded thirty seconds ago. A
 * per-screen implementation would mean each new administrative control is one
 * someone can forget to wire, and the symptom would be a button that silently
 * does nothing.
 *
 * Two answers are accepted, matching the API: a six-digit code from the
 * authenticator, or one single-use backup code for the person whose phone is
 * dead. A user who has not enrolled at all is sent to enrolment instead, because
 * there is no code they could type that would work.
 */

/** Human labels for the `action` the API names in `ApiError.fields`. */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  'employee.add': 'add someone to the team',
  'employee.remove': 'remove someone from the team',
  'token.rotate': 'rotate a device token',
  'policy.change': 'change the organisation policy',
  'billing.change': 'change billing',
  'audit.export': 'export the audit log',
  'install_token.issue': 'issue an install token',
};

interface Pending {
  readonly action: string | null;
  readonly settle: (satisfied: boolean) => void;
}

export function StepUpPrompt() {
  const navigate = useNavigate();
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the effect that registers the resolver runs exactly once.
  // Re-registering on every render would leak resolvers mid-request.
  const settleRef = useRef<((satisfied: boolean) => void) | null>(null);

  useEffect(() => {
    setStepUpResolver(
      (action) =>
        new Promise<boolean>((resolve) => {
          setCode('');
          setError(null);
          settleRef.current = resolve;
          setPending({ action, settle: resolve });
        }),
    );

    return () => {
      setStepUpResolver(null);
      // A pending request must not hang forever if this unmounts mid-prompt.
      settleRef.current?.(false);
      settleRef.current = null;
    };
  }, []);

  const close = useCallback((satisfied: boolean) => {
    settleRef.current?.(satisfied);
    settleRef.current = null;
    setPending(null);
    setCode('');
    setBusy(false);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.verifyStepUp(code);
      close(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'mfa_enrollment_required') {
        // Nothing they can type here would work. Send them to the one screen
        // that can fix it, and let the original request fail so the caller
        // reports it rather than appearing to hang.
        close(false);
        navigate('/mfa');
        return;
      }
      setError(
        caught instanceof ApiError ? caught.message : 'Could not check that code. Try again.',
      );
      setBusy(false);
    }
  }

  if (pending === null) return null;

  const label = pending.action === null ? null : ACTION_LABEL[pending.action];

  return (
    <Modal
      open
      onClose={() => close(false)}
      title="Confirm it is you"
      description={
        label === undefined || label === null
          ? 'This action needs a second factor.'
          : `Before you ${label}, confirm your identity.`
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        <FormError message={error} />

        <Field
          label="Code"
          inputMode="text"
          autoComplete="one-time-code"
          autoFocus
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
          hint="Six digits from your authenticator, or one of your backup codes."
        />

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy || code.trim().length < 6}>
            {busy ? 'Checking…' : 'Confirm'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
        </div>

        <p className="text-[14px] leading-relaxed text-grey">
          Holding a signed-in session is enough to use Lily. It is not enough to change who can use
          it — so this is asked again every few minutes for administrative actions.
        </p>
      </form>
    </Modal>
  );
}

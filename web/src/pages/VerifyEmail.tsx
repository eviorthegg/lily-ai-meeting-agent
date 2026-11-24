import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '@/components/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Field, FormError } from '@/components/ui/Field';
import { api, ApiError, isMockApi } from '@/lib/api';
import { VERIFICATION_CODE } from '@/lib/api/mock';
import { useAuth } from '@/lib/auth/AuthProvider';

export function VerifyEmail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { adopt } = useAuth();
  const email = params.get('email') ?? '';

  const [code, setCode] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFields({});
    setBusy(true);
    try {
      const session = await api.verifyEmail({ email, code });
      adopt(session);
      navigate('/create-org');
    } catch (error) {
      if (error instanceof ApiError) {
        setFields(error.fields);
        setFormError(Object.keys(error.fields).length > 0 ? null : error.message);
      } else {
        setFormError('Something went wrong. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setNotice(null);
    try {
      await api.resendVerification(email);
      setNotice('Sent. Check your inbox.');
    } catch {
      setFormError('Could not resend. Try again in a moment.');
    }
  }

  return (
    <AuthLayout
      eyebrow="step 1 of 3"
      title="Check your email"
      intro={
        email === ''
          ? 'Enter the six-digit code we sent you.'
          : `We sent a six-digit code to ${email}.`
      }
    >
      <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-5" noValidate>
        <FormError message={formError} />
        {notice !== null ? (
          <p role="status" className="text-[14px] text-green-deep">
            {notice}
          </p>
        ) : null}

        <Field
          label="Verification code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className="font-mono tracking-[.3em]"
          {...(fields['code'] === undefined ? {} : { error: fields['code'] })}
        />

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Verifying…' : 'Verify email'}
        </Button>

        <button
          type="button"
          onClick={onResend}
          className="self-start text-[14px] text-grey underline underline-offset-4 transition-colors hover:text-ink"
        >
          Resend the code
        </button>

        {isMockApi ? (
          <p className="data rounded-card border border-hair bg-paper p-4 text-grey">
            demo mode · the code is {VERIFICATION_CODE}
          </p>
        ) : null}
      </form>
    </AuthLayout>
  );
}

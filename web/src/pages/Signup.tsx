import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '@/components/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Field, FormError } from '@/components/ui/Field';
import { googleClientId } from '@/config/env';
import { track } from '@/lib/analytics';
import { api, ApiError, isMockApi } from '@/lib/api';
import { getAttribution } from '@/lib/attribution/utm';

const MIN_PASSWORD = 12;

export function Signup() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fires once when the form is first seen, not on submit — the funnel needs the
  // denominator, and every subsequent event is measured against it.
  useEffect(() => {
    track('signup_started', { method: 'password' });
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFields({});

    if (password.length < MIN_PASSWORD) {
      setFields({ password: `Use at least ${MIN_PASSWORD} characters.` });
      return;
    }

    setBusy(true);
    try {
      const result = await api.signup({
        email,
        password,
        name,
        provider: 'password',
        googleAuthCode: null,
        // First touch may be weeks older than this submit — that is the point.
        attribution: getAttribution(),
      });

      track('signup_completed', { method: 'password', user_id: result.user.id });

      if (result.verificationRequired) {
        navigate(`/verify-email?email=${encodeURIComponent(email)}`);
        return;
      }
      navigate('/create-org');
    } catch (error) {
      if (error instanceof ApiError) {
        setFields(error.fields);
        // A field-level message is already displayed inline; repeating it at the
        // top of the form is noise.
        setFormError(Object.keys(error.fields).length > 0 ? null : error.message);
      } else {
        setFormError('Something went wrong. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  function onGoogle() {
    // The OAuth redirect belongs to the API, which owns the client secret and
    // the state parameter. The button is here; the flow is not.
    if (googleClientId === null) {
      setFormError('Google sign-in is not configured for this environment.');
      return;
    }
    track('signup_started', { method: 'google' });
    window.location.assign('/auth/google/start');
  }

  return (
    <AuthLayout
      eyebrow="step 1 of 3"
      title="Create your account"
      intro="Test costs nothing and needs no card. Every feature is unlocked, so what you evaluate is the real thing."
      aside={
        <div className="card p-7">
          <p className="eyebrow">what happens next</p>
          <ol className="mt-5 flex flex-col">
            {['Verify your email', 'Name your company', 'Invite your team and install the daemon'].map(
              (item, index) => (
                <li
                  key={item}
                  className={[
                    'flex items-start gap-4 py-3.5 text-[15px]',
                    index > 0 ? 'border-t border-hair' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className="data mt-0.5 text-grey">0{index + 1}</span>
                  {item}
                </li>
              ),
            )}
          </ol>
        </div>
      }
    >
      <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-5" noValidate>
        <FormError message={formError} />

        <Field
          label="Your name"
          name="name"
          autoComplete="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          {...(fields['name'] === undefined ? {} : { error: fields['name'] })}
        />
        <Field
          label="Work email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          {...(fields['email'] === undefined ? {} : { error: fields['email'] })}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint={`At least ${MIN_PASSWORD} characters. A passphrase beats a short complicated one.`}
          {...(fields['password'] === undefined ? {} : { error: fields['password'] })}
        />

        <Button type="submit" disabled={busy} className="mt-1 w-full">
          {busy ? 'Creating account…' : 'Create account'}
        </Button>

        <div className="flex items-center gap-4 py-1">
          <span className="h-px flex-1 bg-hair" />
          <span className="data text-grey">or</span>
          <span className="h-px flex-1 bg-hair" />
        </div>

        <Button type="button" variant="secondary" onClick={onGoogle} className="w-full">
          Continue with Google
        </Button>

        <p className="text-[14px] text-grey">
          Already have an account?{' '}
          <Link to="/login" className="text-green-deep underline underline-offset-4">
            Log in
          </Link>
        </p>

        {isMockApi ? (
          <p className="data rounded-card border border-hair bg-paper p-4 text-grey">
            demo mode · no API is running, signup is served from an in-memory fixture
          </p>
        ) : null}
      </form>
    </AuthLayout>
  );
}

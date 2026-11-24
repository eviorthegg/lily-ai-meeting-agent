import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from '@/components/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Field, FormError } from '@/components/ui/Field';
import { api, ApiError, isMockApi, type AuthSession } from '@/lib/api';
import { useAuth } from '@/lib/auth/AuthProvider';
import { canSeeDashboard } from '@/lib/auth/roles';

/**
 * Where a successful login lands.
 *
 * No org means signup was never finished. A role with a dashboard goes to the
 * dashboard, which then decides for itself whether MFA enrollment stands in the
 * way. Everyone else goes to onboarding, which is the screen that is actually
 * useful to them.
 */
function destinationFor(session: AuthSession): string {
  if (session.org === null) return '/create-org';
  return canSeeDashboard(session.user.role) ? '/app' : '/onboarding';
}

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { adopt } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const session = await api.login({ email, password });
      adopt(session);

      // Honour where the gate bounced them from, but only for in-app paths —
      // an attacker-supplied absolute URL in router state must not become a
      // redirect target.
      const from =
        typeof location.state === 'object' && location.state !== null && 'from' in location.state
          ? String((location.state as { from: unknown }).from)
          : null;
      const safeFrom = from !== null && from.startsWith('/app') ? from : null;

      navigate(safeFrom ?? destinationFor(session));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'email_not_verified') {
        navigate(`/verify-email?email=${encodeURIComponent(email)}`);
        return;
      }
      // One message for both "no such account" and "wrong password". Splitting
      // them turns this form into an account enumerator.
      setFormError(
        error instanceof ApiError ? error.message : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout eyebrow="welcome back" title="Log in">
      <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-5" noValidate>
        <FormError message={formError} />

        <Field
          label="Work email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <Button type="submit" disabled={busy} className="mt-1 w-full">
          {busy ? 'Logging in…' : 'Log in'}
        </Button>

        <p className="text-[14px] text-grey">
          No account yet?{' '}
          <Link to="/signup" className="text-green-deep underline underline-offset-4">
            Start testing
          </Link>
        </p>

        {isMockApi ? (
          <div className="rounded-card border border-dashed border-hair bg-paper p-4 text-[13px] leading-relaxed text-grey">
            <p className="font-medium text-ink">Demo mode — there is no API yet</p>
            <p className="mt-2">
              Sign in as <span className="data">maya@northwind.test</span> (owner, sees analytics),{' '}
              <span className="data">ari@northwind.test</span> (manager, does not), or{' '}
              <span className="data">noa@northwind.test</span> (employee, has no dashboard). The
              password for all three is <span className="data">lily-demo-password</span>.
            </p>
          </div>
        ) : null}
      </form>
    </AuthLayout>
  );
}

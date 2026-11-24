import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth/AuthProvider';
import { canSeeDashboard, mfaRequiredFor, ROLE_LABEL } from '@/lib/auth/roles';
import { LiveProvider } from '@/lib/live/LiveProvider';

/**
 * What has to be true before any dashboard screen renders.
 *
 * In order, because the order is the product decision:
 *
 *  1. **A session.** No session, no app — back to login, remembering where the
 *     user was trying to go.
 *  2. **An org.** A verified user with no org has not finished signing up.
 *  3. **A role that has a dashboard.** An employee is a legitimate user of this
 *     product who has no business in the manager view. They get told that, in
 *     words, rather than being bounced to a login screen they just came from.
 *  4. **MFA, for privileged roles.** This is a gate, not a nudge: there is no
 *     "remind me later" and no reduced dashboard behind it.
 *
 * None of these four is a security control. Every one of them is a routing
 * decision made from data the browser holds, and the browser can be lied to.
 * The API enforces all four on every request; this exists so that a user who is
 * not entitled to something sees a sentence explaining it instead of a screen
 * full of failed requests.
 */
export function DashboardGate() {
  const { user, org, isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated || user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (org === null) {
    return <Navigate to="/create-org" replace />;
  }

  if (!canSeeDashboard(user.role)) {
    return <NoDashboardAccess role={ROLE_LABEL[user.role]} />;
  }

  if (mfaRequiredFor(user.role) && !user.mfaEnrolled) {
    return <Navigate to="/mfa" replace state={{ from: location.pathname }} />;
  }

  // The live socket only opens inside the gate. There is nothing for a
  // half-authenticated page to subscribe to.
  return (
    <LiveProvider>
      <Outlet />
    </LiveProvider>
  );
}

function NoDashboardAccess({ role }: { role: string }) {
  const { user, signOut } = useAuth();

  return (
    <main id="main" className="shell flex min-h-screen items-center py-20">
      <div className="card mx-auto max-w-lg p-8">
        <p className="eyebrow">no access</p>
        <h1 className="mt-4 text-[26px] font-semibold tracking-headline">
          This is the manager dashboard
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-grey">
          {user === null ? 'This account' : user.name} is signed in as{' '}
          <strong className="font-medium text-ink">{role}</strong>, and the dashboard is for owners,
          admins and managers. Nothing is wrong with the account — Lily still routes work to you in
          meetings exactly as before.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-grey">
          If you should have access, ask an owner or admin to change your role.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link
            to="/"
            className="inline-flex h-11 items-center rounded-pill bg-ink px-5 text-[15px] font-medium text-white"
          >
            Back to the site
          </Link>
          <button
            type="button"
            onClick={signOut}
            className="h-11 rounded-pill border border-hair px-5 text-[15px] font-medium"
          >
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}

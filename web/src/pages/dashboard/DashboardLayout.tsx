import { NavLink, Outlet, Link } from 'react-router-dom';
import { isMockApi } from '@/lib/api';
import { useAuth } from '@/lib/auth/AuthProvider';
import { isOwner, ROLE_LABEL } from '@/lib/auth/roles';
import { cn } from '@/lib/cn';
import { LiveStatus } from './LiveStatus';

/**
 * Dashboard chrome.
 *
 * Landmarks are real: one `<header role=banner>`, one `<nav>` with a name, one
 * `<main>`. The nav is a list of links, not buttons wired to a router, so
 * middle-click and copy-link work and a screen reader announces how many there
 * are.
 *
 * Layout is a two-column grid above `md` and a horizontally-scrolling tab strip
 * below it. The content column carries `min-w-0`, which is what actually stops a
 * wide table from pushing the page sideways — a grid child defaults to
 * `min-width: auto` and will happily overflow its track without it.
 */

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  ownerOnly?: boolean;
}

const ITEMS: readonly NavItem[] = [
  { to: '/app', label: 'Team', end: true },
  { to: '/app/meetings', label: 'Meetings' },
  { to: '/app/tasks', label: 'Tasks' },
  { to: '/app/audit', label: 'Audit log' },
  { to: '/app/settings', label: 'Settings' },
  { to: '/app/analytics', label: 'Analytics', ownerOnly: true },
];

export function DashboardLayout() {
  const { user, org, signOut } = useAuth();
  const items = ITEMS.filter(
    (item) => item.ownerOnly !== true || (user !== null && isOwner(user.role)),
  );

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-40 border-b border-hair bg-[rgba(255,255,255,.86)] backdrop-blur-[20px]">
        <div className="shell flex h-16 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              to="/app"
              className="flex shrink-0 items-center gap-2.5 text-[17px] font-semibold tracking-headline"
            >
              <span
                aria-hidden="true"
                className="grid h-7 w-7 place-items-center rounded-full bg-ink"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-neon" />
              </span>
              Lily
            </Link>
            {org === null ? null : (
              <span className="truncate border-l border-hair pl-3 text-[14px] text-grey">
                {org.name}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4">
            <LiveStatus />
            <div className="hidden items-center gap-3 sm:flex">
              {user === null ? null : (
                <span className="text-[13px] text-grey">
                  {user.name} · {ROLE_LABEL[user.role]}
                </span>
              )}
              <button
                type="button"
                onClick={signOut}
                className="rounded-pill border border-hair px-3.5 py-1.5 text-[13px] font-medium transition-colors hover:border-[#dfe2e6]"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>

        {isMockApi ? (
          <p className="border-t border-hair bg-[#fdf6e7] px-5 py-1.5 text-center text-[12px] text-[#8a5a00]">
            Demo mode — every figure on these screens comes from an in-memory fixture, not a
            backend.
          </p>
        ) : null}
      </header>

      <div className="shell grid gap-8 py-8 md:grid-cols-[186px_minmax(0,1fr)] md:gap-10">
        <nav aria-label="Dashboard" className="md:pt-1">
          {/* Below md this is a scrolling strip; the page itself still does not
              scroll sideways because the overflow is on this element. */}
          <ul className="-mx-5 flex gap-1 overflow-x-auto px-5 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0">
            {items.map((item) => (
              <li key={item.to} className="shrink-0">
                <NavLink
                  to={item.to}
                  end={item.end === true}
                  className={({ isActive }) =>
                    cn(
                      'block whitespace-nowrap rounded-pill px-4 py-2 text-[15px] transition-colors md:rounded-[10px] md:px-3',
                      isActive
                        ? 'bg-ink text-white'
                        : 'text-grey hover:bg-white hover:text-ink',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>

          <div className="mt-6 hidden md:block">
            <Link to="/" className="text-[13px] text-grey underline underline-offset-4">
              Back to the site
            </Link>
          </div>
        </nav>

        <main id="main" className="min-w-0">
          <Outlet />
        </main>
      </div>

      <div className="shell pb-10 sm:hidden">
        <button
          type="button"
          onClick={signOut}
          className="w-full rounded-pill border border-hair bg-white py-2.5 text-[14px] font-medium"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

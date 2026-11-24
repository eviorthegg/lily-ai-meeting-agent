import { useEffect } from 'react';
import { Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { CookieBanner } from './components/CookieBanner';
import { Footer } from './components/Footer';
import { Nav } from './components/Nav';
import { StepUpPrompt } from './components/StepUpPrompt';
import { pageView } from './lib/analytics';
import { captureAttribution } from './lib/attribution/utm';
import { CreateOrg } from './pages/CreateOrg';
import { Home } from './pages/Home';
import { Legal } from './pages/Legal';
import { Login } from './pages/Login';
import { NotFound } from './pages/NotFound';
import { Onboarding } from './pages/Onboarding';
import { Signup } from './pages/Signup';
import { VerifyEmail } from './pages/VerifyEmail';
import { Analytics } from './pages/dashboard/Analytics';
import { Audit } from './pages/dashboard/Audit';
import { DashboardGate } from './pages/dashboard/DashboardGate';
import { DashboardLayout } from './pages/dashboard/DashboardLayout';
import { MeetingDetail } from './pages/dashboard/MeetingDetail';
import { Meetings } from './pages/dashboard/Meetings';
import { MfaEnroll } from './pages/dashboard/MfaEnroll';
import { Settings } from './pages/dashboard/Settings';
import { Tasks } from './pages/dashboard/Tasks';
import { Team } from './pages/dashboard/Team';

/**
 * Marketing chrome. The signup flow deliberately does not get the nav — a
 * half-finished signup should not offer four ways to wander off — so it renders
 * through the bare layout instead.
 */
function MarketingLayout() {
  return (
    <>
      <Nav />
      <main id="main">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

function BareLayout() {
  return (
    <>
      <Outlet />
      <Footer />
    </>
  );
}

/**
 * Route-change side effects, in one place.
 *
 * Attribution is captured on every navigation rather than only on mount,
 * because a visitor can land on /signup?utm_source=… directly and that is still
 * a first touch. pageView() no-ops until analytics consent exists.
 */
function RouteEffects() {
  const location = useLocation();

  useEffect(() => {
    captureAttribution();
    pageView(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    // Hash links handle their own scrolling; forcing the top would fight them.
    if (location.hash === '') window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);

  return null;
}

export function App() {
  return (
    <>
      {/* First focusable element on the page, visible only when focused. */}
      <a
        href="#main"
        className="sr-only rounded-pill bg-ink px-5 py-2.5 text-white focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[70]"
      >
        Skip to content
      </a>

      <RouteEffects />

      <Routes>
        <Route element={<MarketingLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/legal/:document" element={<Legal />} />
        </Route>

        <Route element={<BareLayout />}>
          <Route path="/signup" element={<Signup />} />
          <Route path="/login" element={<Login />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/create-org" element={<CreateOrg />} />
          <Route path="/onboarding" element={<Onboarding />} />
        </Route>

        {/* Enrollment sits outside the dashboard gate on purpose — it is where
            the gate sends a privileged user who has not enrolled, so it cannot
            live behind the check it is the answer to. */}
        <Route path="/mfa" element={<MfaEnroll />} />

        <Route path="/app" element={<DashboardGate />}>
          <Route element={<DashboardLayout />}>
            <Route index element={<Team />} />
            <Route path="meetings" element={<Meetings />} />
            <Route path="meetings/:meetingId" element={<MeetingDetail />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="audit" element={<Audit />} />
            <Route path="settings" element={<Settings />} />
            <Route path="analytics" element={<Analytics />} />
          </Route>
        </Route>

        <Route element={<BareLayout />}>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>

      <CookieBanner />

      {/* Mounted once, outside the routes. The API can ask for a second factor
          during any administrative action on any screen, including onboarding,
          which sits outside the dashboard gate. */}
      <StepUpPrompt />
    </>
  );
}

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { setAccessToken, type AuthSession, type Org, type User } from '@/lib/api';
import { forgetUser, identifyUser } from '@/lib/analytics';

/**
 * Session state for the signup and onboarding flow.
 *
 * Held in memory only. The access token never reaches localStorage — see the
 * note in lib/api/http.ts — so a reload legitimately returns the user to the
 * login screen until the refresh-cookie exchange exists on the API side.
 */

interface AuthContextValue {
  user: User | null;
  org: Org | null;
  isAuthenticated: boolean;
  adopt: (session: AuthSession) => void;
  setOrg: (org: Org) => void;
  /**
   * Apply a change the server has already made — MFA enrollment being the one
   * that matters, since the gate in front of the dashboard reads it. Deliberately
   * narrow: this cannot set a role. A client that could edit its own role would
   * make every role check in this app theatre.
   */
  markMfaEnrolled: () => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [org, setOrgState] = useState<Org | null>(null);

  const adopt = useCallback((session: AuthSession) => {
    setAccessToken(session.tokens.accessToken);
    setUser(session.user);
    setOrgState(session.org);
    // The backend user id, never the email — see the note in analytics/posthog.
    identifyUser(session.user.id);
  }, []);

  const setOrg = useCallback((next: Org) => {
    setOrgState(next);
    setUser((current) => (current === null ? current : { ...current, orgId: next.id }));
  }, []);

  const markMfaEnrolled = useCallback(() => {
    setUser((current) => (current === null ? current : { ...current, mfaEnrolled: true }));
  }, []);

  const signOut = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setOrgState(null);
    forgetUser();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      org,
      isAuthenticated: user !== null,
      adopt,
      setOrg,
      markMfaEnrolled,
      signOut,
    }),
    [user, org, adopt, setOrg, markMfaEnrolled, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}

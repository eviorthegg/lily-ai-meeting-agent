import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './types';
import { useAuth } from '@/lib/auth/AuthProvider';

/**
 * The one way this app reads from the API.
 *
 * Three behaviours it exists to guarantee, none of which a bare `useEffect` +
 * `fetch` gives you:
 *
 *  1. **A failed refresh does not erase the screen.** Previously-loaded data is
 *     kept and marked stale with the time it was true. The alternative — blanking
 *     to a spinner because the network blipped — is how a dashboard ends up
 *     showing nothing during exactly the incident you opened it for.
 *  2. **401 ends the session.** The UI cannot know a token expired any other
 *     way, and continuing to render a signed-in shell around a dead session is
 *     worse than bouncing to login.
 *  3. **403 is a state, not a crash.** Role checks in the browser decide what to
 *     render; the server decides what is allowed. When those disagree the server
 *     wins and the screen says so. Every caller gets this for free, so no screen
 *     can forget to handle it.
 *
 * There is no cache and no request dedupe. At this data volume neither earns its
 * complexity, and a stale-while-revalidate cache would fight requirement 1.
 */

export interface ApiResult<T> {
  data: T | null;
  error: ApiError | null;
  /** True only while a request with no data behind it is in flight. */
  loading: boolean;
  /** True while refreshing on top of data that is already on screen. */
  refreshing: boolean;
  /** Epoch ms of the last success. Null until the first one lands. */
  fetchedAt: number | null;
  /** Data is on screen but the most recent attempt failed. */
  stale: boolean;
  forbidden: boolean;
  reload: () => void;
}

/**
 * `deps` behaves like useEffect's: the request re-runs when they change. `run`
 * is read through a ref, so an inline arrow does not cause a request per render.
 */
export function useApi<T>(run: () => Promise<T>, deps: readonly unknown[]): ApiResult<T> {
  const { signOut } = useAuth();
  const runRef = useRef(run);
  runRef.current = run;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  // Guards a resolved promise from a previous dependency set overwriting the
  // current one — the classic out-of-order response bug.
  const generation = useRef(0);

  useEffect(() => {
    const mine = generation.current + 1;
    generation.current = mine;
    let cancelled = false;

    setBusy(true);
    void (async () => {
      try {
        const result = await runRef.current();
        if (cancelled || generation.current !== mine) return;
        setData(result);
        setError(null);
        setFetchedAt(Date.now());
      } catch (caught) {
        if (cancelled || generation.current !== mine) return;
        const failure =
          caught instanceof ApiError
            ? caught
            : new ApiError('server_error', 'Something went wrong.', 0);

        // The session is gone. Nothing on the screen behind this is trustworthy.
        if (failure.code === 'unauthorized') {
          signOut();
          return;
        }
        setError(failure);
      } finally {
        if (!cancelled && generation.current === mine) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // The caller's `deps` are spread in deliberately: they are this hook's
    // contract, exactly as they are for useEffect. `run` is read from a ref so
    // it is correctly absent here — including it would refetch every render.
  }, [...deps, nonce, signOut]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return {
    data,
    error,
    loading: busy && data === null,
    refreshing: busy && data !== null,
    fetchedAt,
    stale: error !== null && data !== null,
    forbidden: error?.code === 'forbidden',
    reload,
  };
}

/**
 * Mutations. Same error classification as reads — a 401 mid-action ends the
 * session, a 403 comes back to the caller as a message it can put next to the
 * control the user pressed.
 */
export function useApiAction(): {
  busy: boolean;
  error: ApiError | null;
  clearError: () => void;
  run: <T>(action: () => Promise<T>) => Promise<T | null>;
} {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        return result;
      } catch (caught) {
        const failure =
          caught instanceof ApiError
            ? caught
            : new ApiError('server_error', 'Something went wrong.', 0);
        if (failure.code === 'unauthorized') {
          signOut();
          return null;
        }
        if (alive.current) setError(failure);
        return null;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [signOut],
  );

  const clearError = useCallback(() => setError(null), []);

  return { busy, error, clearError, run };
}

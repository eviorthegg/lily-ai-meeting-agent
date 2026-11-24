import { useSyncExternalStore } from 'react';
import { getSnapshot, subscribe, type ConsentRecord } from './analytics/consent';

/**
 * Live consent state.
 *
 * CSS handles reduced motion for every looping animation, so there is no
 * `usePrefersReducedMotion` here — a media query that the browser evaluates is
 * more reliable than a React state that has to be kept in sync, and it works
 * before hydration. See the .motion-only utility in styles/index.css.
 */
export function useConsent(): ConsentRecord | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

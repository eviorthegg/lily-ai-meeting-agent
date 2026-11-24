import { CONSENT_POLICY_VERSION } from '@/config/env';

/**
 * Consent state, stored first-party and versioned.
 *
 * The shape matches ConsentDoc in api/src/db/schema.ts so the record can be
 * posted to the backend unchanged once that endpoint exists. `necessary` is
 * typed as the literal `true` for the same reason it is there: it is not a
 * setting, and no code path may write `false` to it.
 */
export interface ConsentCategories {
  readonly necessary: true;
  readonly analytics: boolean;
  readonly marketing: boolean;
}

export interface ConsentRecord {
  readonly categories: ConsentCategories;
  readonly policyVersion: string;
  /** ISO 8601. Proving *when* consent was given is half of what a record is for. */
  readonly at: string;
  /** Stable pseudonymous id, generated locally. Never derived from anything personal. */
  readonly anonymousId: string;
}

const STORAGE_KEY = 'lily.consent.v1';
const ANON_KEY = 'lily.anonymous_id';

export const ALL_DENIED: ConsentCategories = { necessary: true, analytics: false, marketing: false };
export const ALL_GRANTED: ConsentCategories = { necessary: true, analytics: true, marketing: true };

type Listener = () => void;

const listeners = new Set<Listener>();
let cached: ConsentRecord | null | undefined;

/**
 * Storage can throw — Safari private mode, disabled cookies, an iframe with a
 * restrictive sandbox. Consent must degrade to "not granted" in that case, not
 * crash the page and not silently assume yes.
 */
function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Consent then lasts for this page view only. Correct fallback: ask again. */
  }
}

function isRecord(value: unknown): value is ConsentRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ConsentRecord>;
  return (
    typeof candidate.policyVersion === 'string' &&
    typeof candidate.at === 'string' &&
    typeof candidate.anonymousId === 'string' &&
    typeof candidate.categories === 'object' &&
    candidate.categories !== null &&
    typeof candidate.categories.analytics === 'boolean' &&
    typeof candidate.categories.marketing === 'boolean'
  );
}

export function getAnonymousId(): string {
  const existing = safeRead(ANON_KEY);
  if (existing !== null && existing !== '') return existing;
  const generated = crypto.randomUUID();
  safeWrite(ANON_KEY, generated);
  return generated;
}

/**
 * The stored decision, or null when there is none *for the current policy
 * version*. A policy change invalidates the old answer rather than inheriting
 * it — consent to a previous policy is not consent to this one.
 */
export function getConsent(): ConsentRecord | null {
  if (cached !== undefined) return cached;

  const raw = safeRead(STORAGE_KEY);
  if (raw === null) {
    cached = null;
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.policyVersion !== CONSENT_POLICY_VERSION) {
      cached = null;
      return null;
    }
    cached = parsed;
    return parsed;
  } catch {
    cached = null;
    return null;
  }
}

export function setConsent(categories: ConsentCategories): ConsentRecord {
  const record: ConsentRecord = {
    categories,
    policyVersion: CONSENT_POLICY_VERSION,
    at: new Date().toISOString(),
    anonymousId: getAnonymousId(),
  };
  cached = record;
  safeWrite(STORAGE_KEY, JSON.stringify(record));
  for (const listener of listeners) listener();
  return record;
}

export function hasDecided(): boolean {
  return getConsent() !== null;
}

export function allows(category: 'analytics' | 'marketing'): boolean {
  return getConsent()?.categories[category] === true;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** useSyncExternalStore requires a referentially stable snapshot between changes. */
export function getSnapshot(): ConsentRecord | null {
  return getConsent();
}

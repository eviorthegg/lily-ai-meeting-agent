/// <reference types="vite/client" />

/**
 * Every value the browser bundle is allowed to read from the environment.
 *
 * Vite inlines `VITE_*` at build time, which means anything here ships to the
 * client in plain text. Only publishable identifiers belong in this list — the
 * PostHog *project* key and the GA4 measurement id are designed to be public.
 * A secret must never be added here; it would be readable in the bundle.
 */
interface ImportMetaEnv {
  /**
   * Declared as plain strings, not unions. A .env file can supply anything —
   * including an empty string, which a union type would tell us is impossible —
   * so these are narrowed by validation in src/config/env.ts instead of by
   * assertion here.
   */
  readonly VITE_LILY_STAGE?: string;
  readonly VITE_LILY_API_BASE_URL?: string;
  /** 'mock' serves the UI from an in-memory fixture; 'http' talks to the real API. */
  readonly VITE_LILY_API_MODE?: string;
  readonly VITE_LILY_GA4_MEASUREMENT_ID?: string;
  readonly VITE_LILY_POSTHOG_KEY?: string;
  readonly VITE_LILY_POSTHOG_HOST?: string;
  readonly VITE_LILY_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

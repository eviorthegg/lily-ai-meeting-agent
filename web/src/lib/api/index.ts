import { apiMode } from '@/config/env';
import { httpApi, setAccessToken as setHttpAccessToken } from './http';
import { clearMockSession, mockApi } from './mock';
import type { LilyApi } from './types';

/**
 * The seam. Everything in the UI imports `api` from here and nothing imports an
 * adapter directly, so the day the REST API lands the only edit is an env var.
 */
export const api: LilyApi = apiMode === 'http' ? httpApi : mockApi;

export const isMockApi = apiMode !== 'http';

/**
 * Clearing the token has to reach the mock too.
 *
 * The mock decides authorisation from a remembered caller rather than from the
 * bearer token, so without this a signed-out session would keep getting answers
 * from it — the one behaviour that would make the mock lie about what the real
 * API does.
 */
export function setAccessToken(token: string | null): void {
  setHttpAccessToken(token);
  if (isMockApi && token === null) clearMockSession();
}

export * from './types';

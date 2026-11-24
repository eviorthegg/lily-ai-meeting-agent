import { apiBaseUrl } from '@/config/env';
import {
  ApiError,
  type AnalyticsQuery,
  type ApiErrorCode,
  type AuditPage,
  type AuditQuery,
  type AuthSession,
  type AuthTokens,
  type BulkInviteResult,
  type BulkInviteRow,
  type CreateMeetingRequest,
  type CreateOrgRequest,
  type Invite,
  type InviteRequest,
  type LilyApi,
  type ListMeetingsQuery,
  type ListTasksQuery,
  type LiveSnapshot,
  type LoginRequest,
  type Meeting,
  type MeetingDetail,
  type MfaEnrollmentResult,
  type MfaEnrollmentStart,
  type Org,
  type OrgSettings,
  type OrgTasksQuery,
  type OwnerAnalytics,
  type RefreshRequest,
  type SignupRequest,
  type StepUpResult,
  type Task,
  type TeamMember,
  type UpdateOrgSettingsRequest,
  type User,
  type VerifyEmailRequest,
} from './types';

/**
 * Real transport, and the default adapter.
 *
 * The access token lives in a module-level variable rather than localStorage.
 * A token in localStorage is readable by any script that gets injected into the
 * page; in memory it dies with the tab, and the refresh token is what survives
 * a reload. That is the standard trade and it is deliberate.
 */

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

/**
 * Asks the user for a second factor and resolves once the server has accepted it.
 *
 * Registered by <StepUpPrompt>, which is mounted once at the root. Handling this
 * in the transport rather than at each call site is the point: the API can refuse
 * *any* administrative action with `step_up_required`, at any moment, because the
 * grace window lapses on a timer rather than on a navigation. A per-screen
 * implementation would mean every new administrative button is one someone can
 * forget to wire, and the symptom would be a dead control rather than a compile
 * error.
 */
export type StepUpResolver = (action: string | null) => Promise<boolean>;

let stepUpResolver: StepUpResolver | null = null;

export function setStepUpResolver(resolver: StepUpResolver | null): void {
  stepUpResolver = resolver;
}

function codeFromStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'validation_failed';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'server_error' : 'validation_failed';
  }
}

interface ErrorBody {
  code?: string;
  message?: string;
  fields?: Record<string, string>;
}

/**
 * Perform the call, and retry it once if the server asked for a fresh factor.
 *
 * The retry is deliberately at most one: a resolver that returns false (the user
 * dismissed the prompt, or typed the wrong code and gave up) surfaces the
 * original 403 to the caller rather than looping.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await send<T>(path, init);
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      error.code !== 'step_up_required' ||
      stepUpResolver === null
    ) {
      throw error;
    }

    const satisfied = await stepUpResolver(error.fields['action'] ?? null);
    if (!satisfied) throw error;

    return send<T>(path, init);
  }
}

async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (accessToken !== null) headers.set('Authorization', `Bearer ${accessToken}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers,
      // Refresh tokens are delivered as httpOnly cookies where the API supports
      // it; this is required for that to work cross-origin.
      credentials: 'include',
    });
  } catch {
    throw new ApiError('network', 'Could not reach the server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text === '' ? null : safeJson(text);

  if (!response.ok) {
    const body = (parsed ?? {}) as ErrorBody;
    throw new ApiError(
      (body.code as ApiErrorCode | undefined) ?? codeFromStatus(response.status),
      body.message ?? 'Something went wrong.',
      response.status,
      body.fields ?? {},
    );
  }

  return parsed as T;
}

/**
 * The audit export is a file, not a document. It goes through its own path so
 * the JSON parser never sees a CSV body and turn it into `null`.
 *
 * It is also step-up gated, so it needs the same one-shot retry — and the error
 * body on a refusal is JSON even though the success body is CSV.
 */
async function requestText(path: string, retried = false): Promise<string> {
  const headers = new Headers({ Accept: 'text/csv' });
  if (accessToken !== null) headers.set('Authorization', `Bearer ${accessToken}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}${path}`, {
      headers,
      credentials: 'include',
    });
  } catch {
    throw new ApiError('network', 'Could not reach the server. Check your connection.');
  }

  if (!response.ok) {
    const body = (safeJson(await response.text()) ?? {}) as ErrorBody;
    const code = (body.code as ApiErrorCode | undefined) ?? codeFromStatus(response.status);

    if (code === 'step_up_required' && stepUpResolver !== null && !retried) {
      const satisfied = await stepUpResolver(body.fields?.['action'] ?? null);
      if (satisfied) return requestText(path, true);
    }

    throw new ApiError(code, body.message ?? 'Export failed.', response.status, body.fields ?? {});
  }
  return response.text();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Only non-null values are serialised, so an absent filter is an absent param. */
function toQuery(entries: ReadonlyArray<readonly [string, string | number | null]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== null) params.set(key, String(value));
  }
  const serialised = params.toString();
  return serialised === '' ? '' : `?${serialised}`;
}

function taskQuery(query: ListTasksQuery): string {
  return toQuery([
    ['meetingId', query.meetingId],
    ['status', query.status],
    ['limit', query.limit],
  ]);
}

function auditQuery(query: AuditQuery): string {
  return toQuery([
    ['search', query.search],
    ['action', query.action],
    ['from', query.from],
    ['to', query.to],
    ['limit', query.limit],
    ['cursor', query.cursor],
  ]);
}

export const httpApi: LilyApi = {
  signup: (body: SignupRequest) =>
    request<{ user: User; verificationRequired: boolean }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  verifyEmail: (body: VerifyEmailRequest) =>
    request<AuthSession>('/auth/verify-email', { method: 'POST', body: JSON.stringify(body) }),

  resendVerification: (email: string) =>
    request<void>('/auth/verify-email/resend', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  login: (body: LoginRequest) =>
    request<AuthSession>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),

  refresh: (body: RefreshRequest) =>
    request<AuthTokens>('/auth/refresh', { method: 'POST', body: JSON.stringify(body) }),

  createOrg: (body: CreateOrgRequest) =>
    request<Org>('/orgs', { method: 'POST', body: JSON.stringify(body) }),

  invite: (orgId: string, body: InviteRequest) =>
    request<Invite>(`/orgs/${encodeURIComponent(orgId)}/invite`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listInvites: (orgId: string) =>
    request<Invite[]>(`/orgs/${encodeURIComponent(orgId)}/invites`),

  getEmployee: (orgId: string, employeeId: string) =>
    request<User>(
      `/orgs/${encodeURIComponent(orgId)}/employees/${encodeURIComponent(employeeId)}`,
    ),

  removeEmployee: (orgId: string, employeeId: string) =>
    request<void>(
      `/orgs/${encodeURIComponent(orgId)}/employees/${encodeURIComponent(employeeId)}`,
      { method: 'DELETE' },
    ),

  createMeeting: (body: CreateMeetingRequest) =>
    request<Meeting>('/meetings', { method: 'POST', body: JSON.stringify(body) }),

  getMeeting: (meetingId: string) =>
    request<Meeting>(`/meetings/${encodeURIComponent(meetingId)}`),

  endMeeting: (meetingId: string) =>
    request<Meeting>(`/meetings/${encodeURIComponent(meetingId)}/end`, { method: 'POST' }),

  listTasks: (query: ListTasksQuery) => request<Task[]>(`/tasks${taskQuery(query)}`),

  // --- dashboard ----------------------------------------------------------

  listTeam: (orgId: string) => request<TeamMember[]>(`/orgs/${encodeURIComponent(orgId)}/team`),

  bulkInvite: (orgId: string, rows: BulkInviteRow[]) =>
    request<BulkInviteResult>(`/orgs/${encodeURIComponent(orgId)}/invite/bulk`, {
      method: 'POST',
      body: JSON.stringify({ rows }),
    }),

  listMeetings: (orgId: string, query: ListMeetingsQuery) =>
    request<Meeting[]>(
      `/orgs/${encodeURIComponent(orgId)}/meetings${toQuery([
        ['window', query.window],
        ['limit', query.limit],
      ])}`,
    ),

  getMeetingDetail: (meetingId: string) =>
    request<MeetingDetail>(`/meetings/${encodeURIComponent(meetingId)}/detail`),

  listOrgTasks: (orgId: string, query: OrgTasksQuery) =>
    request<Task[]>(
      `/orgs/${encodeURIComponent(orgId)}/tasks${toQuery([
        ['ownerEmployeeId', query.ownerEmployeeId],
        ['status', query.status],
        ['dueFrom', query.dueFrom],
        ['dueTo', query.dueTo],
        ['limit', query.limit],
      ])}`,
    ),

  getOrgSettings: (orgId: string) =>
    request<OrgSettings>(`/orgs/${encodeURIComponent(orgId)}/settings`),

  updateOrgSettings: (orgId: string, body: UpdateOrgSettingsRequest) =>
    request<OrgSettings>(`/orgs/${encodeURIComponent(orgId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  acknowledgeConsentNotice: (orgId: string) =>
    request<OrgSettings>(`/orgs/${encodeURIComponent(orgId)}/consent-notice`, { method: 'POST' }),

  listAudit: (orgId: string, query: AuditQuery) =>
    request<AuditPage>(`/orgs/${encodeURIComponent(orgId)}/audit${auditQuery(query)}`),

  exportAudit: (orgId: string, query: AuditQuery) =>
    requestText(`/orgs/${encodeURIComponent(orgId)}/audit/export${auditQuery(query)}`),

  // --- MFA ----------------------------------------------------------------

  startMfaEnrollment: () =>
    request<MfaEnrollmentStart>('/auth/mfa/totp/enroll', { method: 'POST' }),

  confirmMfaEnrollment: (code: string) =>
    request<MfaEnrollmentResult>('/auth/mfa/totp/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  // Called by the step-up prompt itself, so it must NOT go through `request` —
  // a 403 here is a wrong code, not an invitation to prompt again from inside
  // the prompt.
  verifyStepUp: (code: string) =>
    send<StepUpResult>('/auth/mfa/step-up', { method: 'POST', body: JSON.stringify({ code }) }),

  // --- owner only ---------------------------------------------------------

  getOwnerAnalytics: (query: AnalyticsQuery) =>
    request<OwnerAnalytics>(
      `/admin/analytics${toQuery([
        ['grain', query.grain],
        ['periods', query.periods],
      ])}`,
    ),

  getLiveSnapshot: () => request<LiveSnapshot>('/admin/analytics/live'),
};

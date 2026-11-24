import type { Role } from '@/lib/api';

/**
 * Role predicates for the browser.
 *
 * These mirror `PRIVILEGED_ROLES` in api/src/db/schema.ts and `mfaRequiredFor`
 * in api/src/auth/mfa-policy.ts. They exist to decide what to *render* — which
 * nav items appear, which buttons are offered — and nothing more.
 *
 * They are not an authorisation mechanism. Every one of them runs on data the
 * browser holds and could be made to say anything by anyone with a debugger.
 * The API decides; a component that calls an endpoint the user is not entitled
 * to must handle the 403 rather than assume these functions prevented the call.
 * See `useApi` in lib/api/useApi.ts, which turns that 403 into a real state.
 */

const KNOWN_ROLES: readonly string[] = ['owner', 'admin', 'manager', 'employee'];

const PRIVILEGED_ROLES: readonly Role[] = ['owner', 'admin', 'manager'];

export function isPrivileged(role: Role): boolean {
  // Fail closed on an unknown role, the same way the server does: a value that
  // arrived from outside the union is treated as privileged, not waved through.
  if (!KNOWN_ROLES.includes(role)) return true;
  return PRIVILEGED_ROLES.includes(role);
}

/** Who sees the dashboard at all. */
export function canSeeDashboard(role: Role): boolean {
  return isPrivileged(role);
}

/** Who may change org-wide security posture. Managers can read, not write. */
export function canEditSettings(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

/** Owner analytics is the product owner's view of the business, not a customer feature. */
export function isOwner(role: Role): boolean {
  return role === 'owner';
}

/**
 * Whether this role must have MFA before reaching the dashboard.
 *
 * Same rule as `mfaRequiredFor` server-side. The server enforces it on every
 * request; this only decides whether to route the user into enrollment instead
 * of leaving them staring at a wall of 403s.
 */
export function mfaRequiredFor(role: Role): boolean {
  return isPrivileged(role);
}

export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  employee: 'Employee',
};

/** Roles an invite may hand out. Ownership transfers are not an invite. */
export const ASSIGNABLE_ROLES: readonly Role[] = ['employee', 'manager', 'admin'];

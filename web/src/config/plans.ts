/**
 * Plans and metering.
 *
 * Token allowances are NOT finalised. Every number below is provisional, which
 * is exactly why no plan number is written into a sentence anywhere in the UI —
 * copy interpolates from this file. Changing an allowance here changes the
 * pricing section and nothing else has to be found and edited.
 *
 * `PlanId` intentionally matches the union in api/src/db/schema.ts so the two
 * cannot drift apart silently.
 */

export type PlanId = 'test' | 'team' | 'scale';

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  readonly priceCents: number;
  readonly cadence: string;
  readonly tagline: string;
  /** Lily tokens included per cycle. Provisional — see ALLOWANCES_FINAL. */
  readonly tokenAllowance: number;
  readonly seats: string;
  readonly features: readonly string[];
  readonly cta: string;
  readonly featured: boolean;
}

/**
 * Flip to true once allowances are signed off. While false the pricing section
 * says so out loud rather than presenting a provisional number as settled.
 */
export const ALLOWANCES_FINAL = false;

export const PLANS: readonly Plan[] = [
  {
    id: 'test',
    name: 'Test',
    priceCents: 0,
    cadence: '',
    tagline: 'A starter grant, no card. Every feature is unlocked, so what you evaluate is the real thing.',
    tokenAllowance: 250_000,
    seats: 'Up to 5 people',
    features: [
      'Every feature unlocked',
      'No card, no trial countdown',
      'Starter token grant',
      'Full audit log',
    ],
    cta: 'Start testing',
    featured: false,
  },
  {
    id: 'team',
    name: 'Team',
    priceCents: 2000,
    cadence: '/month',
    tagline: 'For a team that runs its standups and planning with Lily in the room.',
    tokenAllowance: 2_000_000,
    seats: 'Up to 25 people',
    features: [
      'Everything in Test',
      'Monthly token allowance',
      'Top-up packs that never expire',
      'Passkeys and mandatory MFA for admins',
    ],
    cta: 'Choose Team',
    featured: true,
  },
  {
    id: 'scale',
    name: 'Scale',
    priceCents: 10000,
    cadence: '/month',
    tagline: 'For several teams meeting at once, with retention and policy under your control.',
    tokenAllowance: 12_000_000,
    seats: 'Unlimited people',
    features: [
      'Everything in Team',
      'Concurrent meetings',
      'Per-role permission policy',
      'Configurable retention and hard delete',
      'SSO (SAML or OIDC)',
    ],
    cta: 'Choose Scale',
    featured: false,
  },
];

/** "2,000,000" reads as noise at this size; "2M" is the same fact, legible. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function formatPrice(cents: number): string {
  return cents === 0 ? '$0' : `$${Math.round(cents / 100)}`;
}

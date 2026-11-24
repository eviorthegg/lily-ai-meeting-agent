import type { PlanId } from '../db/schema.js';

/**
 * Plan definitions, server-side.
 *
 * These mirror web/src/config/plans.ts, which is the customer-facing copy. The
 * duplication is deliberate and narrow: the browser bundle must not import a
 * NodeNext package, and the server must not take pricing from anything the
 * browser could have edited. Only the two fields the API actually decides with
 * are here — an allowance to grant and a price to bill — rather than the whole
 * marketing record.
 *
 * `tokenAllowance` is *copied* onto the org at creation (see `OrgBilling`), so a
 * change here affects new cycles rather than retroactively rewriting live ones.
 */
export interface PlanDefinition {
  readonly id: PlanId;
  readonly name: string;
  /** Monthly subscription price. The Test plan is genuinely free, not a trial. */
  readonly priceCents: number;
  readonly tokenAllowance: number;
}

export const PLANS: Readonly<Record<PlanId, PlanDefinition>> = {
  test: { id: 'test', name: 'Test', priceCents: 0, tokenAllowance: 250_000 },
  team: { id: 'team', name: 'Team', priceCents: 2_000, tokenAllowance: 2_000_000 },
  scale: { id: 'scale', name: 'Scale', priceCents: 10_000, tokenAllowance: 12_000_000 },
};

/** Every new org starts here — no card, every feature unlocked. */
export const DEFAULT_PLAN: PlanId = 'test';

export function planFor(id: PlanId): PlanDefinition {
  return PLANS[id];
}

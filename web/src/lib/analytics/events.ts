/**
 * The complete set of events this frontend may emit.
 *
 * A closed union rather than a string parameter, because the constraint that
 * matters here is not "which events exist" but "nothing else is ever sent". An
 * open `track(name: string)` would let meeting content reach an analytics
 * vendor through a careless call site; this cannot.
 */
export type EventName =
  | 'signup_started'
  | 'signup_completed'
  | 'org_created'
  | 'invite_sent'
  | 'daemon_installed'
  | 'daemon_connected'
  | 'meeting_started'
  | 'first_task_dispatched'
  | 'permission_requested'
  | 'permission_granted'
  | 'meeting_completed'
  | 'summary_sent'
  | 'checkout_started'
  | 'subscription_created'
  | 'topup_purchased'
  | 'promo_redeemed';

/**
 * Property values are restricted to identifiers, counts, flags and enum-ish
 * short strings.
 *
 * DATA POLICY — this mirrors the header in api/src/db/schema.ts. Meeting
 * content, transcripts, task text, employee names and email addresses are never
 * sent to an analytics vendor. Ids and event names only. If a property needs a
 * human-readable label, the answer is an id plus a lookup elsewhere, not the
 * label on the wire.
 */
export type EventProps = Readonly<Record<string, string | number | boolean>>;

/**
 * Property keys that would carry content if anyone added them. Checked at
 * runtime in dev so the mistake surfaces at the call site rather than in a
 * vendor dashboard three weeks later.
 */
const FORBIDDEN_KEY = /(name|email|title|text|summary|transcript|content|task|query|prompt)/i;

/** Ids are allowed even though they contain "id" next to a forbidden word. */
const ALLOWED_EXACT = new Set(['org_id', 'user_id', 'employee_id', 'meeting_id', 'task_id', 'plan_id']);

export function assertSafeProps(event: EventName, props: EventProps): void {
  for (const key of Object.keys(props)) {
    if (ALLOWED_EXACT.has(key)) continue;
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(
        `Analytics: property "${key}" on event "${event}" looks like it carries content. ` +
          'Only ids, counts and flags may be sent. See the data policy in api/src/db/schema.ts.',
      );
    }
  }
}

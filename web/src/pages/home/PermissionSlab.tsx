/**
 * The permission tiers, described accurately. This is real product behaviour —
 * the same three tiers the daemon enforces — so the wording here has to stay in
 * step with what the agent actually gates. It is not marketing copy.
 */

interface Tier {
  readonly tier: string;
  readonly summary: string;
  readonly examples: readonly string[];
  /** The `never` row is muted: it describes what is refused, not offered. */
  readonly muted: boolean;
}

const TIERS: readonly Tier[] = [
  {
    tier: 'no prompt',
    summary: 'Reading. Nothing changes, so nobody is interrupted.',
    examples: ['read files', 'grep', 'git log', 'git diff'],
    muted: false,
  },
  {
    tier: 'asks the room',
    summary: 'Anything with an effect. Lily asks out loud and waits for an answer.',
    examples: ['run tests', 'shell commands', 'install packages', 'write files'],
    muted: false,
  },
  {
    tier: 'never',
    summary: 'Refused regardless of who asks, including the owner of the machine.',
    examples: ['push to protected branches', 'delete', 'deploy', 'read credentials'],
    muted: true,
  },
];

export function PermissionSlab() {
  return (
    <section id="permissions" className="slab scroll-mt-20 py-20 sm:py-28">
      <div className="shell">
        <h2 className="eyebrow">what she can do without asking</h2>
        <p className="mt-5 max-w-[20ch] text-[2rem] font-semibold tracking-headline sm:text-[2.75rem]">
          Three tiers. No surprises.
        </p>
        <p className="lede mt-6 text-[17px]">
          Permission is asked in the meeting, out loud, and the answer is spoken. Silence is a no —
          an unanswered request times out and is denied. Every grant and every denial lands in the
          audit log with who said it.
        </p>

        <div className="mt-12 overflow-hidden rounded-card border border-[rgba(255,255,255,.14)]">
          <div className="hidden grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1.1fr)] gap-6 border-b border-[rgba(255,255,255,.14)] px-6 py-4 md:grid">
            <span className="data text-grey">tier</span>
            <span className="data text-grey">meaning</span>
            <span className="data text-grey">examples</span>
          </div>

          {TIERS.map((row, index) => (
            <div
              key={row.tier}
              className={[
                'grid gap-3 px-6 py-6 md:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1.1fr)] md:gap-6',
                index > 0 ? 'border-t border-[rgba(255,255,255,.14)]' : '',
                row.muted ? 'text-grey' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span
                className={[
                  'data',
                  // Neon is legal here: this is an --ink surface, where it reads
                  // at 16.9:1. The muted row stays grey by design.
                  row.muted ? 'text-grey' : 'text-neon',
                ].join(' ')}
              >
                {row.tier}
              </span>
              <p className={row.muted ? 'text-[15px] leading-relaxed' : 'text-[15px] leading-relaxed text-white'}>
                {row.summary}
              </p>
              <ul className="flex flex-wrap gap-2">
                {row.examples.map((example) => (
                  <li
                    key={example}
                    className="data rounded-pill border border-[rgba(255,255,255,.16)] px-3 py-1 text-grey"
                  >
                    {example}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-6 text-[14px] leading-relaxed text-grey">
          When someone asks Lily to do something on their own machine, that spoken request is the
          approval for the thing they asked for. Anything the agent tries beyond it still gets
          gated.
        </p>
      </div>
    </section>
  );
}

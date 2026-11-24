import { RoutingGraph } from '@/components/RoutingGraph';
import { ButtonLink } from '@/components/ui/Button';

/**
 * Coding agents Lily can dispatch to.
 *
 * PLACEHOLDER marks — see web/public/brand/README.md. Each vendor publishes a
 * brand kit; dropping the official file at the same path is the entire swap.
 */
const AGENTS: readonly { readonly name: string; readonly src: string }[] = [
  { name: 'Claude Code', src: '/brand/agents/claude-code.svg' },
  { name: 'Codex', src: '/brand/agents/codex.svg' },
  { name: 'Cursor', src: '/brand/agents/cursor.svg' },
  { name: 'Gemini CLI', src: '/brand/agents/gemini.svg' },
];

function AgentRail() {
  return (
    <aside
      aria-labelledby="agent-rail-heading"
      className="rounded-card border border-hair bg-white p-6 lg:w-[248px]"
    >
      <h2 id="agent-rail-heading" className="font-mono text-eyebrow lowercase text-green-deep">
        works with
      </h2>

      {/* Two columns on small screens so the rail does not become a tall stack
          above the fold; one column once it sits beside the copy. */}
      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-1">
        {AGENTS.map((agent) => (
          <li key={agent.name} className="flex items-center gap-3">
            <img
              src={agent.src}
              alt=""
              aria-hidden="true"
              width={32}
              height={32}
              className="h-8 w-8 shrink-0"
            />
            <span className="text-[14px] font-medium text-ink">{agent.name}</span>
          </li>
        ))}
      </ul>

      <p className="mt-5 border-t border-hair pt-4 text-[13px] leading-normal text-grey">
        Or any other CLI — the agent command is a template in your own config.
      </p>
    </aside>
  );
}

export function Hero() {
  return (
    <section className="shell pb-8 pt-16 sm:pt-24">
      {/* Copy and rail sit side by side only once there is room for the rail to
          be a column; below that the rail drops beneath the CTAs. */}
      <div className="flex flex-col gap-10 lg:flex-row lg:items-start lg:justify-between lg:gap-14">
        <div className="lg:flex-1">
          <p className="inline-flex items-center gap-2.5 rounded-pill border border-hair bg-white py-1.5 pl-3 pr-4">
            {/* Green, not neon: this dot sits on white. */}
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-green animate-blink motion-safe-anim"
            />
            <span className="font-mono text-eyebrow lowercase text-grey">
              one bot in the meeting · one agent per person
            </span>
          </p>

          <h1 className="display mt-7 max-w-[15ch] font-semibold">
            She knows who the question is for.
          </h1>

          <p className="lede mt-6">
            Lily joins your Zoom, Meet or Teams call as a participant. She listens, she speaks,
            and when work comes up she hands it to that person&apos;s own coding agent — on their
            machine, with their repos and their permissions.
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <ButtonLink to="/signup">Start testing</ButtonLink>
            <ButtonLink to="#routing" variant="secondary">
              See how routing works
            </ButtonLink>
          </div>
        </div>

        <AgentRail />
      </div>

      <RoutingGraph />
    </section>
  );
}

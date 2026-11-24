import { cn } from '@/lib/cn';

/**
 * The routing graph.
 *
 * One meeting, one Lily, four people — each with their own agent on their own
 * machine. Neon pulses travel outward along the edges on a loop.
 *
 * Three decisions worth explaining:
 *
 * 1. COLOUR. The pulse itself is drawn in --green, not --neon. This sits on
 *    white, where neon measures 1.35:1 and would be close to invisible as well
 *    as against the colour rule. Neon appears here only as a blurred halo under
 *    the green core, and at full strength on the hub, which is an --ink surface.
 *
 * 2. STAGGER. Durations are mutually non-harmonic (3.1 / 4.3 / 3.7 / 5.1 / 2.9)
 *    and the delays are irregular. Equal durations with staggered delays would
 *    re-synchronise into a marching pattern; these drift apart indefinitely, so
 *    the graph never looks like it is keeping time.
 *
 * 3. TWO LAYOUTS. A four-node fan legible at 1200px is unreadable at 375px —
 *    the labels scale down with the viewBox and become sub-6px type. Rather
 *    than shrink one layout past readability, the same nodes are rendered
 *    through two coordinate sets and the breakpoint swaps them.
 */

interface NodeSpec {
  readonly name: string;
  readonly agent: string;
  /** Portrait. Swap the file in /public/avatars — no code change needed. */
  readonly avatar: string;
}

const TEAMMATES: readonly NodeSpec[] = [
  { name: 'Maya', agent: 'claude code', avatar: '/avatars/maya.svg' },
  { name: 'Dan', agent: 'codex', avatar: '/avatars/dan.svg' },
  { name: 'Ari', agent: 'cursor', avatar: '/avatars/ari.svg' },
  { name: 'Noa', agent: 'gemini cli', avatar: '/avatars/noa.svg' },
];

/**
 * Meeting platforms shown inside the meeting node.
 *
 * These are PLACEHOLDER marks — see web/public/brand/README.md. Each vendor
 * publishes a brand kit with exact geometry and clear-space rules; dropping the
 * official file at the same path is the whole swap.
 */
const PLATFORMS: readonly { readonly label: string; readonly src: string }[] = [
  { label: 'Zoom', src: '/brand/platforms/zoom.svg' },
  { label: 'Google Meet', src: '/brand/platforms/meet.svg' },
  { label: 'Microsoft Teams', src: '/brand/platforms/teams.svg' },
];

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Layout {
  readonly id: string;
  readonly viewBox: string;
  readonly meeting: Point;
  readonly meetingWidth: number;
  readonly hub: Point;
  readonly hubRadius: number;
  readonly nodeRadius: number;
  readonly nodes: readonly Point[];
  /** Bezier path per edge, hub → teammate. Drawn under the node circles. */
  readonly edges: readonly string[];
  readonly spine: string;
  readonly nameSize: number;
  readonly agentSize: number;
  readonly nameOffset: number;
  readonly agentOffset: number;
}

const WIDE: Layout = {
  id: 'w',
  viewBox: '0 0 880 560',
  meeting: { x: 440, y: 40 },
  // Widened to seat the live dot, the word, and the three platform marks.
  meetingWidth: 200,
  hub: { x: 440, y: 228 },
  hubRadius: 46,
  nodeRadius: 30,
  nodes: [
    { x: 86, y: 396 },
    { x: 288, y: 440 },
    { x: 592, y: 440 },
    { x: 794, y: 396 },
  ],
  edges: [
    'M440,228 C 360,290 190,320 86,396',
    'M440,228 C 402,300 330,390 288,440',
    'M440,228 C 478,300 550,390 592,440',
    'M440,228 C 520,290 690,320 794,396',
  ],
  spine: 'M440,62 L440,228',
  nameSize: 15,
  agentSize: 12.5,
  nameOffset: 52,
  agentOffset: 70,
};

const TALL: Layout = {
  id: 't',
  viewBox: '0 0 400 600',
  meeting: { x: 200, y: 32 },
  meetingWidth: 196,
  hub: { x: 200, y: 156 },
  hubRadius: 40,
  nodeRadius: 26,
  nodes: [
    { x: 84, y: 320 },
    { x: 316, y: 320 },
    { x: 84, y: 470 },
    { x: 316, y: 470 },
  ],
  edges: [
    'M200,156 C 168,206 110,246 84,294',
    'M200,156 C 232,206 290,246 316,294',
    'M200,156 C 116,214 26,340 66,450',
    'M200,156 C 284,214 374,340 334,450',
  ],
  spine: 'M200,50 L200,156',
  nameSize: 15,
  agentSize: 12.5,
  nameOffset: 46,
  agentOffset: 64,
};

/** Seconds. Deliberately not multiples of one another — see note 2 above. */
const PULSE_DURATIONS = [3.1, 4.3, 3.7, 5.1];
const PULSE_DELAYS = [0, 1.4, 0.6, 2.3];
const SPINE_DURATION = 2.9;

function GraphSvg({ layout, className }: { layout: Layout; className: string }) {
  const glowId = `lily-glow-${layout.id}`;

  return (
    <svg
      viewBox={layout.viewBox}
      className={cn('h-auto w-full', className)}
      role="img"
      aria-labelledby={`graph-title-${layout.id} graph-desc-${layout.id}`}
      focusable="false"
    >
      <title id={`graph-title-${layout.id}`}>How Lily routes work in a meeting</title>
      <desc id={`graph-desc-${layout.id}`}>
        A meeting connects to Lily. Lily connects to four teammates — Maya running claude code,
        Dan running codex, Ari running cursor, and Noa running gemini cli. Each agent runs on its
        owner&apos;s own machine.
      </desc>

      <defs>
        <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4.5" />
        </filter>
      </defs>

      {/* Static edges first so the node circles paint over their endpoints. */}
      <g fill="none" stroke="var(--hair)" strokeWidth="1.5">
        <path d={layout.spine} />
        {layout.edges.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>

      {/* Pulses. .motion-only means display:none under prefers-reduced-motion,
          which removes them rather than slowing them. */}
      <g className="motion-only" fill="none" strokeLinecap="round">
        <g stroke="var(--neon)" strokeWidth="5" opacity="0.45" filter={`url(#${glowId})`}>
          <path
            d={layout.spine}
            pathLength={100}
            className="animate-dash"
            style={{ animationDuration: `${SPINE_DURATION}s` }}
          />
          {layout.edges.map((d, index) => (
            <path
              key={d}
              d={d}
              pathLength={100}
              className="animate-dash"
              style={{
                animationDuration: `${PULSE_DURATIONS[index] ?? 4}s`,
                animationDelay: `${PULSE_DELAYS[index] ?? 0}s`,
              }}
            />
          ))}
        </g>
        <g stroke="var(--green)" strokeWidth="2.5">
          <path
            d={layout.spine}
            pathLength={100}
            className="animate-dash"
            style={{ animationDuration: `${SPINE_DURATION}s` }}
          />
          {layout.edges.map((d, index) => (
            <path
              key={d}
              d={d}
              pathLength={100}
              className="animate-dash"
              style={{
                animationDuration: `${PULSE_DURATIONS[index] ?? 4}s`,
                animationDelay: `${PULSE_DELAYS[index] ?? 0}s`,
              }}
            />
          ))}
        </g>
      </g>

      {/* Meeting node — the live dot, the word, then the platforms it can join. */}
      <g>
        <rect
          x={layout.meeting.x - layout.meetingWidth / 2}
          y={layout.meeting.y - 21}
          width={layout.meetingWidth}
          height={42}
          rx={21}
          fill="var(--white)"
          stroke="var(--hair)"
        />
        <circle
          cx={layout.meeting.x - layout.meetingWidth / 2 + 20}
          cy={layout.meeting.y}
          r={4}
          fill="var(--green)"
          className="animate-blink motion-safe-anim"
        />
        <text
          x={layout.meeting.x - layout.meetingWidth / 2 + 32}
          y={layout.meeting.y + 4.5}
          fontFamily="IBM Plex Mono, monospace"
          fontSize={13}
          fill="var(--grey-text)"
        >
          meeting
        </text>
        {PLATFORMS.map((platform, index) => (
          <image
            key={platform.label}
            href={platform.src}
            // Laid out from the pill's right edge so the row stays optically
            // balanced whichever layout's width is in play.
            x={
              layout.meeting.x +
              layout.meetingWidth / 2 -
              16 -
              (PLATFORMS.length - index) * 24
            }
            y={layout.meeting.y - 11}
            width={22}
            height={22}
          >
            <title>{platform.label}</title>
          </image>
        ))}
      </g>

      {/* Lily hub — the one place neon is at full strength, because it is ink. */}
      <g>
        <circle
          className="motion-only ring-breathe animate-breathe"
          cx={layout.hub.x}
          cy={layout.hub.y}
          r={layout.hubRadius}
          fill="none"
          stroke="var(--neon)"
          strokeWidth="1.5"
        />
        <circle cx={layout.hub.x} cy={layout.hub.y} r={layout.hubRadius} fill="var(--ink)" />
        <text
          x={layout.hub.x}
          y={layout.hub.y + 5}
          textAnchor="middle"
          fontFamily="IBM Plex Mono, monospace"
          fontSize={layout.hubRadius / 3}
          fill="var(--neon)"
        >
          lily
        </text>
      </g>

      {/* Teammates */}
      {TEAMMATES.map((teammate, index) => {
        const point = layout.nodes[index];
        if (point === undefined) return null;
        const clipId = `avatar-${layout.id}-${index}`;
        return (
          <g key={teammate.name}>
            <defs>
              <clipPath id={clipId}>
                <circle cx={point.x} cy={point.y} r={layout.nodeRadius} />
              </clipPath>
            </defs>
            {/* Portrait first, hairline ring painted over it so the stroke stays
                crisp regardless of what the supplied image does at its edge. */}
            <image
              href={teammate.avatar}
              x={point.x - layout.nodeRadius}
              y={point.y - layout.nodeRadius}
              width={layout.nodeRadius * 2}
              height={layout.nodeRadius * 2}
              clipPath={`url(#${clipId})`}
              preserveAspectRatio="xMidYMid slice"
            />
            <circle
              cx={point.x}
              cy={point.y}
              r={layout.nodeRadius}
              fill="none"
              stroke="var(--hair)"
              strokeWidth="1.5"
            />
            <text
              x={point.x}
              y={point.y + layout.nameOffset}
              textAnchor="middle"
              fontFamily="Inter Variable, Inter, sans-serif"
              fontSize={layout.nameSize}
              fontWeight={500}
              fill="var(--ink)"
            >
              {teammate.name}
            </text>
            <text
              x={point.x}
              y={point.y + layout.agentOffset}
              textAnchor="middle"
              fontFamily="IBM Plex Mono, monospace"
              fontSize={layout.agentSize}
              fill="var(--grey-text)"
            >
              {teammate.agent}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function RoutingGraph() {
  return (
    <figure className="mt-14 sm:mt-20">
      <GraphSvg layout={WIDE} className="hidden md:block" />
      <GraphSvg layout={TALL} className="mx-auto block max-w-[420px] md:hidden" />
      <figcaption className="mt-6 text-center font-mono text-eyebrow lowercase text-grey">
        every agent runs on its owner&apos;s machine · nothing is uploaded
      </figcaption>
    </figure>
  );
}

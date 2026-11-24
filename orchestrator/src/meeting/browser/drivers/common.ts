/**
 * The join sequence every web client turns out to have.
 *
 * Four platforms, four DOMs, one shape:
 *
 *     open the link → dismiss whatever is covering the page → give a name →
 *     press join → possibly wait to be admitted → be in the call
 *
 * Writing that four times would guarantee four different bugs in it, and the
 * state machine transitions are exactly the part that must not vary — a stall
 * has to mean the same thing on Zoom as it does on Jitsi. So the shape lives
 * here and a driver supplies which selector plays which role.
 *
 * A driver that needs to do something genuinely different still can: `join` is
 * its own method and this helper is a convenience, not a base class.
 */

import type { JoinContext, PageContext } from '../driver.js';
import { JoinStalledError } from '../driver.js';
import { detectRefusal, type Refusal } from '../refusal.js';

export interface StandardJoinPlan {
  /** Selector names to click if they happen to be there. Cookie walls, "continue on web". */
  readonly dismiss: readonly string[];
  /** Where the guest name goes, or null when the URL already carried it. */
  readonly nameInput: string | null;
  /** Things to do after naming and before joining — muting the camera, usually. */
  readonly preJoin: readonly string[];
  readonly joinButton: string;
  /** Shown while waiting for a host to admit. Null when the platform has no lobby. */
  readonly lobbyIndicator: string | null;
  /** Present once we are actually in the call. The definition of success. */
  readonly inCallMarker: string;
  /** Shown when the host refused. Null when the platform has no such state. */
  readonly deniedIndicator: string | null;
}

/**
 * Run it.
 *
 * Every `ctx.*` call names its step, so any selector failure already carries
 * "which step" without this function doing anything else about it. What this
 * adds is the state transitions and the two waits that are not selector
 * failures at all — a lobby nobody answers and a call UI that never renders.
 */
export async function runStandardJoin(ctx: JoinContext, plan: StandardJoinPlan): Promise<void> {
  const { state, timeouts } = ctx;

  state.to('navigating', 'goto');
  await ctx.page.goto(ctx.url, { timeout: timeouts.navigateMs, waitUntil: 'domcontentloaded' });

  for (const name of plan.dismiss) {
    await ctx.clickIfPresent(name, timeouts.probeMs);
  }

  if (plan.nameInput !== null) {
    state.to('name-entry', 'display name');
    await ctx.waitFor('name-entry', plan.nameInput, 'visible', timeouts.interactionMs);
    await ctx.fill('name-entry', plan.nameInput, ctx.botDisplayName);
  }

  for (const name of plan.preJoin) {
    await ctx.clickIfPresent(name, timeouts.probeMs);
  }

  await ctx.click('join', plan.joinButton);

  // A lobby that appears is a person who has to click something. Distinguishing
  // it from a slow page is the whole reason it is a separate state.
  if (plan.lobbyIndicator !== null && (await ctx.present(plan.lobbyIndicator, timeouts.probeMs))) {
    state.to('lobby', 'waiting for admission');

    const outcome = await ctx.race(
      plan.deniedIndicator === null
        ? [plan.inCallMarker]
        : [plan.inCallMarker, plan.deniedIndicator],
      timeouts.lobbyMs,
    );

    if (outcome === null) {
      throw new JoinStalledError({
        driverId: ctx.driverId,
        joinState: state.state,
        stall: state.describeStall(),
        debugPaths: [],
        guidance:
          'Nobody admitted the guest within the lobby timeout. This is a person, not a bug — ' +
          'someone already in the meeting has to accept the request. Admit the participant ' +
          'named in config.meeting.botDisplayName, or start the meeting with the lobby off.',
      });
    }
    if (outcome === plan.deniedIndicator) {
      throw new JoinStalledError({
        driverId: ctx.driverId,
        joinState: state.state,
        stall: state.describeStall(),
        debugPaths: [],
        guidance:
          'The host refused the join request. That is a valid answer and it is final: nothing ' +
          'here retries a refusal.',
      });
    }
  }

  state.to('admitted', 'past the door');
  await awaitInCall(ctx, plan);
  state.to('in-call', 'call UI up');
}

/** How often to check that we are still on the meeting page. */
const NAVIGATION_POLL_MS = 500;

/**
 * Check the DOM for a stated refusal every Nth poll (500ms x 4 = 2s).
 *
 * Throttled because `page.content()` serialises the entire document — half a
 * megabyte on Meet — and doing that twice a second for a minute would be a
 * meaningful drag on the very page we are waiting for.
 */
const REFUSAL_POLL_EVERY = 4;

/**
 * The meeting host, for deciding whether we are still where we were sent.
 *
 * Compared on host alone. The path changes legitimately during a join — Meet
 * appends query parameters, Zoom moves between `/j/` and `/wc/join/` — so a
 * path comparison would cry wolf on every successful join. A change of HOST is
 * unambiguous: nothing about joining a meeting moves you to another site.
 */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Wait for the call UI, but notice if the page leaves first.
 *
 * ===========================================================================
 * WHY THIS IS NOT JUST `ctx.waitFor`
 * ===========================================================================
 * It used to be, and that cost three wrong diagnoses of the same Google Meet
 * failure.
 *
 * When Meet declines a join it shows the reason for about a minute, counts down
 * ("Returning to home screen — 55 seconds left") and then redirects to
 * workspace.google.com. The in-call wait is 60 seconds. So the sequence was:
 * Meet refuses -> we wait -> Meet redirects -> our 60s timeout fires -> we
 * screenshot the MARKETING PAGE. Every capture showed the aftermath. The
 * refusal itself was never once photographed, and the marketing page was read
 * as "bot detection" for two hours because it looked like a bounce.
 *
 * Polling the URL costs one string comparison twice a second and turns a
 * 60-second-late photograph of the wrong page into an immediate one of the
 * right page. The failure it produces also says what it OBSERVED — which host
 * we ended up on — rather than naming a cause it has not checked.
 */
async function awaitInCall(ctx: JoinContext, plan: StandardJoinPlan): Promise<void> {
  const { state, timeouts } = ctx;
  const expected = hostOf(ctx.url);

  let departedTo: string | null = null;
  let refused: Refusal | null = null;
  let settled = false;

  const watchdog = (async (): Promise<void> => {
    let tick = 0;
    while (!settled) {
      await new Promise((resolve) => setTimeout(resolve, NAVIGATION_POLL_MS));
      if (settled) return;
      tick += 1;

      const current = ctx.page.url();
      const host = hostOf(current);
      if (expected !== null && host !== null && host !== expected) {
        departedTo = current;
        return;
      }

      // Look for a stated refusal WHILE IT IS STILL ON SCREEN.
      //
      // The redirect check above is not enough on its own for Meet: it displays
      // the reason for about a minute and only then leaves, and the in-call
      // timeout is also 60s — so by the time either fires, the explanation is
      // gone. This is the only check that can photograph the reason rather than
      // the aftermath.
      //
      // Throttled: page.content() serialises the whole DOM (half a megabyte on
      // Meet), which is far too heavy to do twice a second for a minute.
      if (tick % REFUSAL_POLL_EVERY === 0) {
        try {
          const found = detectRefusal(await ctx.page.content());
          if (found !== null) {
            refused = found;
            return;
          }
        } catch {
          // Page mid-navigation. The next tick will see it, or the URL check
          // will fire; either way this must not become the reported failure.
        }
      }
    }
  })();

  try {
    await Promise.race([
      ctx.waitFor('in-call', plan.inCallMarker, 'visible', timeouts.inCallMs),
      (async (): Promise<void> => {
        await watchdog;

        if (refused !== null) {
          const paths = await ctx.capture('join-refused');
          throw new JoinStalledError({
            driverId: ctx.driverId,
            joinState: state.state,
            stall: state.describeStall(),
            debugPaths: paths,
            guidance:
              `The page stated a refusal while we were waiting for the call UI:\n` +
              `    "${(refused as Refusal).quote}"\n` +
              `  ${(refused as Refusal).meaning}`,
          });
        }

        if (departedTo === null) return;

        // Capture HERE, while the page that explains this is still on screen.
        const paths = await ctx.capture('join-navigated-away');

        throw new JoinStalledError({
          driverId: ctx.driverId,
          joinState: state.state,
          stall: state.describeStall(),
          debugPaths: paths,
          guidance:
            `The page navigated away from the meeting to a different site before the call UI ` +
            `appeared. Expected to still be on "${expected}"; ended up at "${departedTo}".\n` +
            `This is what the join actually did — it is NOT by itself proof of bot detection, ` +
            `and it is not a selector problem. Several platforms show the real reason for about ` +
            `a minute and then redirect, so the captured page above is the explanation; read it ` +
            `before concluding anything.`,
        });
      })(),
    ]);
  } finally {
    settled = true;
  }
}

/**
 * Wake an auto-hiding toolbar before touching it.
 *
 * ===========================================================================
 * WHY THIS IS A SHARED STEP AND NOT A JITSI QUIRK
 * ===========================================================================
 * Every meeting client hides its control bar after a few seconds without
 * pointer movement, because a human watching a call does not want buttons over
 * the video. A driven browser never moves its pointer, so from the moment the
 * call settles the toolbar is *permanently* hidden — and its buttons are still
 * in the DOM, still matched by their selectors, and not hittable.
 *
 * That failure mode is the nastiest kind: the selector is correct, the element
 * is found, and the click times out. Against a live Jitsi meeting it presented
 * as `chatToggle` timing out after 15s while 34s into the call, which reads
 * exactly like a vendor rename and is not one.
 *
 * So: move the mouse over the video area before any toolbar interaction. Two
 * positions, because a single move to a coordinate the pointer is already at
 * produces no event at all — and after a previous reveal, it is.
 *
 * Best effort by design. A browser that cannot move its mouse has larger
 * problems than a hidden toolbar, and this must never be the thing that ends a
 * meeting.
 */
export async function revealToolbar(ctx: PageContext): Promise<void> {
  const { width, height } = ctx.viewport;
  const midX = Math.round(width / 2);
  const midY = Math.round(height / 2);

  try {
    await ctx.page.mouseMove(midX, midY);
    // A second, different position. The first move may be a no-op if the
    // pointer is already there from the last reveal, and a no-op does not reset
    // anybody's hide timer.
    await ctx.page.mouseMove(midX + 24, midY + 16);
  } catch {
    // Nothing here is worth failing a meeting over. If the toolbar stays
    // hidden, the interaction that follows reports "found but not
    // interactable", which names this as the likely cause.
  }
}

/**
 * First non-empty line of text from a set of matches.
 *
 * Every platform's tile label picks up whitespace, presence words and the
 * occasional zero-width character, and every driver needs the same tidy-up.
 */
export function firstMeaningful(texts: readonly string[]): string | null {
  for (const text of texts) {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
}

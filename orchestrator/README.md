# Lily orchestrator

One process, one meeting. It joins a meeting, listens, decides what was
addressed to it, dispatches work to each employee's own coding agent, relays
permission requests through a voice gate, reads unconfirmed items back before
the end, and exits.

Everything above the `MeetingAdapter` boundary is platform-agnostic, and
everything above the `LilyBrain` boundary is model-agnostic. That is not
tidiness: the platform layer is the part most likely to be replaced wholesale,
and the demo has to run with no OpenAI key.

---

## Run the local meeting room

No credentials, no OpenAI key, no Zoom app, no spend.

```bash
npm install
npm run build -w @lily/shared
npm run build -w @lily/orchestrator
node orchestrator/dist/main.js
```

It prints:

```
  Lily's meeting room is up.

    Room       http://127.0.0.1:4100
    Board      http://127.0.0.1:4100/board
    Daemons    ws://127.0.0.1:4101/daemon
    Brain      text
    Agents     4 connected (simulated where no real daemon is attached)
```

Open the room URL, pick who you are from the roster, and type. **Typing stands
in for speech** — it goes through the same classifier, the same dispatch and the
same permission gate that recognised speech does.

Open a second tab as a different person to see it as two participants. The
"End meeting" button triggers the real wrap-up path.

### Things worth trying

| Type this | What should happen |
|---|---|
| `Sarah, how does the login flow work?` | Lily acknowledges immediately, her live status appears under her avatar, and the answer arrives a moment later. |
| `John, make sure you finish the auth refactor by Sunday` | **Nothing is said.** The item appears silently in the right rail as `unconfirmed`, owned by John, due Sunday. |
| `Lily, tell John to fix the build` | Lily says it out loud and logs it as John's — but does not touch John's machine. |
| `John, ask Lily to book the room` | Stays John's. Lily does not book anything. |
| `We should get Lily to schedule that` | Nothing. Being mentioned is not being addressed. |
| `Lily, get my agent to run the migration` | Dispatches to *your own* agent; the agent asks permission; Lily voices it verbatim. Have a **different** participant say "yes" — nothing happens. Then say "yes" yourself. |
| `Lily, put the action items on screen` | The board renders in the screenshare panel as an iframe. |
| End the meeting | Lily reads back every unconfirmed item and flips the ones their owner confirms. |

### Attaching a real Claude Code daemon

The daemon endpoint speaks the wire protocol from
`packages/shared/src/protocol/index.ts` exactly. Point a daemon at
`ws://127.0.0.1:4101/daemon`, send `daemon.hello` with an `employeeId` from the
roster, and that employee's dispatches go to the real agent instead of the
simulator. Everyone else stays simulated.

Set `LILY_SIMULATE_AGENTS=0` to turn the simulator off entirely — the right
setting when testing a real daemon, since with simulation on a daemon that fails
to connect is silently covered for.

### What is simulated, and what is not

Simulated, because it genuinely cannot be present on one laptop:

- **The platform.** Typed text stands in for recognised speech; an iframe stands
  in for a video track. The real platforms need a Linux host with Xvfb,
  PulseAudio and Chrome — see [Platforms](#platforms-joining-through-the-web-client).
  On Windows this room is the supported test path.
- **The other employees' machines.** `LoopbackDaemonLink` answers for anyone
  without a real daemon attached. Its replies are labelled `[simulated agent]`
  rather than invented, because a plausible-sounding fake answer about a
  codebase is worse than an honest placeholder — someone will screenshot it.

Not simulated: the classifier, the permission gate, task memory, turn-taking,
the wrap-up, usage metering, the room's WebSocket server, and the daemon
protocol. Those are the same code paths a Zoom call would run.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LILY_MEETING_PLATFORM` | `local` | `local` \| `jitsi` \| `zoom` \| `meet` \| `teams` |
| `LILY_MEETING_URL` | — | The join link. Required by every platform but `local`. Jitsi also accepts a bare room name. |
| `LILY_BRAIN` | auto | `text` \| `realtime`. Auto picks `text` when the platform cannot carry audio. |
| `LILY_ROOM_PORT` / `LILY_ROOM_HOST` | `4100` / `127.0.0.1` | Local room server |
| `LILY_DAEMON_PORT` / `LILY_DAEMON_HOST` | `4101` / `127.0.0.1` | Daemon WebSocket endpoint |
| `LILY_SIMULATE_AGENTS` | on | `0` disables the loopback agent simulator |
| `LILY_ROSTER_FILE` | built-in demo roster | JSON array of `EmployeeProfile` |
| `LILY_MEETING_ID`, `LILY_ORG_ID`, `LILY_MAX_DURATION_SEC` | — | Set by the launcher |
| `LILY_DISPATCH_DEADLINE_SEC` | `300` | How long a dispatched task may run |
| `LILY_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

Browser platforms only (Linux hosts):

| Variable | Default | Meaning |
|---|---|---|
| `LILY_JITSI_HOST` | `https://meet.jit.si` | Where a bare Jitsi room name is opened. Point it at a self-hosted server. |
| `LILY_ZOOM_HOST` | `zoom.us` | Tenant subdomain, when only a meeting number is supplied |
| `LILY_ZOOM_MEETING_NUMBER` / `LILY_ZOOM_PASSCODE` | — | Alternative to a full Zoom link |
| `LILY_CHROME_PATH` | autodetected | Overrides the Chrome binary the preflight found |
| `LILY_XVFB_DISPLAY` | derived from pid | Display number, so two orchestrators do not collide |
| `LILY_BROWSER_DEBUG_DIR` | OS temp dir | Where a failed join writes its screenshot and page HTML. **Meeting content — set a retention policy.** |
| `LILY_BROWSER_USER_AGENT` | a current Chrome UA | Override rather than hard-code a stale one |
| `LILY_BROWSER_NO_SANDBOX` | off | `1` adds `--no-sandbox`. Only for a container running as root. |

Everything else — timeouts, the pinned model, the bot display name, the
permission window — comes from `config` in `@lily/shared`. Nothing in this
package hardcodes a timeout or a model string.

The Realtime brain needs `LILY_LOCAL_OPENAI_API_KEY` (resolved through the
secrets provider as `lily/<stage>/openai-api-key`). Without it, or with
`LILY_BRAIN=text`, the deterministic brain runs the identical orchestration
logic at zero cost.

---

## Platforms: joining through the web client

Lily joins meetings **in a real browser, as a guest, the way a person does.**
One adapter — `meeting/browser/` — covers Jitsi, Google Meet, Zoom and Teams.
A platform is a `PlatformDriver`: a URL pattern, a selector table, and a click
order. Nothing else differs.

### Why, and what was abandoned

The vendor-SDK route is gone. It was not abandoned because it was hard:

- **Zoom** needs a Marketplace app approved by a human at Zoom for raw data
  access, plus the Meeting SDK for Linux — a native C++ distribution that is
  not on npm and needs a Node binding built against it.
- **Teams** needs tenant admin consent for `Calls.JoinGroupCall.All` and
  `Calls.AccessMedia.All`, Microsoft's media-bot review, and
  `Microsoft.Skype.Bots.Media` — which is **Windows-only .NET with no Node
  binding**. Even with every consent granted, a Linux Node process cannot
  terminate Teams media. That is a platform port, not a missing key.
- **Google Meet** has no bot-participant API at all. The Meet REST API manages
  spaces and post-call artefacts; the Meet Media API is a gated preview for
  *receiving* media; the Add-ons SDK runs inside a human's browser session.

Every one of those is a gate somebody else controls. The web client is the same
meeting, reachable with a URL, and it is how most commercial meeting bots
actually work.

The pieces that were genuinely implementable under the old route are **kept**,
because they are correct and tested and somebody will want them:
`buildZoomSdkSignature` (a real HS256 JWT over Zoom's documented claim set) and
`acquireGraphToken` (Entra ID client credentials). Neither is on the browser
path.

### The terms-of-service position, stated plainly

**Google's and Zoom's terms restrict automated access to their services outside
their published interfaces, and Microsoft's do the same. Joining their web
clients with a driven browser is outside those interfaces. This is an accepted
product risk.**

It is not hidden in a comment. `PlatformDriver.termsRisk` carries it in code,
the adapter logs `browser.terms_risk_accepted` once at construction, and a test
asserts every non-Jitsi driver declares it. Two consequences worth being clear
about:

- Tenant-side enforcement is a real possibility, and it lands on the customer's
  account, not only on ours.
- Teams tenants can forbid anonymous join outright. The driver detects that
  specific refusal and says so, because "your admin switched this off" and
  "Microsoft renamed a selector" go to different people.

**Jitsi is the conflict-free target.** Open source, guests explicitly allowed,
no terms conflict. It is the development and CI platform, and a self-hosted
Jitsi is the recommended deployment for anyone who wants Lily in meetings
without the question at all — same driver, one environment variable.

### Selectors will break

These drivers are built on other companies' DOM. Vendors ship UI changes on
their own schedule; every selector here has a finite lifetime. That is designed
for rather than wished away:

- **One table per driver.** Every selector is in `SELECTORS` in
  `browser/drivers/<platform>.ts`, with a sentence saying what it is for.
  Nothing is inlined in a step. Each value is a comma-separated fallback chain,
  most specific first, so a rename is often absorbed without a code change.
- **Failures name the step, the selector, and *which kind* of failure.** A
  `SelectorFailureError` reports one of two diagnoses, because they need
  opposite fixes:

  | `resolution` | Means | Fix |
  |---|---|---|
  | `not-found` | Nothing in the DOM matched | The vendor moved it. Edit the driver's `SELECTORS` table. |
  | `not-interactable` | Matched *n* elements; the click still would not land | **Not** a selector change. An auto-hiding toolbar, an overlay, or something mid-animation. |

  Collapsing those was a real cost: an auto-hidden Jitsi toolbar produced a
  message that read as a vendor rename, for a table that was correct.
- **Toolbars auto-hide, and a driven browser never moves its pointer.** Every
  client fades its controls out after a few idle seconds, leaving the buttons in
  the DOM and unhittable — permanently, for a bot. `revealToolbar()` in
  `drivers/common.ts` moves the mouse over the video area before any toolbar
  interaction. It is shared across all four drivers because all four do this.
- **Page evidence lands on disk, captured at the moment of failure** — while the
  page is still open, not at teardown. Screenshot plus page HTML to
  `LILY_BROWSER_DEBUG_DIR`, capped at five per meeting so one broken selector
  cannot fill a disk on retries. Never to Mongo, never into a log line (the log
  records paths and byte counts only). **That directory is meeting content — set
  a retention policy on it.** The provisioning script installs a logrotate rule
  that keeps three days.
- **An explicit join state machine.** `navigating → name-entry → lobby →
  admitted → in-call → left`. A stall reports *where*: "stalled in `lobby` for
  92s" is a host who has not clicked admit; "stalled in `name-entry`" is a
  vendor who moved a field. Google Meet's "asking to be let in" is that lobby
  state — surfaced with its own message and its own timeout, never treated as a
  hang.

The most fragile selector in each driver is flagged as such in its `what` text.
For Meet and Zoom it is the active-speaker marker; both platforms ship
generated class names for it.

### How it runs

| Piece | Why |
|---|---|
| **Headful Chrome in Xvfb** | Headless is detected, by Meet especially, and it fails as a half-working page rather than a clean refusal. `--headless` is never passed; a test asserts that. |
| **Google Chrome, not Chromium** | Meet gates behaviour on the branded build and its user agent. `playwright-core` is the dependency precisely because it downloads no browsers. |
| **PulseAudio, two null sinks** | Chrome renders the room into `lily_out_*`; audio is captured from its `.monitor` with `parec` and streamed to the Realtime session. Lily's PCM is played with `pacat` into `lily_micsink_*`, remapped to a source, and selected as Chrome's microphone. Two sinks, not one — a single loopback would feed Lily her own voice and she would interrupt herself forever. |
| **`--use-fake-ui-for-media-stream`** | Auto-grants the mic/camera prompt, which nobody is there to click. |
| **Never `--use-fake-device-for-media-stream`** | It emits a test tone. It is a WebRTC plumbing test, not an audio path. A test asserts it is absent. |
| **A camera** | Several platforms treat a camera-less participant differently — smaller tile, different grid position, sometimes no tile at all until they speak. No tile means no active-speaker highlight to read. `v4l2loopback` + ffmpeg gives a live card that shows work in progress; without the kernel module it falls back to a static y4m. |
| **Screenshare** | A second window serves the action-item board from 127.0.0.1 with a title unique to this meeting, and `--auto-select-desktop-capture-source` answers the picker with it. Torn down with the share and at `leave`. |

### Active speaker, and the permission gate

Every platform marks who is currently speaking, because it has to draw the ring
round their tile. The adapter reads that out of the DOM and resolves it against
the roster. **This is better attribution than diarizing a mixed audio stream** —
it is the platform's own per-track answer rather than our guess at one.

It matters because the permission gate accepts only the owning employee's own
spoken "yes". So the rule is absolute:

> **An unidentified speaker is `employeeId: null`. Always. Never a guess.**

Unknown name → null. Ambiguous name (two Sarahs) → null. No highlight → null.
Lily's own tile → not an utterance at all. The gate treats null as "not a known
employee", so every uncertainty resolves towards denial. `speaker.test.ts` is
that property, case by case.

The highlight is debounced (`SpeakerTracker`) because every client toggles it on
breath noise; without that, a sentence gets attributed to whoever coughed in the
middle of it.

### Consent

- The participant name is `config.meeting.botDisplayName`, which must read
  unmistakably as an AI, and it is in the participant list from the moment she
  joins.
- **She announces herself in chat on joining**, in addition to whatever she says
  out loud. Chat survives a muted microphone and someone who joined late.
- **She stays kickable.** Removal is polled for and treated as a normal `leave`
  with reason `kicked`. There is no rejoin, ever: the flag latches and `join()`
  refuses afterwards. A bot that comes back after being removed is not a
  participant.

### Provisioning

```bash
sudo orchestrator/scripts/provision-browser-host.sh
sudo orchestrator/scripts/provision-browser-host.sh --verify
```

Installs Xvfb, PulseAudio, ffmpeg, fonts, Google Chrome from Google's
repository, and v4l2loopback where the kernel allows. Idempotent and
non-interactive, for a Packer/AMI build.

**This needs Linux.** Xvfb, PulseAudio and v4l2loopback do not exist on the
Windows dev machine in the form this uses, and the adapter's preflight fails at
**construction** saying so — it does not crash mid-join. On Windows, the
simulated local room remains the test path:

```bash
LILY_MEETING_PLATFORM=local node orchestrator/dist/main.js
```

`jitsiPreflight()` / `meetPreflight()` / `zoomPreflight()` / `teamsPreflight()`
answer the question programmatically. They now report *packages an operator can
install*, which is a far better failure than the vendor approvals they used to
report.

---

## Architecture

```
main.ts
 └── MeetingSession ......... the whole policy. Identical under both brains.
      ├── MeetingAdapter .... local | BrowserMeetingAdapter
      │    └── PlatformDriver ... jitsi | meet | zoom | teams
      │         (URL patterns + one selector table + a click order. Nothing else.)
      ├── LilyBrain ......... RealtimeBrain (speech↔speech) | TextBrain
      ├── classify() ........ the act / don't-act decision
      ├── TaskMemory ........ in-RAM, meeting-scoped
      ├── PermissionRelay ... the voice gate
      ├── SpeechScheduler ... turn-taking and barge-in
      ├── DaemonLink ........ ws | loopback | composite
      └── UsageMeter ........ Lily's consumption only
```

### The two brains run the same code

`LilyBrain` is Lily's **senses and voice**, not her judgement. Deciding whether
a sentence was addressed to her, whether to touch someone's machine, and who may
approve what all live in `MeetingSession`, reached through `BrainHooks`.

`TextBrain.hear()` and `RealtimeBrain.hear()` make the same two calls in the
same order: `hooks.classify()` then `hooks.apply()`. `BrainHooks` deliberately
has no method that lets a brain dispatch a task, deny a permission or write a
task directly.

That is what makes `TextBrain` a real implementation rather than a mock — it is
the realtime path with the model's ears and mouth removed. A classification bug
exists in both, and the text tests catch it.

The realtime brain's model does get tool calls, and they are **reconciled**
against the deterministic classifier in `brain/route.ts`:

- The classifier owns the **act / don't-act** axis. A model that decides
  "John, make sure you finish the auth refactor" is a job for it gets vetoed.
- The model may **refine within a class** — picking a better recipient for a
  question that is definitely being routed. That cannot cause an unasked-for
  action; it can only change who gets asked something read-only.

Every veto is logged as `brain.intent_vetoed`.

### The classifier's bias, stated explicitly

Two errors are possible and they are not symmetric:

> Missing an instruction meant for Lily costs the speaker one repetition.
> Acting on an instruction meant for a human is the worst failure this product
> has.

So every ambiguous case resolves *away* from `lily_action`, and the rules are
deliberately asymmetric about it:

- A bare leading name is enough to address a human (`John make sure ...`). It is
  **not** enough to address Lily — she additionally needs a comma, a greeting,
  an `@`, or a direct-address verb behind her name.
- Being *mentioned* is never being *addressed*.
- An instruction addressed to a human stays addressed to that human even when it
  names Lily inside it.
- `human_assignment` is silent and reversible, so the classifier reaches for it
  freely. `lily_action` is neither, so it must be earned.

### Permissions

1. **Hard-blocked kinds are never voiced.** There is no phrasing of them a room
   could approve, so offering them out loud would teach people that pressure
   works. They are refused before anyone hears about them.
2. **One request is voiced at a time.** A queue of spoken yes/no questions is
   how the wrong "yes" lands on the wrong question.
3. **Only the owning employee's answer counts.** A colleague's "yeah go for it"
   is not treated as input at all — it neither approves nor denies, so the owner
   can still answer. If the window closes having heard only a bystander's
   approval, the denial is recorded as `wrong_speaker` rather than `timeout`.
4. **Silence and hedging deny.** Every path out of the relay that is not an
   explicit "yes" from the owner ends in `approved: false`.

`selfRequestImpliesApproval` is applied narrowly: the prompt is skipped only
when the command appears **verbatim** inside what the owner just asked for.
Anything looser would be the orchestrator deciding, on a similarity judgement,
that someone consented to a command they never said.

### Usage metering

Billable — Lily's own consumption: Realtime audio seconds, her reasoning
tokens, TTS characters, web searches, orchestrator runtime.

**Never billable — the employee's agent.** Claude Code, Codex or Cursor running
on someone's laptop against their own subscription. We do not pay for those
tokens, we cannot see them, and a customer must never be charged for them. A
dispatched task that occupies a developer's machine for four minutes adds
exactly zero.

Enforced structurally, not by convention: `noteDispatch()` and
`noteDispatchComplete()` take no cost arguments and increment only a
non-billable counter. There is no method on `UsageMeter` that can add
employee-side consumption to a bill.

Slices flush every `config.meeting.usageFlushIntervalSec`, so a crash loses at
most one interval.

### Transcripts

Meeting speech exists in memory for as long as it takes to classify and respond,
and is then dropped. It is never written to Mongo, never logged, and leaves the
process only as the `text` of a `task.dispatch` the speaker asked for.

Two structural defences beyond the comments:

- `MeetingOutcomeSink` has exactly three methods — tasks, summary, audit. There
  is no `recordUtterance`, so there is no way for this process to hand a
  transcript to anything.
- `util/log.ts` takes a fixed event name plus scalar fields only. There is no
  `log.info(someText)` overload that would make piping an utterance to stdout
  easy, and CloudWatch retains stdout.

The end-to-end test asserts this directly: a chatter line, the agent's answer and
Lily's own speech must not appear anywhere in what the session hands over.

---

## Tests

```bash
npx vitest run orchestrator
```

- `classify.test.ts` — a table of realistic utterances, plus a block that
  asserts the load-bearing invariant across every phrasing: **nothing addressed
  to a human ever classifies as `lily_action`.**
- `permissions.test.ts` — only the owner's approval counts; a third party's
  "yes" does nothing; timeout denies; hedging denies; hard-blocked is never
  voiced; one at a time; the narrow self-request rule.
- `session.e2e.test.ts` — a whole meeting: real HTTP server, real WebSocket
  clients, real classifier, real gate, and a fake daemon. Asserts the full loop
  and that no transcript is persisted.
- `meeting/adapters.test.ts` — every platform fails at construction naming the
  packages it is missing; preflight separates the OS (a blocker) from packages
  (missing); the URL rewrites; every driver declares its selectors and its terms
  position; and the Zoom signature is still a valid JWT.
- `meeting/browser/state.test.ts` — the join state machine moves forward only,
  and a stall names the state it stalled in.
- `meeting/browser/speaker.test.ts` — speaker → employee, and every uncertain
  case (guest, ambiguous first name, no highlight, Lily's own tile) producing
  `null`.
- `meeting/browser/adapter.test.ts` — a full join against a fake Playwright
  page: the state machine, selector-failure messages, debug capture, the lobby
  stall, the consent announcement, kick handling and no-rejoin, and the Chrome
  flags (no `--headless`, no fake audio device).

**No test needs a network, a display server or a real meeting.** The browser
tests run on Windows.

`npx tsc -b` and `npx eslint .` must pass clean from the repo root.

---

## Suggested additions to `packages/shared`

Not made here — `packages/shared` is another agent's scope. Each is currently
worked around locally and marked at the call site.

1. **`config.meeting.dispatchDeadlineSec`.** How long a dispatched task may run
   before the daemon gives up. Currently injected into `MeetingSession` and
   defaulted to 300 in `main.ts`. It is policy and belongs with the other
   timeouts.
2. **`config.meeting.wrapUpConfirmationTimeoutSec`.** The wrap-up read-back
   currently reuses `config.permissions.voiceApprovalTimeoutSec`, on the
   argument that "did a specific person say yes out loud?" should not have two
   different answers. Defensible, but it should be a deliberate alias rather
   than an accident.
3. **`config.billing.usageWeights`.** The token-normalisation coefficients live
   in `USAGE_WEIGHTS` in `usage.ts`. They determine margin and belong beside the
   plan allowances.
4. **A speaker-attribution field on the protocol.** The Realtime session does not
   diarize, so the adapter supplies the active speaker: it is read out of the
   platform's DOM, resolved against the roster, and handed to the brain through
   `LilyBrain.noteSpeaker`. That is solved *inside this package*. What is still
   missing is a description of it in `packages/shared` — the permission gate's
   correctness rests on it, and the wire contract does not mention it.
5. **A streaming variant of `MeetingAdapter.speak`.** `RealtimeBrain.render()`
   buffers a full utterance before returning, because `speak` takes a complete
   `SpeechOutput`. The browser adapter *could* consume a stream — it writes PCM
   straight to a pipe — so this is now worth doing rather than hypothetical.
6. **`config.meeting.browser`.** The browser adapter's tunables — step timeouts,
   the speaker poll interval and debounce window, the video mode, the screen
   size — are constants at the top of `meeting/browser/adapter.ts` because
   `config.meeting` has no field for them. Every one of them is policy.

---

## Dependencies

One was added for the browser adapter:

- **`playwright-core` ^1.62** — the browser driver. Deliberately `playwright-core`
  and not `playwright`: the latter downloads Chromium, Firefox and WebKit on
  install, hundreds of megabytes of browsers we do not want, of a build we do
  not want. This needs **Google Chrome** from Google's repository, which the
  provisioning script installs. `playwright-core` downloads nothing.

  It is still imported dynamically, in `browser/launch.ts` only, so the
  orchestrator loads on a machine without it and reports the absence through the
  preflight instead of failing at module resolution.

It is a large-ish install regardless (`playwright-core` is a few tens of MB of
driver), and it lands in every `npm ci` including the Windows dev machine's.

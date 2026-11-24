# Testing Lily locally

Every command here was run on Windows with Node 25 and Docker 26 before this file
was written. Where something does not work yet, it says so rather than pretending.

---

## Step 0 — one-time setup

```bash
cd G:\XplaceProjects\callAgent-zoom
npm install
```

---

## Step 1 — does it build?

```bash
npm run typecheck
npm test
```

Expect `exit 0` and **271 tests passing across 15 files**. This alone exercises task
classification (47 tests), permission gating (43), the auth token rotation and
reuse-detection path (15), the browser join state machine and speaker attribution
(54), and a simulated meeting end to end.

---

## Step 2 — the database layer

```bash
npm run db:up
npm run db:verify
```

`db:up` starts MongoDB in Docker as a **single-node replica set** — not a standalone,
because refresh-token rotation needs multi-document transactions and a standalone
would let that code pass locally and fail in every deployed stage.

`db:verify` runs 13 checks against the real database: TTL indexes registered for
retention, `audit_log` deliberately having no TTL, duplicate `employeeId` rejected
within an org but allowed across orgs, and the data-policy guard blocking a
transcript smuggled into the `summary` field.

Stop it later with `npm run db:down`.

---

## Step 3 — the marketing site

```bash
npm run dev -w web
```

Open **http://localhost:5173**.

Worth checking: the routing graph pulses without marching in time, the cookie banner
gives reject-all equal weight to accept-all, and nothing loads from Google or PostHog
before you accept (Network tab, filter `google`).

The logos are **placeholders** — see `web/public/brand/README.md`.

---

## Step 4 — the meeting room

```bash
npm run build -w @lily/shared
npm run build -w @lily/orchestrator
node orchestrator/dist/main.js
```

Open **http://127.0.0.1:4100**, pick a person, and type. Typing stands in for speech.

Try these three, in order — they are the whole product:

| Type this | What should happen |
|---|---|
| `John, make sure you finish the auth refactor by Sunday.` | Lily says **nothing**. A silent `unconfirmed` card appears with John as owner and Sunday's date. |
| `Lily, what have you got for me?` | She answers out loud — a direct request to her. |
| `Sarah, how does the login flow work?` | Dispatched to Sarah's agent, live status under Lily's avatar, answer spoken when it returns. |

The first one is the hardest requirement in the product: she must never act on an
instruction addressed to a human.

No OpenAI key is needed — this runs the text brain, which uses the identical
classification and dispatch path as the voice brain.

---

## Step 5 — connect your own Claude Code

This is the real thing: a task from the meeting running on your machine, in your
repo, under your permissions.

**1. Write `~/.lily/config.json`:**

```json
{
  "employee_id": "emp_sarah",
  "org_id": "org_local_demo",
  "ws_url": "ws://127.0.0.1:4101/daemon",
  "device_token": {
    "backend": "file",
    "value": "local-demo-token-not-a-real-credential",
    "insecure": true
  },
  "workspace": "G:/XplaceProjects/callAgent-zoom",
  "ui_port": 4111,
  "dnd": false
}
```

`emp_sarah` is the backend engineer in the demo roster who owns the login flow, so
questions about auth route to her.

**2. Check it:**

```bash
node daemon/dist/index.js doctor
```

Expect it to resolve your config, find **Claude Code**, and **warn that the token is
stored without OS protection**. That warning is correct and expected here — the file
backend is the unprotected fallback, and it is meant to be loud.

**3. Start the meeting (step 4), then the daemon:**

```bash
node daemon/dist/index.js run
```

Watch for `connection.open employeeId=emp_sarah`. On the orchestrator side you should
see `daemon_link.real_agent connected=true` — it has swapped from its simulator to
your real agent, for Sarah only.

Your daemon's own status page is at **http://127.0.0.1:4111**, including the
Do-Not-Disturb toggle. DND is yours; no admin can override it.

**4. In the room, ask `Sarah, how does the login flow work?`**

Your real Claude Code runs it. The daemon logs
`agent.run_start tools=Read,Grep,Glob` — the read-only profile, enforced by the CLI
itself, so the agent physically cannot mutate anything rather than being asked not to.

> **This spends your own Claude quota.** That is by design: the customer is never
> billed for an employee's agent usage, only for Lily's own runtime.

---

## Step 6 — join a real meeting (Docker)

The browser adapter needs Xvfb, PulseAudio and a real Google Chrome, none of which
exist on Windows. Docker Desktop on the WSL2 backend supplies all three, and the
image is the same artefact that runs in production — so "works locally" and "works
on the box" stop being separate claims.

Two things make this work in a container that people expect to be blockers, and
aren't: **PulseAudio needs no sound hardware**, because every device here is a null
sink; and **Xvfb means no display is needed**, because Chrome runs headful into a
virtual framebuffer. Headful matters — headless is detected by Meet and Zoom.

```bash
docker compose --profile browser build orchestrator
docker compose --profile browser run --rm --no-deps orchestrator bash -lc 'google-chrome-stable --version && pactl info | head -1'
```

Then join a real room. Jitsi is the right first target: open source, guests are
explicitly allowed, and no terms conflict.

```bash
docker compose --profile browser run --rm --no-deps \
  -e LILY_MEETING_PLATFORM=jitsi \
  -e LILY_MEETING_URL="https://meet.jit.si/lily-test-$RANDOM" \
  orchestrator node orchestrator/dist/main.js
```

Open the same URL in your own browser and you should see her join. The log line to
watch for is the state trail:

```
browser.joined  trail="idle>navigating>name-entry>lobby>admitted>in-call"
```

Verified working on Windows 10 + Docker Desktop 26.1.1 (WSL2), Chrome 150.

When a selector breaks — and it will, when a vendor ships a UI change — the error
names the step, the selector, how long it had been in that state, and which table
entry to edit. Every selector for a platform lives in one `SELECTORS` object in
that driver.

`LILY_MEETING_PLATFORM` also accepts `meet`, `zoom` and `teams`. Those drivers are
written but have never been run against a live meeting, and their active-speaker
selectors depend on generated class names, so expect to fix selectors from the
failure messages.

---

## Known gaps

**Keep talking while you wait for an answer.** The silence timer does not currently
account for in-flight dispatched work, so a quiet room can end the meeting before a
slow agent replies. Reproduced: dispatch at 16:41:39, session ended `endReason:
"silence"` at 16:46:39 with the answer still outstanding.

**The config above is written by hand.** `lily-daemon enroll --token <token>` posts to
`/daemon/enroll`, and the REST API does not exist yet. Wiring the daemon straight to
the orchestrator is the current path.

**There is no `dev:local` yet.** Start the pieces individually as above.

**The orchestrator's daemon port does not authenticate.** It binds to loopback and
identifies the daemon by whatever `daemon.hello` claims. Fine for local; it must not
ship as the deployed path.

**Real meeting platforms work — in Docker.** See step 6.

**No dashboard, emails, or billing yet.**

---

## Cleanup

```bash
npm run db:down
```

Stop the daemon and orchestrator with Ctrl-C. The daemon leaves
`~/.lily/config.json` behind — delete it to reset enrollment.

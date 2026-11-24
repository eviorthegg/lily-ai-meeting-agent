# Security model

Lily causes commands to run on employees' machines. That is the whole product, and it
is also the threat. This document states what protects that, and — as importantly —
what does not.

Where something is not yet implemented, it says so. A security document that
describes intentions as though they were controls is worse than no document.

---

## Threat assumptions

1. **A compromised admin account is the worst case.** An attacker holding admin can
   invite themselves, generate install tokens, and dispatch tasks to real machines.
   Hence mandatory MFA for privileged roles and step-up re-verification on the actions
   that matter.
2. **Employees are not adversaries, but their machines are exposed.** The daemon runs
   with the employee's own permissions and repo access. The controls limit what a
   *meeting* can cause, not what the employee can do themselves.
3. **The meeting room is semi-trusted.** Anyone in the call can speak. Voice is not
   authentication, which is why only the *owning* employee's approval counts for their
   own agent, and why unidentified speakers are treated as not-an-employee.
4. **The orchestrator is disposable and hostile-adjacent.** It runs a browser against
   third-party meeting sites. It is per-meeting, least-privilege, in a private subnet,
   and self-terminating.
5. **We are not trusted with company content.** Transcripts, code and agent output
   never reach our database. This is enforced structurally, not by policy.

---

## Token model

### Access tokens
JWT, **15 minutes**, signed with `lily/{stage}/jwt-signing-key` from Secrets Manager.
Short enough that theft has a bounded window; long enough to avoid refresh storms.

### Refresh tokens — rotation with reuse detection
Opaque random values, never JWTs. Only `sha256(token ‖ pepper)` is stored, where the
pepper is `lily/{stage}/token-pepper`.

Every exchange consumes the presented token and issues a new one **in the same
family**. If an already-consumed token is presented again, that is replay: **the entire
family is revoked**, not just that token.

The whole family, because at that moment the attacker and the legitimate client are
indistinguishable — one of them replayed, and we cannot tell which. Revoking both and
forcing re-authentication is the only safe resolution.

Consume-and-issue runs in a **MongoDB transaction**. Local development runs a
single-node replica set specifically so this path is exercised rather than skipped.

### Device tokens (daemons)
Same hashing. Rotate on a schedule (default 24h, `config.auth.deviceTokenRotationSec`)
**and on every reconnect**. `previousTokenHash` is retained so a superseded token is
recognised as superseded rather than merely unknown.

Rotation is awaited before the next reconnect can proceed, so a rotation cannot race
the reconnect that would then present the stale token.

### Install tokens
Single-use, 24h expiry, consumed on enrollment. A replay returns **410 Gone**. TTL is
enforced by a database index, not only by application code.

### What is never stored
Raw tokens do not touch the database or any log line. They exist exactly once, in the
response that issues them.

> **Rotating `token-pepper` invalidates every daemon enrollment in that stage.** Treat
> it as permanent. There is no re-peppering migration.

---

## Authentication

- Passwords: **Argon2id**, OWASP baseline (m=19 MiB, t=2, p=1), with `needsRehash` so
  parameter upgrades migrate on next login. Length-first policy, checked against a
  breached-password list, no forced-rotation theatre.
- **MFA is mandatory for owner, admin and manager** — enforced server-side, not a
  setting those roles can disable. WebAuthn/passkeys are the intended primary method
  with TOTP as fallback. **No SMS**: SIM-swap makes it unfit for this threat model.
- Backup codes: shown once, hashed at rest, single-use.
- **Step-up re-verification** regardless of an active session before: adding or
  removing an employee, rotating tokens, changing permission policy, changing billing,
  exporting the audit log, generating an install token.
- Roles are enforced server-side. A client cannot assert its own role.

---

## Permission model — what a meeting can cause

Meeting-dispatched tasks run under a restricted profile, separate from the employee's
own interactive session. Actions map onto a **closed vocabulary** (`ActionKind` in
`packages/shared/src/protocol/`). A closed set is what makes the policy auditable — a
free-text action string could not be reasoned about, and "run tests" and "delete the
repo" would be indistinguishable to the gate.

| Tier | Kinds | Behaviour |
|---|---|---|
| **auto** | `read` `search` `vcs_read` | Proceeds silently |
| **gated** | `write` `shell` `test` `install` `network` | Voiced in the meeting, blocks until answered |
| **blocked** | `vcs_push_protected` `delete` `deploy` `credential_access` | Refused locally, **never voiced** |

Three properties worth stating explicitly:

**Hard-blocked actions never generate a permission request.** Voicing them would train
people to approve destructive operations, and a socially pressured "yes" in front of
colleagues could delete a repository.

**Classification fails toward the strictest plausible tier.** An unrecognised command
is `shell` (gated), never `read`. A misclassification that gates a harmless action
costs one spoken question; the reverse silently runs something nobody approved.

**Chained commands take the strictest kind present.** `npm test && rm -rf .` is
`blocked`, not `test`. Command substitution (`$(…)`) is treated as unrecognised because
it can hide anything.

### Approval rules
- Only the **owning employee** may approve their own agent. Nobody else's "yes" counts.
- Ambiguous or absent responses **deny** after 45s.
- One request is voiced at a time; the rest queue.
- Lily repeats back verbatim what she is approving before relaying it.
- Every decision — granted, denied, timed out — is written to the audit log with who,
  what, when and which meeting.

### Self-requested actions
When an employee asks Lily out loud to do something on **their own** agent, that spoken
request is the approval for the action they named. It covers `write` and `network`
only — a calendar booking implies a write and the call to perform it.

It deliberately does **not** cover `shell`, `test` or `install`. No sentence spoken in
a meeting implies "and run arbitrary commands on my laptop". This is the boundary
between honouring intent and letting one sentence authorise anything.

---

## Data policy

**Never stored:** meeting audio or video, full transcripts, source code, file contents,
raw agent output, repo contents, credentials to employee systems.

**Stored:** org and user records, hashed tokens, meeting *metadata*, short task text,
the meeting summary, audit entries, billing state, consent records.

Task text and the summary are the only derived content, retained because the summary
email and the dashboard cannot exist without them. Per-org retention, default 90 days,
with a hard-delete endpoint.

Three mechanisms enforce this:

1. **TTL indexes on `purgeAfter`** — the database deletes on schedule whether or not
   our code runs. `audit_log` is deliberately exempt: it is the record of who
   authorised what and must outlive what it describes.
2. **`assertNoForbiddenContent()`** on write paths — forbidden field names plus hard
   length caps. Deterministic by design: an earlier draft used a heuristic to detect
   "this looks like a transcript" and it was removed, because a fuzzy classifier in a
   write path fails by silently rejecting legitimate data in production.
3. **An ESLint rule** rejecting forbidden field names at author time.

The **meeting join URL is treated as a credential** — anyone holding it can enter the
call. It is passed to the orchestrator in a signed single-use payload and never
persisted; `meetingUrl` is in the forbidden field list.

Lily never has credentials to any employee system. "Book a meeting" is a task
dispatched to the employee's own agent, performed through *their* MCP servers with
*their* credentials.

---

## Isolation

- A device token authorises exactly **one** employee's daemon. A task addressed to
  Employee B can never reach Employee A's agent — dispatch resolves by `employeeId`
  scoped to org, and identity comes from the connection record, never from the frame.
- Removing an employee revokes their tokens and **kills the live WebSocket connection**,
  targeting under 5 seconds.
- The daemon connects **outbound only**. No inbound port, works behind NAT.
- Orchestrator instances: least-privilege IAM role, private subnet behind NAT,
  terminate-on-shutdown, hard duration cap enforced by an OS-level watchdog as well as
  the application.

---

## Consent

The bot appears in the participant list under a name that identifies it as an AI,
announces itself on joining, and is kickable by the host at any time — removal is a
normal leave path and **never** triggers an automatic rejoin. Recording and
AI-participation law varies by jurisdiction; the dashboard surfaces a consent notice
when a meeting is scheduled and logs the acknowledgement.

---

## Known gaps — not yet true

Listed because omitting them would make this document dishonest.

- **WebAuthn is not implemented.** TOTP and backup codes exist; passkeys, the intended
  primary method, do not. MFA gating of the dashboard is therefore incomplete.
- **The orchestrator's local daemon port does not authenticate.** It binds to loopback
  and trusts whatever `daemon.hello` claims. Acceptable for local development; it must
  not ship as the deployed path.
- **mTLS / signed request bodies** between daemon and API are specified but not built.
  Transport is TLS only.
- **Rate limiting and lockout state is per-process.** `api/src/auth/rate-limit.ts`
  enforces exponential backoff on password logins and on code entry, in memory. That is
  honest for a single API process; behind more than one it becomes per-instance and the
  effective limit multiplies by the instance count. Moving it to a shared store is the
  first thing to do before scaling out horizontally.
- **The browser meeting adapter drives third-party sites.** Chrome keeps its sandbox
  (the container adds `SYS_ADMIN` rather than passing `--no-sandbox`), but it is a
  browser visiting URLs we do not control. Per-meeting disposable instances are the
  mitigation.
- **No SOC 2, no penetration test.** Say the specific true things above rather than
  "bank-level security", which is unverifiable and invites scrutiny it cannot survive.

---

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on this
repository. Please do not open a public issue. Include reproduction steps and what
you were able to access.

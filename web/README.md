# @lily/web

The marketing site, the signup flow, and the authenticated dashboard. React + Vite + TypeScript +
Tailwind, deployed to **AWS Amplify Hosting**.

Amplify is used for hosting only. No Amplify backend, no DataStore, no GraphQL tooling, no
Cognito — authentication is the Lily API's own JWT layer.

## Running it

```bash
npm install          # from the repo root; web is a workspace
npm run dev -w web   # http://localhost:5173
```

The port is fixed at 5173 because the API's CORS allowlist is built from `LILY_WEB_BASE_URL`,
whose local default is that address.

```bash
npm run build -w web   # production bundle into web/dist
npx tsc -b web         # typecheck only
npm run preview -w web # serve the built bundle
```

### There is no API yet

`VITE_LILY_API_MODE` defaults to `mock` outside prod, so signup, verification, org creation and
invites all work against an in-memory fixture. The whole flow is clickable today. Screens that
depend on it show a `demo mode` note so nobody mistakes the fixture for a backend.

Switching to the real API is one environment variable — `VITE_LILY_API_MODE=http` — and touches
no component. Both adapters implement the same `LilyApi` interface in `src/lib/api/types.ts`.

Useful mock facts: the email verification code is always `123456`, and passwords must be at
least 12 characters.

## The dashboard

Everything under `/app` is the authenticated manager dashboard: **Team**, **Meetings** (with a
per-meeting detail view), **Tasks**, **Audit log**, **Settings**, and an owner-only **Analytics**
view. `/mfa` is the enrollment gate that stands in front of all of it for privileged roles.

**Reaching it in dev.** Run `npm run dev -w web`, go to <http://localhost:5173/login> and sign in
as one of the three seeded accounts. The password for all of them is `lily-demo-password`:

| Account                | Role     | What it demonstrates                                          |
| ---------------------- | -------- | ------------------------------------------------------------- |
| `maya@northwind.test`  | Owner    | The whole dashboard, including Analytics                       |
| `ari@northwind.test`   | Manager  | No Analytics; Settings is read-only and the API refuses writes |
| `noa@northwind.test`   | Employee | Stopped at the gate with an explanation, not a redirect loop   |

The owner and manager accounts start **un-enrolled**, so the first thing either sees is the MFA
gate. Any six digits enrol except `000000`, which exists to exercise the rejection path. There is
no session persistence — the access token is held in memory, so a hard refresh returns you to
login. Navigate with the in-app links.

Everything on these screens is served by the mock adapter. Nothing here has a REST endpoint behind
it yet; see "There is no API yet" above.

### Live presence

The team table and the task list update over a WebSocket rather than polling. In mock mode a
scripted transport in `src/lib/live/transport.ts` emits presence and `agent.status` frames, and
the **Drop socket** button in the header (mock builds only) kills it so the degraded path can
actually be seen: presence badges become "Was online · last known …" with a timestamp, and the
summary badge says "presence not live". A stale green "Online" badge is the one state this layer
exists to make impossible.

Against a real stage the client connects to `VITE_LILY_WS_BASE_URL` + `/dashboard`. That route
does not exist yet — the deployed WebSocket API serves the daemon protocol only — so it will fail
to connect and degrade, which is correct behaviour rather than a bug to work around.

## Environments

Amplify branch-based deploys. Environment variables are set per branch **in the Amplify
console** and are never committed.

| Environment | Branch   | `VITE_LILY_STAGE` | API                            |
| ----------- | -------- | ----------------- | ------------------------------ |
| Staging     | `dev`    | `dev`             | `https://api-dev.lily.example.com`  |
| Production  | `main`   | `prod`            | `https://api.lily.example.com`      |

The `lily.example.com` addresses are placeholders (`example.com` is reserved and can never be registered). Point a deploy at your own domain with `VITE_LILY_API_BASE_URL` and `VITE_LILY_WS_BASE_URL` here, and `LILY_WEB_BASE_URL`, `LILY_API_BASE_URL` and `LILY_WS_BASE_URL` for the backend.

Staging and production are **separate Amplify applications**, not two branches of one app.
Sharing an app means sharing the domain, the redirect rules and the environment-variable
namespace, and one careless console edit reaches production. Two apps cost nothing extra.

Staging should also have password protection enabled (Amplify console → Access control) so an
unfinished page cannot be indexed or found.

Every `VITE_*` variable is inlined into the JavaScript bundle at build time and is readable by
anyone who loads the page. Only publishable identifiers belong in them. See `.env.example`.

### SPA rewrite — required

A deep link like `/signup` returns 404 on a hard refresh without it, because only `index.html`
exists on the origin. Amplify does not read redirect rules from `amplify.yml`, so apply them
once per app either in the console (Rewrites and redirects) or from the committed rule file:

```bash
aws amplify update-app --app-id <APP_ID> \
  --custom-rules file://web/amplify-redirects.json
```

## Analytics and consent

Nothing loads before consent, and that is structural rather than a runtime check:

- **GA4** — there is no gtag snippet in `index.html` and no Google package in the bundle. The
  tag exists only as a string inside `loadGa4()` (`src/lib/analytics/ga4.ts`), which has exactly
  one call site: the consent subscriber in `src/lib/analytics/index.ts`, after the analytics
  category is granted. A visitor who never accepts makes zero requests to any Google domain and
  never has a `window.gtag`. GA4 is additionally hard-disabled outside `prod`.
- **PostHog** — EU ingest (`https://eu.i.posthog.com`), hand-rolled against the public capture
  endpoint rather than `posthog-js`. That library autocaptures clicks, inputs and page views by
  default and has to be remembered off; this one can only send an event from the closed
  `EventName` union with scalar properties, because no other code path exists.
- Event properties are checked at runtime against a forbidden-key pattern. Meeting content,
  transcripts, task text, names and emails are never sent — ids and event names only.
- Withdrawing consent reloads the page, because an injected GA4 tag cannot be un-injected.

Consent is stored first-party with a timestamp and the policy version, in the shape of
`ConsentDoc` in `api/src/db/schema.ts`, so it can be posted to the backend unchanged once that
endpoint exists. Bumping `CONSENT_POLICY_VERSION` in `src/config/env.ts` invalidates every
stored choice and re-prompts.

"Reject all" and "Accept all" are rendered from the identical class string in
`src/components/CookieBanner.tsx` — same element, same size, same weight, same tab order.

## Attribution

`src/lib/attribution/utm.ts` captures `utm_source/medium/campaign/term/content`, `gclid`,
`fbclid` and the referrer origin on landing. First touch is written once and never overwritten;
last touch is rewritten on every landing that carries campaign parameters. Both survive the
whole signup flow and are attached to the org record at creation, then cleared — they have no
purpose after that.

## Notes on structure

- **Design tokens** are CSS custom properties in `src/styles/index.css`; `tailwind.config.ts`
  reads them through `var()` so a colour has one definition. Read the contrast note at the top
  of that file before using any green.
- **`@/*`** maps to `src/*` and is declared in both `vite.config.ts` and `tsconfig.app.json`.
  They resolve independently and will disagree silently if only one is changed.
- **`useApi` is the only way data is read.** `src/lib/api/useApi.ts` keeps the last good response
  on screen when a refresh fails (marked stale, with the time it was true), ends the session on a
  401, and turns a 403 into a rendered state rather than a crash. Role helpers in
  `src/lib/auth/roles.ts` decide what to *render*; they are not authorisation, and every screen
  handles the server disagreeing with them.
- **No chart library.** The charts in `src/components/ui/Chart.tsx` are inline SVG. Each is a
  `<figure>` wrapping an `aria-hidden` drawing plus a visually-hidden `<table>` carrying the same
  numbers, which is navigable in a way an `aria-label` on an SVG is not.
- **Types are not imported from `@lily/shared`.** The wire types in `src/lib/api/types.ts`
  mirror `api/src/db/schema.ts` by hand. `@lily/shared` is a NodeNext package that pulls in the
  AWS SDK and MongoDB driver, none of which belongs in a browser bundle, and a project reference
  to it would couple this build to another workspace's build state. Field names are kept
  identical so a divergence shows up as a rename rather than as silent drift.
- **`tsc` emits declarations, not JS.** The repo's base config sets `composite`, which forbids
  `noEmit`, so `tsconfig.app.json` emits declarations only into the gitignored `dist-types/`.
  Vite does the real transpilation; `tsc` is purely the typechecker.

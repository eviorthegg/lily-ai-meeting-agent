# Brand assets

Everything in `platforms/` and `agents/`, and everything in `../avatars/`, is a
**placeholder**. Replace them before launch.

## Why these are placeholders

Zoom, Google Meet, Microsoft Teams, Claude, Codex, Cursor and Gemini logos are
trademarks. Approximating them by hand and shipping the result as the real mark
would be wrong in two ways: legally, and visually — every one of these vendors
publishes exact geometry, clear-space rules and permitted colour treatments that
a redrawn approximation will violate.

So these files are deliberately neutral tiles that read as "asset goes here"
rather than as bad imitations.

## How to replace them

Drop the official SVG at the same path. **No code change is needed** — the paths
are referenced in `web/src/components/RoutingGraph.tsx` (`PLATFORMS`) and
`web/src/pages/home/Hero.tsx` (`AGENTS`).

| File | Get it from |
|---|---|
| `platforms/zoom.svg` | Zoom brand guidelines / partner asset kit |
| `platforms/meet.svg` | Google brand permissions (Meet product marks) |
| `platforms/teams.svg` | Microsoft brand and trademark assets |
| `agents/claude-code.svg` | Anthropic press kit |
| `agents/codex.svg` | OpenAI brand assets |
| `agents/cursor.svg` | Cursor brand assets |
| `agents/gemini.svg` | Google brand permissions (Gemini product marks) |

Requirements the current slots assume: **square** viewBox, transparent
background, and legibility at 22px (graph) and 32px (hero rail).

## Before you ship them

Using another company's mark to say "we work with this" is normally nominative
use, but each of these vendors sets its own conditions — clear space, minimum
size, no implication of endorsement or partnership, and sometimes a requirement
to use the wordmark rather than the icon alone. Read each vendor's trademark
guidelines and check the marketing copy alongside them. Several explicitly
prohibit presentation that implies a partnership that does not exist.

If any vendor's terms turn out to be restrictive, the honest fallback is the
plain text names — the page reads fine without the marks.

## Avatars

`../avatars/*.svg` are abstract stand-ins, not likenesses. Replace with real
photographs (square, ideally 2× the 60px render, so 120px or larger) and make
sure you have permission from the people pictured.

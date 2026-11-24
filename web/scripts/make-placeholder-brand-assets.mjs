#!/usr/bin/env node
/**
 * Generates PLACEHOLDER brand and avatar assets.
 *
 * Why placeholders rather than the real marks: Zoom, Google Meet, Microsoft
 * Teams, Claude, Codex, Cursor and Gemini logos are trademarks. Hand-drawing
 * approximations and shipping them as the real marks would be both legally
 * wrong and visually wrong — every one of these vendors publishes a brand kit
 * with exact geometry, clear-space rules and colour requirements.
 *
 * So these are deliberately neutral tiles that read as "asset goes here". They
 * look intentional on the page, and swapping in the official file is a file
 * copy with no code change — see web/public/brand/README.md.
 *
 * Run: node web/scripts/make-placeholder-brand-assets.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const INK = '#0a0b0c';
const HAIR = '#eceef0';
const GREY = '#6f7379';

/** A neutral rounded tile carrying a mono glyph. Square, so it drops into any slot. */
function tile(glyph, { accent = GREY } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" role="img" aria-hidden="true">
  <rect x="1" y="1" width="46" height="46" rx="12" fill="#ffffff" stroke="${HAIR}" stroke-width="1.5"/>
  <text x="24" y="30.5" text-anchor="middle" font-family="IBM Plex Mono, ui-monospace, monospace"
        font-size="17" font-weight="500" fill="${accent}">${glyph}</text>
</svg>
`;
}

/**
 * An abstract avatar: soft tinted field plus a simple figure. No attempt at a
 * likeness — these stand in for real photographs the customer supplies.
 */
function avatar(initial, hue) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-hidden="true">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 32% 94%)"/>
      <stop offset="1" stop-color="hsl(${hue} 28% 88%)"/>
    </linearGradient>
    <clipPath id="c"><circle cx="48" cy="48" r="48"/></clipPath>
  </defs>
  <g clip-path="url(#c)">
    <rect width="96" height="96" fill="url(#g)"/>
    <circle cx="48" cy="39" r="15" fill="hsl(${hue} 22% 99%)"/>
    <path d="M14,96 C14,71 29,60 48,60 C67,60 82,71 82,96 Z" fill="hsl(${hue} 22% 99%)"/>
    <text x="48" y="53" text-anchor="middle" font-family="Inter, sans-serif"
          font-size="22" font-weight="600" fill="${INK}" opacity="0.28">${initial}</text>
  </g>
</svg>
`;
}

const files = {
  // Meeting platforms — shown inside the meeting node.
  'public/brand/platforms/zoom.svg': tile('Z'),
  'public/brand/platforms/meet.svg': tile('M'),
  'public/brand/platforms/teams.svg': tile('T'),

  // Coding agents — shown in the hero rail.
  'public/brand/agents/claude-code.svg': tile('C'),
  'public/brand/agents/codex.svg': tile('X'),
  'public/brand/agents/cursor.svg': tile('U'),
  'public/brand/agents/gemini.svg': tile('G'),

  // Teammate portraits — replaced with real photographs.
  'public/avatars/maya.svg': avatar('M', 265),
  'public/avatars/dan.svg': avatar('D', 205),
  'public/avatars/ari.svg': avatar('A', 150),
  'public/avatars/noa.svg': avatar('N', 25),
};

for (const [relative, contents] of Object.entries(files)) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  console.log(`  wrote ${relative}`);
}

console.log(`\n${Object.keys(files).length} placeholder assets written.\n`);

import type { Config } from 'tailwindcss';

/**
 * The palette is deliberately tiny and mirrors the CSS custom properties in
 * src/styles/index.css. Tokens live in CSS so a dark slab can re-point them
 * locally; Tailwind reads them through var() so there is exactly one source of
 * truth for a colour value.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        white: 'var(--white)',
        paper: 'var(--paper)',
        ink: 'var(--ink)',
        // Resolves to --grey-text, not --grey. The specified --grey measures
        // 4.32:1 on white and fails AA for body copy; see the contrast note in
        // index.css. --grey remains available for non-text use.
        grey: 'var(--grey-text)',
        hair: 'var(--hair)',
        neon: 'var(--neon)',
        green: 'var(--green)',
        // Text-safe green. See the contrast note in index.css: --green is 3.71:1
        // on white, which clears the 3:1 bar for graphics but not the 4.5:1 bar
        // for body-sized text.
        'green-deep': 'var(--green-deep)',
      },
      fontFamily: {
        sans: ['Inter Variable', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        eyebrow: ['0.71875rem', { lineHeight: '1', letterSpacing: '.06em' }], // 11.5px
        body: ['1.1875rem', { lineHeight: '1.6' }], // 19px
        'body-sm': ['1.125rem', { lineHeight: '1.6' }], // 18px
      },
      letterSpacing: {
        display: '-.042em',
        headline: '-.038em',
      },
      borderRadius: {
        card: '16px',
        pill: '100px',
      },
      maxWidth: {
        // ~56 characters, the measure cap for body copy.
        measure: '34rem',
        shell: '72rem',
      },
      boxShadow: {
        // Soft and low-opacity only. No hard shadows anywhere in this system.
        lift: '0 6px 20px -6px rgba(10, 11, 12, .14)',
        card: '0 1px 2px rgba(10, 11, 12, .04), 0 8px 28px -18px rgba(10, 11, 12, .18)',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { transform: 'scale(1)', opacity: '.55' },
          '50%': { transform: 'scale(1.14)', opacity: '.12' },
        },
        blink: {
          '0%, 45%': { opacity: '1' },
          '55%, 100%': { opacity: '.25' },
        },
        // Paths carry pathLength="100", so one full cycle of a "6 94" dash
        // pattern walks a single pulse from the start of the path to its end
        // regardless of how long the path actually is.
        dash: {
          from: { strokeDashoffset: '100' },
          to: { strokeDashoffset: '0' },
        },
      },
      animation: {
        breathe: 'breathe 3.6s ease-in-out infinite',
        blink: 'blink 2s ease-in-out infinite',
        // Duration and delay are set per-edge inline so no two pulses share a phase.
        dash: 'dash 4s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;

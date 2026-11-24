/**
 * Formatting used across the dashboard.
 *
 * Times are the load-bearing part. Presence, staleness and audit entries all
 * depend on the reader being able to tell "a moment ago" from "yesterday" at a
 * glance, and every relative time here is paired with an absolute one in a
 * `title` so the exact value is always recoverable.
 */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60_000],
  ['month', 30 * 24 * 60 * 60_000],
  ['day', 24 * 60 * 60_000],
  ['hour', 60 * 60_000],
  ['minute', 60_000],
  ['second', 1_000],
];

export function relativeTime(iso: string | number | null): string {
  if (iso === null) return 'never';
  const then = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';

  const delta = then - Date.now();
  const magnitude = Math.abs(delta);
  if (magnitude < 45_000) return delta < 0 ? 'just now' : 'in a moment';

  for (const [unit, ms] of UNITS) {
    if (magnitude >= ms) return RELATIVE.format(Math.round(delta / ms), unit);
  }
  return 'just now';
}

const ABSOLUTE = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function absoluteTime(iso: string | number | null): string {
  if (iso === null) return '—';
  const value = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isNaN(value) ? '—' : ABSOLUTE.format(value);
}

const DATE_ONLY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function dateOnly(iso: string | null): string {
  if (iso === null) return '—';
  const value = Date.parse(iso);
  return Number.isNaN(value) ? '—' : DATE_ONLY.format(value);
}

/** ISO date for an `<input type="date">`, which only ever speaks YYYY-MM-DD. */
export function toDateInput(iso: string | null): string {
  if (iso === null) return '';
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? '' : (value.toISOString().slice(0, 10) ?? '');
}

export function durationFromSec(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const NUMBER = new Intl.NumberFormat();

export function number(value: number): string {
  return NUMBER.format(value);
}

/** Compact tokens. "1,847,200" is noise in a table cell; "1.85M" is the same fact. */
export function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return NUMBER.format(value);
}

export function money(cents: number, options: { compact?: boolean } = {}): string {
  const dollars = cents / 100;
  if (options.compact === true && Math.abs(dollars) >= 1_000) {
    return `$${(dollars / 1_000).toFixed(dollars >= 10_000 ? 0 : 1)}k`;
  }
  return `$${dollars.toLocaleString(undefined, {
    minimumFractionDigits: Math.abs(dollars) < 100 ? 2 : 0,
    maximumFractionDigits: Math.abs(dollars) < 100 ? 2 : 0,
  })}`;
}

export function percent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/**
 * A rotation interval, in the largest unit it divides into cleanly.
 *
 * Pluralised properly, because "1 hours" and "168 hours" in a settings dropdown
 * both read as a bug — and the second one is also just harder to understand
 * than "7 days".
 */
export function seconds(value: number): string {
  const units: ReadonlyArray<readonly [number, string]> = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, unit] of units) {
    if (value % size === 0 && value >= size) {
      const count = value / size;
      return `${count} ${unit}${count === 1 ? '' : 's'}`;
    }
  }
  return `${value} second${value === 1 ? '' : 's'}`;
}

/** Title Case for an enum value: `awaiting_permission` → `Awaiting permission`. */
export function humanise(value: string): string {
  const spaced = value.replaceAll('_', ' ').replaceAll('.', ' · ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

import type { ReactNode } from 'react';
import { absoluteTime, relativeTime } from '@/lib/format';
import type { LivePresence } from '@/lib/live/LiveProvider';
import { cn } from '@/lib/cn';

/**
 * Status vocabulary.
 *
 * Colour is never the only signal. Every badge here carries a word, because a
 * green dot and a red dot are the same dot to a large number of people, and
 * because "online" is a claim that needs to be legible next to the time it was
 * true.
 *
 * Contrast, per the note at the top of styles/index.css: --green is 3.71:1 on
 * white, which clears the 3:1 bar for a dot but not the 4.5:1 bar for the label
 * beside it. So the dot is --green and the text is --green-deep. --neon is on
 * dark surfaces only and never carries text anywhere.
 */

type Tone = 'neutral' | 'positive' | 'warning' | 'danger' | 'muted';

const TONES: Readonly<Record<Tone, string>> = {
  neutral: 'bg-paper text-ink border-hair',
  positive: 'bg-[#eefaf3] text-green-deep border-[#c9edd9]',
  warning: 'bg-[#fdf6e7] text-[#8a5a00] border-[#f0e0b8]',
  danger: 'bg-[#fdf4f3] text-[#b42318] border-[#f3d3d0]',
  muted: 'bg-paper text-grey border-hair',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill border px-2.5 py-1 text-[12px] font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const fill: Readonly<Record<Tone, string>> = {
    neutral: 'bg-ink',
    positive: 'bg-green',
    warning: 'bg-[#c78500]',
    danger: 'bg-[#b42318]',
    muted: 'bg-[#c3c7cc]',
  };
  return <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', fill[tone])} />;
}

/**
 * Daemon presence.
 *
 * The rule this component exists to enforce: an "online" badge is only shown
 * when the socket is currently delivering. Any other condition renders the last
 * known state *as* a last known state, with its timestamp, so a stale green
 * badge cannot appear on the screen. That failure — a manager reading "online"
 * off a dead socket and wondering why nothing dispatches — is the one worth
 * spending a component on.
 */
export function PresenceBadge({
  live,
  fallbackOnline,
  fallbackAt,
  enrolled,
}: {
  live: LivePresence | null;
  fallbackOnline: boolean;
  fallbackAt: string | null;
  enrolled: boolean;
}) {
  if (!enrolled) {
    return (
      <Badge tone="muted">
        <Dot tone="muted" />
        No daemon
      </Badge>
    );
  }

  if (live !== null && live.source === 'live') {
    if (live.dnd) {
      return (
        <span className="inline-flex flex-col items-start gap-1">
          <Badge tone="warning">
            <Dot tone="warning" />
            Do not disturb
          </Badge>
          <span className="text-[12px] text-grey">Connected, not accepting work</span>
        </span>
      );
    }
    return (
      <span className="inline-flex flex-col items-start gap-1">
        <Badge tone={live.online ? 'positive' : 'muted'}>
          <Dot tone={live.online ? 'positive' : 'muted'} />
          {live.online ? 'Online' : 'Offline'}
        </Badge>
        <span className="text-[12px] text-grey" title={absoluteTime(live.at)}>
          {live.online ? 'live' : `since ${relativeTime(live.at)}`}
        </span>
      </span>
    );
  }

  // No live channel. Everything below is explicitly historical.
  const at = live?.at ?? fallbackAt;
  const wasOnline = live?.online ?? fallbackOnline;

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Badge tone="muted">
        <Dot tone="muted" />
        {wasOnline ? 'Was online' : 'Offline'}
      </Badge>
      <span className="text-[12px] text-grey" title={absoluteTime(at)}>
        {at === null ? 'never connected' : `last known ${relativeTime(at)}`}
      </span>
    </span>
  );
}

const TASK_TONES: Readonly<Record<string, Tone>> = {
  unconfirmed: 'warning',
  confirmed: 'neutral',
  in_progress: 'neutral',
  done: 'positive',
  cancelled: 'muted',
};

export function TaskStatusBadge({ status }: { status: string }) {
  const label: Readonly<Record<string, string>> = {
    unconfirmed: 'Unconfirmed',
    confirmed: 'Confirmed',
    in_progress: 'In progress',
    done: 'Done',
    cancelled: 'Cancelled',
  };
  const tone = TASK_TONES[status] ?? 'neutral';
  return (
    <Badge tone={tone}>
      <Dot tone={tone} />
      {label[status] ?? status}
    </Badge>
  );
}

const MEETING_TONES: Readonly<Record<string, Tone>> = {
  launching: 'warning',
  joining: 'warning',
  live: 'positive',
  ending: 'warning',
  completed: 'neutral',
  failed: 'danger',
};

export function MeetingStatusBadge({ status }: { status: string }) {
  const tone = MEETING_TONES[status] ?? 'neutral';
  const label: Readonly<Record<string, string>> = {
    launching: 'Launching',
    joining: 'Joining',
    live: 'Live',
    ending: 'Ending',
    completed: 'Completed',
    failed: 'Failed',
  };
  return (
    <Badge tone={tone}>
      <Dot tone={tone} />
      {label[status] ?? status}
    </Badge>
  );
}

export function PermissionBadge({ decision }: { decision: string }) {
  const tone: Tone =
    decision === 'granted' ? 'positive' : decision === 'timed_out' ? 'warning' : 'danger';
  const label: Readonly<Record<string, string>> = {
    granted: 'Granted',
    denied: 'Denied',
    timed_out: 'Timed out',
    hard_blocked: 'Blocked',
  };
  return (
    <Badge tone={tone}>
      <Dot tone={tone} />
      {label[decision] ?? decision}
    </Badge>
  );
}

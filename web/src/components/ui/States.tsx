import type { ReactNode } from 'react';
import { absoluteTime, relativeTime } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * The states every data screen has to have and usually does not.
 *
 * A screen that only renders "loading" and "loaded" is a screen that shows a
 * spinner forever the first time the network is slow and a blank page the first
 * time a request 403s. These are the other four.
 */

export function Panel({
  children,
  className,
  as: Element = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div';
}) {
  return <Element className={cn('card p-6', className)}>{children}</Element>;
}

/** Skeleton rows. Sized to the table they replace so the layout does not jump. */
export function LoadingRows({ rows = 5, label }: { rows?: number; label: string }) {
  return (
    <div className="rounded-card border border-hair bg-white p-4" aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            aria-hidden="true"
            className="h-9 w-full rounded-[10px] bg-paper"
            style={{ opacity: 1 - index * 0.12 }}
          />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-hair bg-white px-6 py-14 text-center">
      <p className="text-[17px] font-medium tracking-headline">{title}</p>
      <p className="mx-auto mt-2 max-w-measure text-[15px] leading-relaxed text-grey">{body}</p>
      {action === undefined ? null : <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * A 403 the browser did not expect.
 *
 * Role checks in the UI decide what to render; the API decides what is allowed.
 * When they disagree this is what the user sees — not a crash, and not an empty
 * table that implies there is nothing there.
 */
export function ForbiddenState({ what }: { what: string }) {
  return (
    <div className="rounded-card border border-hair bg-paper px-6 py-12 text-center">
      <p className="text-[17px] font-medium tracking-headline">Not available on this account</p>
      <p className="mx-auto mt-2 max-w-measure text-[15px] leading-relaxed text-grey">
        Your role does not have access to {what}. If that is wrong, an owner or admin can change it
        in Settings.
      </p>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  what,
}: {
  error: ApiError;
  onRetry: () => void;
  what: string;
}) {
  const isNetwork = error.code === 'network';
  return (
    <div
      role="alert"
      className="rounded-card border border-[#f3d3d0] bg-[#fdf4f3] px-6 py-8 text-center"
    >
      <p className="text-[16px] font-medium text-[#b42318]">
        {isNetwork ? `Could not reach the server` : `Could not load ${what}`}
      </p>
      <p className="mx-auto mt-2 max-w-measure text-[14px] leading-relaxed text-[#8a3129]">
        {error.message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 h-10 rounded-pill border border-[#e6b5b0] bg-white px-5 text-[14px] font-medium text-[#b42318]"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * Data is on screen but the last refresh failed.
 *
 * Shown above the data rather than replacing it, with the time the data was
 * actually true. Blanking a table because a poll failed is how a dashboard
 * becomes useless during exactly the incident it was opened for.
 */
export function StaleNotice({ fetchedAt, onRetry }: { fetchedAt: number | null; onRetry: () => void }) {
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-[#f0e0b8] bg-[#fdf6e7] px-4 py-3 text-[14px] text-[#8a5a00]"
    >
      <span title={absoluteTime(fetchedAt)}>
        Showing data from {relativeTime(fetchedAt)}. The last refresh did not go through.
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="h-9 shrink-0 rounded-pill border border-[#e3cd93] bg-white px-4 text-[13px] font-medium"
      >
        Refresh
      </button>
    </div>
  );
}

/** Screen heading plus optional controls. One shape for every dashboard page. */
export function PageHeader({
  eyebrow,
  title,
  intro,
  actions,
}: {
  eyebrow: string;
  title: string;
  intro?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-3 text-[26px] font-semibold tracking-headline sm:text-[30px]">{title}</h1>
        {intro === undefined ? null : (
          <p className="mt-2 max-w-measure text-[15px] leading-relaxed text-grey">{intro}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}

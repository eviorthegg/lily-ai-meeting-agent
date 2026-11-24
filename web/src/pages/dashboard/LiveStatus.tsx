import { relativeTime } from '@/lib/format';
import { useLive, type ConnectionState } from '@/lib/live/LiveProvider';
import { cn } from '@/lib/cn';

/**
 * Connection state, on screen.
 *
 * The socket's health is not an implementation detail here — it decides whether
 * the presence column means anything. Hiding it and silently showing stale
 * badges is the failure mode this whole live layer exists to avoid, so the state
 * gets a permanent place in the header rather than a toast that disappears.
 */

const COPY: Readonly<Record<ConnectionState, { label: string; tone: string; dot: string }>> = {
  idle: { label: 'Not connected', tone: 'text-grey', dot: 'bg-[#c3c7cc]' },
  connecting: { label: 'Connecting', tone: 'text-grey', dot: 'bg-[#c78500]' },
  open: { label: 'Live', tone: 'text-green-deep', dot: 'bg-green' },
  stale: { label: 'No updates', tone: 'text-[#8a5a00]', dot: 'bg-[#c78500]' },
  reconnecting: { label: 'Reconnecting', tone: 'text-[#8a5a00]', dot: 'bg-[#c78500]' },
  offline: { label: 'Offline', tone: 'text-[#b42318]', dot: 'bg-[#b42318]' },
};

export function LiveStatus() {
  const { connection, lastFrameAt, retryNow, simulateDrop } = useLive();
  const copy = COPY[connection];
  const showRetry = connection === 'offline' || connection === 'stale';

  return (
    <div className="flex items-center gap-2">
      <p
        // Polite rather than assertive: a reconnect is worth knowing about, not
        // worth interrupting whatever the user is reading.
        role="status"
        aria-live="polite"
        className={cn('flex items-center gap-2 text-[13px]', copy.tone)}
      >
        <span
          aria-hidden="true"
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            copy.dot,
            connection === 'open' ? 'motion-safe:animate-blink' : null,
          )}
        />
        <span className="whitespace-nowrap">
          {copy.label}
          {connection !== 'open' && lastFrameAt !== null ? (
            <span className="hidden text-grey sm:inline"> · last update {relativeTime(lastFrameAt)}</span>
          ) : null}
        </span>
      </p>

      {showRetry ? (
        <button
          type="button"
          onClick={retryNow}
          className="rounded-pill border border-hair px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:border-[#dfe2e6]"
        >
          Retry
        </button>
      ) : null}

      {simulateDrop !== null && connection === 'open' ? (
        <button
          type="button"
          onClick={simulateDrop}
          title="Mock mode only. Drops the fake socket so the degraded presence rendering can be seen."
          className="hidden rounded-pill border border-dashed border-hair px-2.5 py-1 text-[12px] text-grey transition-colors hover:text-ink lg:inline-flex"
        >
          Drop socket
        </button>
      ) : null}
    </div>
  );
}

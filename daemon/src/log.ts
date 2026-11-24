/**
 * Daemon logging.
 *
 * Writes to stderr so stdout stays clean for the CLI's machine-readable output
 * (`lily-daemon detect --json` is piped by the install scripts).
 *
 * DATA POLICY: this logger takes a short event name and a bag of scalar fields.
 * It deliberately has no "log this object" overload, because the things flowing
 * through this process — dispatch text, agent output, file paths the agent
 * touched — are exactly what must never be written anywhere. Log identifiers and
 * counts; never content.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function activeLevel(): LogLevel {
  const raw = process.env['LILY_LOG_LEVEL'];
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

/** Scalars only. An object here would be a route for content to leak into logs. */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;

  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), event];
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) parts.push(`${key}=${String(value)}`);
  }
  process.stderr.write(parts.join(' ') + '\n');
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit('debug', event, fields),
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  error: (event: string, fields?: LogFields) => emit('error', event, fields),
};

/**
 * Reduce an unknown throwable to a single short string safe to log.
 *
 * Stack traces can contain absolute paths from the employee's machine, so only
 * the message survives, and it is clipped.
 */
export function errText(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw.length > 200 ? raw.slice(0, 197) + '...' : raw;
}

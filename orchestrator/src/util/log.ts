/**
 * Structured logging for the orchestrator.
 *
 * The orchestrator is the one process in the system that sees raw meeting
 * speech, so the logger is deliberately awkward to misuse: it takes a fixed
 * event name plus a bag of scalar fields, and there is no `log.info(someText)`
 * overload that would make it easy to pipe an utterance into stdout. Anything
 * derived from what a person said must be reduced to a count, an id, or an
 * enum before it reaches here.
 *
 * CloudWatch retains stdout. A transcript in a log line is a transcript that
 * has been persisted, which the data policy forbids — see the header of
 * `api/src/db/schema.ts`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Scalars only. Objects and strings-of-unknown-origin cannot be passed. */
export type LogFields = Record<string, string | number | boolean | null>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = process.env['LILY_LOG_LEVEL'];
  const level = raw !== undefined && raw in LEVEL_ORDER ? (raw as LogLevel) : 'info';
  return LEVEL_ORDER[level];
}

let minimum = threshold();

export function setLogLevel(level: LogLevel): void {
  minimum = LEVEL_ORDER[level];
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  if (LEVEL_ORDER[level] < minimum) return;

  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...fields,
  });

  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (event: string, fields: LogFields = {}) => emit('debug', event, fields),
  info: (event: string, fields: LogFields = {}) => emit('info', event, fields),
  warn: (event: string, fields: LogFields = {}) => emit('warn', event, fields),
  error: (event: string, fields: LogFields = {}) => emit('error', event, fields),
};

/**
 * Reduce an error to something loggable.
 *
 * Deliberately message-only and truncated: a stack trace from the Realtime
 * client can echo a request body, and that body contains speech.
 */
export function errorField(cause: unknown): string {
  if (cause instanceof Error) return cause.message.slice(0, 300);
  return String(cause).slice(0, 300);
}

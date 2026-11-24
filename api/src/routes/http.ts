import type { z } from 'zod';
import type { LilyConfig, Providers } from '@lily/shared';

/**
 * The transport-neutral request/response pair every handler speaks.
 *
 * Handlers are plain async functions from `ApiRequest` to `ApiResponse`. They
 * never touch `node:http`, never touch an API Gateway event, and never reach for
 * a framework's `res.send`. The local server in ../local/server.ts adapts
 * `IncomingMessage` into this shape; an API Gateway proxy adapter would adapt
 * `APIGatewayProxyEventV2` into the same shape, and neither adapter contains a
 * line of business logic.
 *
 * `body` is already serialised. Doing it here rather than in the adapter is what
 * lets the audit export return CSV through the same type as everything else,
 * instead of a second response channel that only one route uses.
 */

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  /** Path parameters, filled in by the router from the matched pattern. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Header names are lowercased by the adapter, so lookups here are exact. */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON, or `null` when there was no body. Never trusted; always zod-validated. */
  readonly body: unknown;
  readonly ip: string | null;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Everything a handler needs that is not the request.
 *
 * `providers` is the stage seam. Handlers call `deps.providers.mail.send(...)`
 * and neither know nor care whether that writes an .eml to disk or calls SES —
 * which is why there is no `stage` field on this interface to branch on.
 *
 * `now` is injected so a test can pin time without stubbing the global clock.
 */
export interface RouteDeps {
  readonly config: LilyConfig;
  readonly providers: Providers;
  readonly now: () => Date;
}

export type RouteHandler = (req: ApiRequest, deps: RouteDeps) => Promise<ApiResponse>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Codes the dashboard already understands (see web/src/lib/api/types.ts), plus
 * the four this API needs that its proposal did not anticipate. The web client
 * passes an unrecognised code straight through to `ApiError`, so adding to this
 * list is backwards compatible.
 */
export type ApiErrorCode =
  | 'invalid_credentials'
  | 'email_taken'
  | 'email_not_verified'
  | 'invalid_code'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  // --- additions ---
  | 'step_up_required'
  | 'mfa_enrollment_required'
  | 'conflict'
  | 'gone';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fields: Readonly<Record<string, string>>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    fields: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const badRequest = (message: string, fields?: Record<string, string>): HttpError =>
  new HttpError(400, 'validation_failed', message, fields ?? {});

export const unauthorized = (message = 'Authentication required.'): HttpError =>
  new HttpError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have access to that.'): HttpError =>
  new HttpError(403, 'forbidden', message);

export const notFound = (message = 'Not found.'): HttpError =>
  new HttpError(404, 'not_found', message);

export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message);

/**
 * 410 Gone, the status the daemon's `enroll` command specifically checks for.
 * See daemon/src/index.ts — anything else there is reported as a generic failure.
 */
export const gone = (message: string): HttpError => new HttpError(410, 'gone', message);

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

export function json(status: number, value: unknown): ApiResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(value) };
}

export const ok = (value: unknown): ApiResponse => json(200, value);
export const created = (value: unknown): ApiResponse => json(201, value);

export const noContent = (): ApiResponse => ({ status: 204, headers: {}, body: '' });

export function csv(filename: string, body: string): ApiResponse {
  return {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
    body,
  };
}

export function errorResponse(error: HttpError): ApiResponse {
  return json(error.status, {
    code: error.code,
    message: error.message,
    fields: error.fields,
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a request body at the trust boundary.
 *
 * Every route runs its body through this. Field errors are reported keyed by
 * path so the dashboard can render them inline — `ApiError.fields` exists for
 * exactly this and is otherwise always empty.
 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data as z.infer<S>;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.join('.');
    fields[key] ??= issue.message;
  }

  throw badRequest('Some fields need attention.', fields);
}

/** Same, for query strings. Values arrive as strings; the schema coerces. */
export function parseQuery<S extends z.ZodTypeAny>(
  schema: S,
  query: Readonly<Record<string, string>>,
): z.infer<S> {
  const result = schema.safeParse(query);
  if (result.success) return result.data as z.infer<S>;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.join('.');
    fields[key] ??= issue.message;
  }

  throw badRequest('Invalid query parameters.', fields);
}

/** `noUncheckedIndexedAccess` makes every param read `string | undefined`. */
export function requireParam(req: ApiRequest, name: string): string {
  const value = req.params[name];
  if (value === undefined || value === '') {
    // Only reachable if a route pattern and its handler disagree, which is a
    // programming error rather than anything a client can provoke.
    throw new HttpError(500, 'server_error', `Route parameter "${name}" is missing.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface Route {
  readonly method: string;
  /** e.g. `/orgs/:orgId/employees/:employeeId`. */
  readonly pattern: string;
  readonly handler: RouteHandler;
}

interface CompiledRoute {
  readonly method: string;
  readonly regex: RegExp;
  readonly names: readonly string[];
  readonly handler: RouteHandler;
}

function compile(route: Route): CompiledRoute {
  const names: string[] = [];

  const source = route.pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      names.push(segment.slice(1));
      // Segments do not span `/`, so a param can never swallow the rest of a path.
      return '([^/]+)';
    })
    .join('/');

  return {
    method: route.method.toUpperCase(),
    regex: new RegExp(`^${source}$`),
    names,
    handler: route.handler,
  };
}

export interface MatchedRoute {
  readonly handler: RouteHandler;
  readonly params: Record<string, string>;
}

export class Router {
  readonly #routes: readonly CompiledRoute[];

  constructor(routes: readonly Route[]) {
    this.#routes = routes.map(compile);
  }

  /**
   * Resolve a method+path.
   *
   * Returns `'method_not_allowed'` rather than null when the path exists under a
   * different verb, so the caller can answer 405 instead of a misleading 404.
   */
  match(method: string, path: string): MatchedRoute | 'not_found' | 'method_not_allowed' {
    const normalised = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    let pathExists = false;

    for (const route of this.#routes) {
      const matched = route.regex.exec(normalised);
      if (matched === null) continue;
      pathExists = true;
      if (route.method !== method.toUpperCase()) continue;

      const params: Record<string, string> = {};
      route.names.forEach((name, index) => {
        const value = matched[index + 1];
        if (value !== undefined) params[name] = decodeURIComponent(value);
      });

      return { handler: route.handler, params };
    }

    return pathExists ? 'method_not_allowed' : 'not_found';
  }
}

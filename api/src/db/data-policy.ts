/**
 * Runtime enforcement of the data policy declared in ./schema.ts.
 *
 * Design note: this guard is deliberately *deterministic* — forbidden field
 * names and hard length caps only. An earlier draft included a heuristic that
 * tried to recognise "this looks like a transcript or source code". That was
 * removed on purpose: a fuzzy content classifier in a write path fails in the
 * worst possible direction, silently rejecting a legitimate summary in
 * production. Structural rules can be reasoned about and tested; vibes cannot.
 *
 * The caps below are the real defence. A transcript or a file's contents cannot
 * be smuggled through a field bounded at a few hundred characters, and the two
 * fields large enough to matter (`summary`, `detail`) are bounded well under
 * the size of any genuine transcript.
 */

/**
 * Field names that must never be persisted. Matched case-insensitively at every
 * depth. Keep in sync with the ESLint rule in eslint.config.js, which catches
 * the same names at author time.
 */
const FORBIDDEN_FIELDS = new Set(
  [
    'transcript',
    'transcripts',
    'transcriptText',
    'fullTranscript',
    'audio',
    'audioData',
    'audioUrl',
    'video',
    'videoData',
    'videoUrl',
    'recording',
    'recordingUrl',
    'sourceCode',
    'code',
    'fileContents',
    'fileContent',
    'diff',
    'patch',
    'agentOutput',
    'agentResult',
    'stdout',
    'stderr',
    'repoContents',
    'meetingUrl',
    'joinUrl',
    'accessToken',
    'refreshToken',
    'apiKey',
    'privateKey',
    'password',
  ].map((f) => f.toLowerCase()),
);

/**
 * Maximum lengths for the only fields permitted to carry derived content.
 * Anything not listed here is structural and separately bounded by its type.
 */
const MAX_LENGTHS: Record<string, number> = {
  // "Short task text" per the brief — a sentence, not a paragraph.
  text: 500,
  // A narrative summary of a meeting. A real transcript is orders of magnitude larger.
  summary: 8_000,
  // Audit detail is the command being approved, e.g. "run `npm test`".
  detail: 1_000,
  jobDescription: 2_000,
  name: 200,
  title: 300,
};

/** Caps on array fields that could otherwise grow into a transcript by increments. */
const MAX_ARRAY_LENGTHS: Record<string, number> = {
  decisions: 50,
  agentCapabilities: 100,
  backupCodeHashes: 20,
};

const MAX_DEPTH = 12;

export class DataPolicyViolation extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(
      `Data policy violation at "${path}": ${reason}. ` +
        `This database never stores meeting media, transcripts, source code or agent output. ` +
        `See api/src/db/schema.ts.`,
    );
    this.name = 'DataPolicyViolation';
    this.path = path;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  // Dates, ObjectIds, Buffers and other class instances are opaque leaves here.
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Throws if `doc` contains a forbidden field or an over-long value.
 *
 * Call this on every write path that persists anything derived from a meeting.
 * It is cheap — a walk over a document that is, by policy, always small.
 */
export function assertNoForbiddenContent(doc: unknown, rootPath = '$'): void {
  walk(doc, rootPath, 0);
}

function walk(value: unknown, path: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new DataPolicyViolation(path, `nesting deeper than ${MAX_DEPTH} levels`);
  }

  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      walk(item, `${path}[${i}]`, depth + 1);
    }
    return;
  }

  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;

    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      throw new DataPolicyViolation(childPath, `"${key}" is a forbidden field name`);
    }

    const maxLength = MAX_LENGTHS[key];
    if (maxLength !== undefined && typeof child === 'string' && child.length > maxLength) {
      throw new DataPolicyViolation(
        childPath,
        `${child.length} characters exceeds the ${maxLength}-character cap`,
      );
    }

    const maxItems = MAX_ARRAY_LENGTHS[key];
    if (maxItems !== undefined && Array.isArray(child) && child.length > maxItems) {
      throw new DataPolicyViolation(
        childPath,
        `${child.length} items exceeds the ${maxItems}-item cap`,
      );
    }

    walk(child, childPath, depth + 1);
  }
}

/** Convenience for write helpers: validates, then returns the document unchanged. */
export function policyChecked<T>(doc: T): T {
  assertNoForbiddenContent(doc);
  return doc;
}

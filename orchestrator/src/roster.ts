/**
 * Who is in the room, and what each of them can be asked.
 *
 * The roster is the orchestrator's only source of identity. It is built from
 * the meeting bootstrap payload (org users, their `employeeId`, their
 * `jobDescription` and their agent capabilities — all fields already in policy
 * per `api/src/db/schema.ts`) and lives in memory for the meeting only.
 */

import type { EmployeeProfile } from './types.js';

/** Filler that can precede a vocative without weakening it: "hey Lily, ...". */
const GREETINGS = ['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'so', 'um', 'uh', 'right'];

export const GREETING_PREFIX = new RegExp(`^(?:(?:${GREETINGS.join('|')})[,!.]?\\s+)+`, 'i');

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Escape a name so it can be embedded in a generated matcher. */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What Lily calls someone out loud.
 *
 * First name only. A room says "Sarah", not "Sarah Chen", and an assistant that
 * uses full names every time sounds like it is reading from a list — which,
 * being an unfamiliar AI in a meeting, it can least afford to.
 */
export function spokenName(profile: EmployeeProfile): string {
  const first = profile.name.trim().split(/\s+/)[0];
  return first === undefined || first === '' ? profile.name : first;
}

export interface NameMention {
  readonly employee: EmployeeProfile;
  /** Character offset of the match in the original text. */
  readonly index: number;
  readonly matched: string;
}

export class RosterError extends Error {
  override readonly name = 'RosterError';
}

export class Roster {
  readonly #byEmployeeId = new Map<string, EmployeeProfile>();
  /** alias (normalised) → employee. First writer wins; collisions are rejected. */
  readonly #byAlias = new Map<string, EmployeeProfile>();
  readonly #botAliases: readonly string[];

  /**
   * @param botDisplayName `config.meeting.botDisplayName`, e.g. "Lily (AI assistant)".
   *   Its leading word becomes Lily's wake word.
   */
  constructor(profiles: readonly EmployeeProfile[], botDisplayName: string) {
    this.#botAliases = Roster.botAliasesFor(botDisplayName);

    for (const profile of profiles) {
      if (this.#byEmployeeId.has(profile.employeeId)) {
        throw new RosterError(`Duplicate employeeId in roster: ${profile.employeeId}`);
      }
      this.#byEmployeeId.set(profile.employeeId, profile);

      for (const alias of Roster.aliasesFor(profile)) {
        // A human whose name collides with the wake word makes every
        // "Lily, ..." ambiguous, and the ambiguity resolves in the acting
        // direction — exactly the failure this product cannot have. Refuse to
        // start rather than guess at runtime.
        if (this.#botAliases.includes(alias)) {
          throw new RosterError(
            `Participant "${profile.name}" shares a name with the assistant ` +
              `("${botDisplayName}"). Set LILY_BOT_DISPLAY_NAME to something that does not ` +
              `collide before starting this meeting.`,
          );
        }

        const existing = this.#byAlias.get(alias);
        if (existing !== undefined && existing.employeeId !== profile.employeeId) {
          // Two Sarahs. Ambiguous first names are dropped rather than guessed:
          // routing work to the wrong person is worse than asking who was meant.
          this.#byAlias.set(alias, AMBIGUOUS);
          continue;
        }
        this.#byAlias.set(alias, profile);
      }
    }
  }

  static botAliasesFor(botDisplayName: string): readonly string[] {
    const first = normalise(botDisplayName).split(/[\s(]+/)[0] ?? '';
    const aliases = new Set<string>();
    if (first !== '') aliases.add(first);
    aliases.add(normalise(botDisplayName));
    return [...aliases];
  }

  static aliasesFor(profile: EmployeeProfile): readonly string[] {
    const aliases = new Set<string>();
    aliases.add(normalise(profile.name));

    const first = normalise(profile.name).split(' ')[0];
    if (first !== undefined && first.length >= 2) aliases.add(first);

    for (const alias of profile.aliases) {
      const value = normalise(alias);
      if (value !== '') aliases.add(value);
    }
    return [...aliases];
  }

  get botAliases(): readonly string[] {
    return this.#botAliases;
  }

  get employees(): readonly EmployeeProfile[] {
    return [...this.#byEmployeeId.values()];
  }

  byId(employeeId: string): EmployeeProfile | null {
    return this.#byEmployeeId.get(employeeId) ?? null;
  }

  /** Resolve a bare name token. Returns null for unknown *and* ambiguous names. */
  byName(token: string): EmployeeProfile | null {
    const found = this.#byAlias.get(normalise(token));
    if (found === undefined || found === AMBIGUOUS) return null;
    return found;
  }

  /** True when `token` names a real person but more than one of them. */
  isAmbiguous(token: string): boolean {
    return this.#byAlias.get(normalise(token)) === AMBIGUOUS;
  }

  /** Every distinct alias, longest first, so "sarah chen" beats "sarah". */
  get aliasesLongestFirst(): readonly string[] {
    return [...this.#byAlias.keys()].sort((a, b) => b.length - a.length);
  }

  /** All roster names appearing in `text`, in order of appearance. */
  mentions(text: string): readonly NameMention[] {
    const found: NameMention[] = [];
    const claimed: Array<[number, number]> = [];

    for (const alias of this.aliasesLongestFirst) {
      const matcher = new RegExp(`(?<![\\p{L}\\p{N}])@?${escapeForRegex(alias)}(?![\\p{L}\\p{N}])`, 'giu');
      for (const match of text.matchAll(matcher)) {
        const start = match.index;
        const end = start + match[0].length;
        // Longer aliases are consumed first, so a shorter alias inside an
        // already-matched span ("sarah" inside "sarah chen") is skipped.
        if (claimed.some(([s, e]) => start < e && end > s)) continue;

        const employee = this.byName(alias);
        if (employee === null) continue;

        claimed.push([start, end]);
        found.push({ employee, index: start, matched: match[0] });
      }
    }

    return found.sort((a, b) => a.index - b.index);
  }

  /**
   * Best guess at who owns a topic, from job description and agent capabilities.
   *
   * Deliberately conservative — it returns null unless a term actually overlaps.
   * Lily asking "who knows about the login flow?" is a fine outcome; dispatching
   * a question to the wrong person's machine is not.
   */
  bestOwnerFor(topic: string): EmployeeProfile | null {
    const terms = new Set(
      normalise(topic)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 4 && !STOP_WORDS.has(word)),
    );
    if (terms.size === 0) return null;

    let best: EmployeeProfile | null = null;
    let bestScore = 0;

    for (const employee of this.#byEmployeeId.values()) {
      const haystack = normalise(
        `${employee.jobDescription} ${employee.capabilities.join(' ')}`,
      );
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = employee;
      }
    }

    return best;
  }
}

/**
 * Sentinel for a first name shared by two people. Stored in the alias map so
 * `byName` can distinguish "nobody by that name" from "several".
 */
const AMBIGUOUS: EmployeeProfile = Object.freeze({
  employeeId: '__ambiguous__',
  name: '__ambiguous__',
  aliases: [],
  jobDescription: '',
  agentKind: null,
  capabilities: [],
  daemonEnrolled: false,
});

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'could',
  'does',
  'from',
  'have',
  'make',
  'sure',
  'that',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'what',
  'when',
  'where',
  'which',
  'will',
  'with',
  'would',
  'your',
]);

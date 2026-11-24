/**
 * Who is speaking, and whether we are entitled to say so.
 *
 * ===========================================================================
 * WHY THE DOM BEATS DIARIZATION HERE
 * ===========================================================================
 * Every meeting client already knows who is talking — it has to, to put the
 * blue ring round their tile — and it publishes that in the DOM. Reading it is
 * better attribution than any audio diarization we could run over a mixed
 * stream: the platform has per-participant tracks and we have one mixdown, and
 * it is the platform's own answer rather than our guess at it.
 *
 * That matters far more than transcript quality, because the permission gate
 * depends on it. Only the owning employee's spoken "yes" may approve their own
 * agent. If attribution is wrong, the gate approves the wrong thing on the
 * wrong person's machine — the worst failure this product has.
 *
 * ===========================================================================
 * THE RULE THIS MODULE ENFORCES
 * ===========================================================================
 * **An unidentified speaker is `employeeId: null`, always.** Never a guess,
 * never a nearest match, never "the only person whose name starts with J".
 *
 * The gate treats null as "not a known employee", so null denies. Every
 * ambiguity therefore resolves towards denial:
 *
 *   - Display name not on the roster → null. Guests exist.
 *   - Display name matching two people ("Sarah") → null. `Roster.byName`
 *     already returns null for ambiguous aliases and that behaviour is relied
 *     on here rather than worked around.
 *   - No speaker highlighted at all → null.
 *   - Lily's own tile → not an utterance from the room at all.
 *
 * A guest is still a *participant* — counted, present, able to talk to Lily.
 * They simply cannot approve anything, which is exactly right: they never
 * enrolled an agent, so there is nothing of theirs to approve.
 * ===========================================================================
 */

import { Roster } from '../../roster.js';
import type { EmployeeProfile, Participant } from '../../types.js';

/** Stable-per-meeting identity for a display name we have seen speak. */
export interface ResolvedSpeaker {
  readonly participantId: string;
  readonly displayName: string;
  /** Null for a guest, an unknown name, or an ambiguous one. Never guessed. */
  readonly employeeId: string | null;
  readonly isBot: boolean;
}

/**
 * Trim the decoration platforms add to a tile's label.
 *
 * Meet appends "(You)", Zoom appends "(Host)" and "(Me)", Teams prefixes a
 * presence word. None of that is part of a name, and leaving it in turns every
 * host into an unknown speaker.
 */
export function cleanDisplayName(raw: string): string {
  return raw
    // Non-breaking spaces and zero-width marks, written as escapes because they
    // are invisible in a source file. Every platform emits at least one of them,
    // and one of them inside a name is the difference between an employee and an
    // unknown speaker.
    .replace(/[\u00a0\u200b\ufeff]/g, ' ')
    .replace(/\((?:you|me|host|co-host|guest|organizer|organiser|presenter)\)/gi, '')
    .replace(/\b(?:is speaking|speaking|muted|unmuted|hand raised)\b/gi, '')
    .replace(/[,;]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SpeakerResolverOptions {
  readonly directory: readonly EmployeeProfile[];
  /** `config.meeting.botDisplayName`. Lily's own tile must never be an utterance. */
  readonly botDisplayName: string;
  /** Injected so participant ids are deterministic in tests. */
  readonly newParticipantId?: () => string;
}

export class SpeakerResolver {
  readonly #roster: Roster;
  readonly #botAliases: readonly string[];
  readonly #newId: () => string;
  /** normalised display name → the identity we already minted for it. */
  readonly #seen = new Map<string, ResolvedSpeaker>();
  #counter = 0;

  constructor(options: SpeakerResolverOptions) {
    // A second Roster rather than a shared one: this adapter may be constructed
    // before a session exists, and the alias-collision check the constructor
    // performs is worth running here too.
    this.#roster = new Roster(options.directory, options.botDisplayName);
    this.#botAliases = Roster.botAliasesFor(options.botDisplayName);
    this.#newId = options.newParticipantId ?? (() => `bp_${++this.#counter}`);
  }

  /** True when this display name is Lily herself. */
  isBotName(raw: string): boolean {
    const cleaned = cleanDisplayName(raw).toLowerCase();
    if (cleaned === '') return false;
    return this.#botAliases.some((alias) => cleaned === alias || cleaned.startsWith(`${alias} `));
  }

  /**
   * Resolve a display name read off a tile.
   *
   * `null` in means "the DOM says someone is speaking but would not say who",
   * which is a real and common state during transitions. It resolves to a
   * present-but-anonymous speaker, not to nobody, because dropping the
   * utterance entirely would lose a sentence the room heard.
   */
  resolve(raw: string | null): ResolvedSpeaker {
    const cleaned = raw === null ? '' : cleanDisplayName(raw);
    const key = cleaned.toLowerCase();

    const existing = this.#seen.get(key);
    if (existing !== undefined) return existing;

    const resolved: ResolvedSpeaker =
      cleaned === ''
        ? {
            participantId: this.#newId(),
            displayName: 'unidentified speaker',
            employeeId: null,
            isBot: false,
          }
        : {
            participantId: this.#newId(),
            displayName: cleaned,
            // `byName` returns null for both "unknown" and "ambiguous", and
            // that collapse is correct: neither is an identification.
            employeeId: this.isBotName(cleaned) ? null : (this.#roster.byName(cleaned)?.employeeId ?? null),
            isBot: this.isBotName(cleaned),
          };

    this.#seen.set(key, resolved);
    return resolved;
  }

  /** Everyone resolved so far, as `Participant`s. */
  toParticipant(resolved: ResolvedSpeaker, joinedAt: Date): Participant {
    return {
      participantId: resolved.participantId,
      displayName: resolved.displayName,
      employeeId: resolved.employeeId,
      isBot: resolved.isBot,
      joinedAt,
    };
  }

  /** True when the roster knows this name and knows it unambiguously. */
  isKnownEmployee(raw: string): boolean {
    return this.resolve(raw).employeeId !== null;
  }
}

// ---------------------------------------------------------------------------
// Debouncing
// ---------------------------------------------------------------------------

/**
 * The active-speaker highlight flickers.
 *
 * Every client toggles it on breath noise and cross-talk, so a raw read
 * produces a new "speaker" several times a second. This holds a candidate until
 * it has been the answer for `holdMs`, which is the difference between
 * attributing a sentence to the person who said it and attributing it to
 * whoever coughed in the middle of it.
 *
 * Time is injected — this has to be testable without sleeping.
 */
/**
 * The result of one observation.
 *
 * A record rather than `string | null`, because "the speaker changed to nobody"
 * and "nothing has settled yet" are both `null` speakers and must not collapse
 * into one another — silence falling is an event the adapter has to act on.
 */
export interface SpeakerObservation {
  readonly changed: boolean;
  readonly speaker: string | null;
}

export class SpeakerTracker {
  readonly #holdMs: number;
  #currentName: string | null = null;
  #candidateName: string | null = null;
  #candidateSince = 0;
  #hasCandidate = false;

  constructor(holdMs: number) {
    this.#holdMs = holdMs;
  }

  get current(): string | null {
    return this.#currentName;
  }

  observe(name: string | null, nowMs: number): SpeakerObservation {
    if (name === this.#currentName) {
      this.#hasCandidate = false;
      this.#candidateName = null;
      return { changed: false, speaker: this.#currentName };
    }

    if (!this.#hasCandidate || name !== this.#candidateName) {
      this.#hasCandidate = true;
      this.#candidateName = name;
      this.#candidateSince = nowMs;
      return { changed: false, speaker: this.#currentName };
    }

    if (nowMs - this.#candidateSince < this.#holdMs) {
      return { changed: false, speaker: this.#currentName };
    }

    this.#currentName = name;
    this.#hasCandidate = false;
    this.#candidateName = null;
    return { changed: true, speaker: name };
  }
}

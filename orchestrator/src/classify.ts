/**
 * Turning one line of meeting speech into a decision about whether Lily acts.
 *
 * ===========================================================================
 * THE BIAS, STATED ONCE, EXPLICITLY
 * ===========================================================================
 * Two errors are possible and they are not symmetric.
 *
 *   Missing an instruction meant for Lily costs the speaker one repetition.
 *   Acting on an instruction meant for a human is the worst failure this
 *   product has: Lily reaches into someone's machine off the back of a
 *   sentence that was never addressed to her.
 *
 * So every ambiguous case resolves *away* from `lily_action`, and the rules
 * below are deliberately asymmetric about it:
 *
 *   - A bare leading name is enough to address a human ("John make sure ...").
 *     It is NOT enough to address Lily — she additionally needs a comma, a
 *     greeting, an "@", or a direct-address verb behind her name.
 *   - Being *mentioned* is never being *addressed*. "I'll ask Lily to book it"
 *     mentions her and is classified as chatter.
 *   - An instruction addressed to a human stays addressed to that human even
 *     when it names Lily inside it ("John, ask Lily to book the room").
 *   - `human_assignment` is silent and reversible, so the classifier reaches
 *     for it freely. `lily_action` is neither, so it must be earned.
 * ===========================================================================
 *
 * This is a deterministic classifier, not a prompt. Both brains run it: the
 * text brain uses it as its only reasoning step, and the realtime brain runs it
 * alongside the model and lets it veto — see `brain/route.ts`.
 */

import { GREETING_PREFIX, type Roster } from './roster.js';
import type { EmployeeProfile } from './types.js';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type ClassifierRule =
  | 'empty'
  | 'filler'
  | 'lily.addressed'
  | 'lily.relay_to_human'
  | 'lily.route_question'
  | 'human.addressed.question'
  | 'human.addressed.assignment'
  | 'human.third_person_assignment'
  | 'self.assignment'
  | 'mentioned_not_addressed'
  | 'no_addressee';

interface ClassificationBase {
  /** Which rule fired. A closed vocabulary, safe to log — it carries no speech. */
  readonly rule: ClassifierRule;
}

export interface LilyActionClassification extends ClassificationBase {
  readonly kind: 'lily_action';
  /** The instruction with the vocative and greeting removed. */
  readonly instruction: string;
  /**
   * Set for "Lily, tell John to fix the build" — an instruction TO Lily ABOUT
   * a human. Lily acts (she relays it out loud), and the same utterance also
   * produces an unconfirmed assignment owned by the named human. What it must
   * never do is dispatch work to that human's agent: nobody asked their machine
   * for anything.
   */
  readonly relayTo?: EmployeeProfile;
  readonly due: string | null;
}

export interface HumanAssignmentClassification extends ClassificationBase {
  readonly kind: 'human_assignment';
  readonly owner: EmployeeProfile;
  readonly text: string;
  readonly due: string | null;
}

export interface RoutedQuestionClassification extends ClassificationBase {
  readonly kind: 'routed_question';
  readonly target: EmployeeProfile;
  readonly question: string;
  /** Questions never mutate. This is passed straight into `task.dispatch`. */
  readonly mode: 'read_only';
}

export interface ChatterClassification extends ClassificationBase {
  readonly kind: 'chatter';
}

export type Classification =
  | LilyActionClassification
  | HumanAssignmentClassification
  | RoutedQuestionClassification
  | ChatterClassification;

export interface ClassifyInput {
  readonly text: string;
  readonly speakerEmployeeId: string | null;
  readonly roster: Roster;
  /** Anchor for relative deadlines ("by Sunday"). Injected so tests are stable. */
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Words that, following Lily's name, make a bare mention a direct address. */
const DIRECT_ADDRESS_FOLLOWERS = [
  'can', 'could', 'would', 'will', 'please', 'do', 'does', 'did', 'is', 'are', 'am',
  'what', 'whats', 'how', 'why', 'when', 'where', 'who', 'which', 'should',
  'tell', 'ask', 'remind', 'book', 'schedule', 'find', 'set', 'send', 'draft',
  'add', 'create', 'check', 'give', 'show', 'help', 'look', 'pull', 'start', 'stop',
  'note', 'log', 'open', 'summarize', 'summarise', 'read', 'write', 'get', 'make',
];

const WH_WORDS = [
  'what', 'whats', "what's", 'how', "how's", 'why', 'when', "when's", 'where', "where's",
  'which', 'who', "who's", 'whose', 'whom',
];

const AUX_STARTERS = [
  'can', 'could', 'would', 'will', 'do', 'does', 'did', 'is', 'are', 'was', 'were',
  'should', 'have', 'has', 'any',
];

/** Asking for information. These pull a sentence toward "route it", not "assign it". */
const INFO_MARKERS = [
  'explain', 'describe', 'walk us through', 'walk me through', 'walk through',
  'how does', 'how do', 'how did', 'how is', 'how are', 'how far',
  'what does', 'what do', 'what is', "what's", 'whats', 'what are',
  'why does', 'why is', 'why did',
  'where is', "where's", 'where does',
  'status of', 'status on', 'any idea', 'do we know', 'do you know',
  'tell me about', 'tell us about', 'give me a rundown', 'give us a rundown',
  'summarize', 'summarise', 'summary of', 'remind me what', 'remind us what',
  'what happened', 'is there a', 'are there any', 'which one', 'who owns',
];

/** Obligation language. Strong evidence the sentence hands work to someone. */
const OBLIGATION_MARKERS = [
  'make sure', 'makes sure', 'making sure', 'please', 'need to', 'needs to',
  'has to', 'have to', 'must', 'should', 'be sure', "don't forget", 'dont forget',
  'remember to', 'take care of', 'takes care of', 'pick up', 'picks up',
  'own the', 'owns the', 'handle the', 'handles the', 'on the hook for',
  'is on', 'action item', 'take the', 'takes the', 'get it done', 'wrap up',
  'follow up', 'follows up', 'is going to', 'going to', 'will be', "you're on",
];

/** Verbs that change the world. Their presence pushes away from "read-only question". */
const MUTATION_VERBS = [
  'fix', 'fixes', 'finish', 'finishes', 'ship', 'ships', 'deploy', 'deploys',
  'refactor', 'refactors', 'write', 'writes', 'update', 'updates', 'merge', 'merges',
  'migrate', 'migrates', 'rename', 'renames', 'implement', 'implements',
  'build', 'builds', 'add', 'adds', 'remove', 'removes', 'bump', 'bumps',
  'patch', 'patches', 'release', 'releases', 'send', 'sends', 'book', 'books',
  'schedule', 'schedules', 'review', 'reviews', 'rebase', 'revert', 'clean up',
  'close out', 'land', 'cut', 'draft', 'drafts', 'prepare', 'prepares',
];

/** Nothing to classify: acknowledgements, hedges, corrections. */
const FILLER = [
  'yeah', 'yes', 'yep', 'no', 'nope', 'ok', 'okay', 'sure', 'right', 'exactly',
  'sorry', 'thanks', 'thank you', 'got it', 'mhm', 'hmm', 'uh', 'um', 'cool',
  'nice', 'nevermind', 'never mind', 'one sec', 'hold on', 'wait',
];

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

function squash(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Lowercased, punctuation-normalised form used only for matching. */
function key(text: string): string {
  return squash(text)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,!;:]+$/g, '');
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) =>
    needle.includes(' ')
      ? haystack.includes(needle)
      : new RegExp(`(?<![\\p{L}\\p{N}])${needle}(?![\\p{L}\\p{N}])`, 'u').test(haystack),
  );
}

function firstWord(text: string): string {
  return key(text).split(/[^\p{L}\p{N}']+/u)[0] ?? '';
}

function stripTrailingVocative(text: string, alias: string): string {
  return squash(
    text.replace(new RegExp(`[,\\s]+@?${escapeRegex(alias)}\\s*([?.!]*)$`, 'iu'), '$1'),
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;

function isoDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

/**
 * Extract a deadline, as a plain calendar date.
 *
 * A date and not an instant on purpose: the meeting has no reliable timezone
 * for the person the work belongs to, and inventing 17:00 UTC would produce a
 * deadline nobody agreed to. The API attaches a time when it writes `TaskDoc.due`.
 */
export function parseDue(text: string, now: Date): string | null {
  const haystack = key(text);

  const explicit = /(\d{4})-(\d{2})-(\d{2})/.exec(haystack);
  if (explicit !== null) return `${explicit[1]}-${explicit[2]}-${explicit[3]}`;

  if (/(?<![\p{L}])(today|tonight|end of day|eod|by close of business|cob)(?![\p{L}])/u.test(haystack)) {
    return isoDate(now);
  }
  if (/(?<![\p{L}])tomorrow(?![\p{L}])/u.test(haystack)) return isoDate(addDays(now, 1));

  const inDays = /(?:in|within)\s+(\d+)\s+(day|days|week|weeks)/.exec(haystack);
  if (inDays !== null) {
    const count = Number(inDays[1]);
    const unit = inDays[2] ?? 'day';
    return isoDate(addDays(now, unit.startsWith('week') ? count * 7 : count));
  }

  if (/(?<![\p{L}])(end of (the )?week|eow)(?![\p{L}])/u.test(haystack)) {
    return isoDate(nextWeekday(now, 5, false));
  }
  if (/(?<![\p{L}])next week(?![\p{L}])/u.test(haystack)) return isoDate(addDays(now, 7));

  for (const [index, name] of WEEKDAYS.entries()) {
    const matcher = new RegExp(`(?<![\\p{L}])(next\\s+)?${name}(?![\\p{L}])`, 'u');
    const match = matcher.exec(haystack);
    if (match !== null) return isoDate(nextWeekday(now, index, match[1] !== undefined));
  }

  return null;
}

/** The coming `weekday`; `forceNextWeek` pushes past one that is only days away. */
function nextWeekday(now: Date, weekday: number, forceNextWeek: boolean): Date {
  const current = now.getUTCDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) delta = 7; // "by Friday" said on a Friday means the next one.
  if (forceNextWeek && delta < 7) delta += 7;
  return addDays(now, delta);
}

// ---------------------------------------------------------------------------
// Shape analysis
// ---------------------------------------------------------------------------

interface Shape {
  readonly interrogative: boolean;
  /** Leads with a request for information — beats assignment shape. */
  readonly informational: boolean;
  readonly assignmentShaped: boolean;
  readonly due: string | null;
}

function analyse(rest: string, now: Date): Shape {
  const haystack = key(rest);
  const lead = firstWord(rest);
  const due = parseDue(rest, now);

  const interrogative = squash(rest).endsWith('?') || WH_WORDS.includes(lead) || AUX_STARTERS.includes(lead);

  const hasInfoMarker = containsAny(haystack, INFO_MARKERS);
  const informational =
    WH_WORDS.includes(lead) ||
    hasInfoMarker ||
    // "can you ...?" is a question only if what follows asks for knowledge.
    (AUX_STARTERS.includes(lead) && squash(rest).endsWith('?') && !containsAny(haystack, MUTATION_VERBS));

  const assignmentShaped =
    containsAny(haystack, OBLIGATION_MARKERS) ||
    containsAny(haystack, MUTATION_VERBS) ||
    due !== null;

  return { interrogative, informational, assignmentShaped, due };
}

function isFiller(text: string): boolean {
  const haystack = key(text);
  if (haystack === '') return true;
  if (haystack.split(' ').length > 4) return false;
  return FILLER.some((word) => haystack === word || haystack.startsWith(word + ' '));
}

// ---------------------------------------------------------------------------
// Addressee resolution
// ---------------------------------------------------------------------------

type Addressee =
  | { readonly who: 'lily'; readonly rest: string }
  | { readonly who: 'human'; readonly employee: EmployeeProfile; readonly rest: string }
  | { readonly who: 'nobody' };

/**
 * Who is this line pointed at?
 *
 * Note the asymmetry between the human and Lily branches — it is the bias, not
 * an oversight. See the header.
 */
function resolveAddressee(text: string, roster: Roster): Addressee {
  const withoutGreeting = squash(text.replace(GREETING_PREFIX, ''));
  const greeted = withoutGreeting !== squash(text);

  for (const alias of roster.aliasesLongestFirst) {
    const employee = roster.byName(alias);
    if (employee === null) continue;

    const leading = leadingVocative(withoutGreeting, alias);
    if (leading !== null) return { who: 'human', employee, rest: leading };
  }

  for (const alias of roster.botAliases) {
    const leading = leadingVocative(withoutGreeting, alias);
    if (leading === null) continue;

    // Strong signals: a comma after her name, an "@", or a greeting in front.
    const strong =
      greeted ||
      new RegExp(`^@?${escapeRegex(alias)}\\s*[,:;—–-]`, 'iu').test(withoutGreeting) ||
      withoutGreeting.trimStart().startsWith('@');
    if (strong) return { who: 'lily', rest: leading };

    // Weak signal: bare name. Accept only when a direct-address word follows,
    // which is what separates "Lily book the room" from "Lily already booked it".
    if (DIRECT_ADDRESS_FOLLOWERS.includes(firstWord(leading))) {
      return { who: 'lily', rest: leading };
    }
  }

  // Trailing vocative: "how does the login flow work, Sarah?"
  const trailing = /[,\s]+@?([\p{L}][\p{L}\p{N}'-]*)\s*[?.!]*$/u.exec(squash(text));
  const trailingName = trailing?.[1];
  if (trailingName !== undefined) {
    const employee = roster.byName(trailingName);
    if (employee !== null) {
      return { who: 'human', employee, rest: stripTrailingVocative(text, trailingName) };
    }
    if (roster.botAliases.includes(trailingName.toLowerCase())) {
      return { who: 'lily', rest: stripTrailingVocative(text, trailingName) };
    }
  }

  return { who: 'nobody' };
}

/**
 * The remainder after a leading `alias`, or null if `alias` does not lead.
 *
 * The trailing boundary is load-bearing. Without it "Priya's going to handle
 * the customer call" reads as a vocative addressed to Priya, when it is someone
 * talking *about* Priya — a different rule with a different owner.
 */
function leadingVocative(text: string, alias: string): string | null {
  const matcher = new RegExp(
    `^@?${escapeRegex(alias)}(?![\\p{L}\\p{N}'’])\\s*(?:[,:;—–-]\\s*)?(.*)$`,
    'isu',
  );
  const match = matcher.exec(text.trim());
  if (match === null) return null;

  const rest = squash(match[1] ?? '');
  return rest === '' ? null : rest;
}

// ---------------------------------------------------------------------------
// Relay detection: "Lily, tell John to fix the build"
// ---------------------------------------------------------------------------

interface RelayMatch {
  readonly employee: EmployeeProfile;
  readonly remainder: string;
  /** True for "ask X how ..." — a question to route, not a message to pass on. */
  readonly isQuestion: boolean;
}

function detectRelay(rest: string, roster: Roster): RelayMatch | null {
  const matcher = /^(tell|ask|remind|let|check with|ping|get)\s+(.+)$/iu;
  const match = matcher.exec(squash(rest));
  if (match === null) return null;

  const verb = (match[1] ?? '').toLowerCase();
  const tail = squash(match[2] ?? '');

  for (const alias of roster.aliasesLongestFirst) {
    const employee = roster.byName(alias);
    if (employee === null) continue;

    const named = new RegExp(`^@?${escapeRegex(alias)}(?![\\p{L}\\p{N}])\\s*(.*)$`, 'isu');
    const hit = named.exec(tail);
    if (hit === null) continue;

    const remainder = squash(hit[1] ?? '');

    // "ask Sarah how the login flow works" wants Sarah's *agent*.
    // "ask Sarah to fix the build" wants Sarah, the person.
    const questionish =
      (verb === 'ask' || verb === 'check with' || verb === 'ping') &&
      !/^to\s/i.test(remainder) &&
      (WH_WORDS.includes(firstWord(remainder)) ||
        /^(about|if|whether)\s/i.test(remainder) ||
        containsAny(key(remainder), INFO_MARKERS));

    return { employee, remainder, isQuestion: questionish };
  }

  return null;
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

export function classify(input: ClassifyInput): Classification {
  const text = squash(input.text);
  if (text === '') return { kind: 'chatter', rule: 'empty' };
  if (isFiller(text)) return { kind: 'chatter', rule: 'filler' };

  const { roster, now } = input;
  const addressee = resolveAddressee(text, roster);

  // -- Rule 1: Lily is being spoken to. -------------------------------------
  if (addressee.who === 'lily') {
    const rest = addressee.rest;
    if (isFiller(rest)) return { kind: 'chatter', rule: 'filler' };

    const relay = detectRelay(rest, roster);
    if (relay !== null) {
      if (relay.isQuestion) {
        return {
          kind: 'routed_question',
          rule: 'lily.route_question',
          target: relay.employee,
          question: squash(relay.remainder.replace(/^(about|if|whether)\s+/i, '')),
          mode: 'read_only',
        };
      }

      return {
        kind: 'lily_action',
        rule: 'lily.relay_to_human',
        instruction: rest,
        relayTo: relay.employee,
        due: parseDue(rest, now),
      };
    }

    return {
      kind: 'lily_action',
      rule: 'lily.addressed',
      instruction: rest,
      due: parseDue(rest, now),
    };
  }

  // -- Rule 2: a person is being spoken to. ---------------------------------
  if (addressee.who === 'human') {
    const { employee, rest } = addressee;
    if (isFiller(rest)) return { kind: 'chatter', rule: 'filler' };

    const shape = analyse(rest, now);

    // Deliberate: this branch does not care whether Lily is named inside the
    // sentence. "John, ask Lily to book the room" is John's to action, and
    // Lily acting on it would be her taking an instruction off a human's plate.
    if (shape.informational || (shape.interrogative && !shape.assignmentShaped)) {
      return {
        kind: 'routed_question',
        rule: 'human.addressed.question',
        target: employee,
        question: rest,
        mode: 'read_only',
      };
    }

    return {
      kind: 'human_assignment',
      rule: 'human.addressed.assignment',
      owner: employee,
      text: rest,
      due: shape.due,
    };
  }

  // -- Rule 3: nobody addressed. Log what looks like work, act on nothing. --
  const shape = analyse(text, now);

  const selfLead = /^(i'?ll|i will|i'?m going to|i am going to|i'?ve got|i can take|i'?ll take)\b/i;
  if (selfLead.test(text) && shape.assignmentShaped && input.speakerEmployeeId !== null) {
    const speaker = roster.byId(input.speakerEmployeeId);
    if (speaker !== null) {
      return {
        kind: 'human_assignment',
        rule: 'self.assignment',
        owner: speaker,
        text,
        due: shape.due,
      };
    }
  }

  const mentions = roster.mentions(text);
  const firstMention = mentions[0];
  if (firstMention !== undefined && shape.assignmentShaped && !shape.informational) {
    // "John's going to finish the auth refactor by Sunday" — third-person, no
    // vocative. Recorded so the wrap-up can confirm it. Still silent.
    return {
      kind: 'human_assignment',
      rule: 'human.third_person_assignment',
      owner: firstMention.employee,
      text,
      due: shape.due,
    };
  }

  const namesLily = roster.botAliases.some((alias) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(alias)}(?![\\p{L}\\p{N}])`, 'iu').test(text),
  );
  if (namesLily) {
    // "We should get Lily to schedule that." Mentioned, not addressed. Nothing
    // happens until someone actually turns and asks her.
    return { kind: 'chatter', rule: 'mentioned_not_addressed' };
  }

  return { kind: 'chatter', rule: 'no_addressee' };
}

// ---------------------------------------------------------------------------
// Task text
// ---------------------------------------------------------------------------

/**
 * Reduce an utterance to the item it describes.
 *
 * "John, make sure you finish the auth refactor by Sunday" is a sentence; the
 * task is "finish the auth refactor", and the Sunday is already captured in
 * `due`. Leaving the sentence whole makes the wrap-up read back "you've got
 * make sure you finish the auth refactor by Sunday by 2026-07-26", which is
 * both ungrammatical and says the deadline twice.
 *
 * Conservative on purpose: it strips only the framing it recognises and leaves
 * anything else alone. A slightly long task is fine; a task with its verb
 * chopped off is not.
 */
export function taskTextFrom(raw: string): string {
  let text = squash(raw);

  text = text.replace(
    /^(please\s+)?(make sure(?: that)?\s+)?(?:you|we|they)?\s*(?:need to|needs to|have to|has to|must|should|will|are going to|is going to|going to)\s+/i,
    '',
  );
  text = text.replace(/^(?:please|kindly)\s+/i, '');
  text = text.replace(/^(?:make sure(?: that)?\s+)?(?:you|we)\s+/i, '');
  text = text.replace(/^(?:don'?t forget to|remember to|be sure to|take care of)\s+/i, '');

  // The deadline lives in `due`; saying it twice is worse than not saying it.
  text = text.replace(
    /[,;]?\s*\b(?:by|before|due)\s+(?:the\s+)?(?:end of (?:the )?(?:day|week)|eod|eow|cob|today|tonight|tomorrow|next week|next (?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{4}-\d{2}-\d{2})\b\s*$/i,
    '',
  );
  text = text.replace(
    /[,;]?\s*\bon\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day\b\s*$/i,
    '',
  );

  return squash(text).replace(/[.?!]+$/, '');
}

// ---------------------------------------------------------------------------
// Yes / no
// ---------------------------------------------------------------------------

const AFFIRMATIVE = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'go ahead', 'go for it',
  'approved', 'approve', 'do it', 'sounds good', 'confirmed', 'confirm',
  'please do', "that's right", 'correct', 'affirmative', 'ship it',
  'green light', 'fine by me', 'works for me', 'permission granted', 'granted',
  'yes please', 'of course', 'absolutely',
];

const NEGATIVE = [
  'no', 'nope', 'nah', "don't", 'dont', 'do not', 'stop', 'cancel', 'hold off',
  'hold on', 'deny', 'denied', 'negative', 'not yet', 'absolutely not',
  'no thanks', 'skip it', 'leave it', 'never mind', 'nevermind', 'reject',
];

export type Answer = 'yes' | 'no' | 'unclear';

/**
 * Read a spoken yes or no.
 *
 * "unclear" is a real outcome and not a fallback to "yes": a hedge ("maybe",
 * "I guess so") is treated as no answer at all, and the permission relay lets
 * it run out the clock into a denial. Mixed signals ("yeah, no") are unclear
 * for the same reason.
 */
export function readAnswer(text: string): Answer {
  const haystack = key(text);
  if (haystack === '') return 'unclear';

  const positive = containsAny(haystack, AFFIRMATIVE);
  const negative = containsAny(haystack, NEGATIVE);

  if (positive && negative) return 'unclear';
  if (negative) return 'no';
  if (positive) return 'yes';
  return 'unclear';
}

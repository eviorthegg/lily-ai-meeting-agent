/**
 * The classifier's job, tested as a table of things people actually say.
 *
 * The asymmetry in these expectations is the product requirement, not test
 * convenience: several cases here are deliberately classified *away* from
 * `lily_action` even though a helpful reading would act on them. Acting on an
 * instruction that was addressed to a human is the worst failure this system
 * has, so the traps get their own section and the invariant is asserted
 * separately at the bottom.
 */

import { describe, expect, it } from 'vitest';

import { classify, parseDue, readAnswer, type Classification } from './classify.js';
import { Roster } from './roster.js';
import type { EmployeeProfile } from './types.js';

const BOT_NAME = 'Lily (AI assistant)';

const PEOPLE: readonly EmployeeProfile[] = [
  {
    employeeId: 'emp_sarah',
    name: 'Sarah Chen',
    aliases: ['sarah'],
    jobDescription: 'Backend engineer — authentication and the login flow',
    agentKind: 'claude-code',
    capabilities: ['github'],
    daemonEnrolled: true,
  },
  {
    employeeId: 'emp_john',
    name: 'John Alvarez',
    aliases: ['john'],
    jobDescription: 'Platform engineer — CI and the auth refactor',
    agentKind: 'claude-code',
    capabilities: ['github', 'shell'],
    daemonEnrolled: true,
  },
  {
    employeeId: 'emp_marcus',
    name: 'Marcus Webb',
    aliases: ['marcus'],
    jobDescription: 'Frontend engineer — dashboard',
    agentKind: 'cursor',
    capabilities: [],
    daemonEnrolled: true,
  },
  {
    employeeId: 'emp_priya',
    name: 'Priya Nair',
    aliases: ['priya'],
    jobDescription: 'Product manager — roadmap and scheduling',
    agentKind: 'codex',
    capabilities: ['google-calendar'],
    daemonEnrolled: true,
  },
  {
    employeeId: 'emp_dana',
    name: 'Dana Okafor',
    aliases: ['dana'],
    jobDescription: 'Designer',
    agentKind: null,
    capabilities: [],
    daemonEnrolled: false,
  },
];

const roster = new Roster(PEOPLE, BOT_NAME);

/** A Saturday, so "by Sunday" and "by Friday" land on different weeks. */
const NOW = new Date('2026-07-25T10:00:00.000Z');

function run(text: string, speaker: string | null = 'emp_priya'): Classification {
  return classify({ text, speakerEmployeeId: speaker, roster, now: NOW });
}

// ---------------------------------------------------------------------------

interface Row {
  readonly say: string;
  readonly speaker?: string;
  readonly expect: Classification['kind'];
  /** employeeId of the owner / target / relay recipient, where one applies. */
  readonly who?: string;
  readonly why: string;
}

describe('classify — direct requests to Lily', () => {
  const rows: readonly Row[] = [
    {
      say: 'Lily, book a meeting with Chris tomorrow',
      expect: 'lily_action',
      why: 'named, comma, imperative — the canonical direct request',
    },
    {
      say: "Hey Lily, what's on my plate?",
      expect: 'lily_action',
      why: 'greeting plus name is a direct address',
    },
    {
      say: 'Lily can you share your screen?',
      expect: 'lily_action',
      why: 'no comma, but a direct-address verb follows her name',
    },
    {
      say: '@Lily set a reminder for the standup',
      expect: 'lily_action',
      why: 'an @ mention is an unambiguous address',
    },
    {
      say: 'Lily, share the action items',
      expect: 'lily_action',
      why: 'something she can actually do herself',
    },
  ];

  for (const row of rows) {
    it(`${row.expect}: "${row.say}" — ${row.why}`, () => {
      expect(run(row.say, row.speaker).kind).toBe(row.expect);
    });
  }
});

describe('classify — human-to-human assignments (silent, never acted on)', () => {
  const rows: readonly Row[] = [
    {
      say: 'John, make sure you finish the auth refactor by Sunday',
      expect: 'human_assignment',
      who: 'emp_john',
      why: 'the brief\'s own example: obligation language plus a deadline',
    },
    {
      say: 'Sarah, please push the fix before Friday',
      expect: 'human_assignment',
      who: 'emp_sarah',
      why: '"please" plus a deadline is an assignment, not a question',
    },
    {
      say: 'Marcus you need to update the dashboard',
      expect: 'human_assignment',
      who: 'emp_marcus',
      why: 'a bare leading name is enough to address a human',
    },
    {
      say: "Priya's going to handle the customer call on Thursday",
      expect: 'human_assignment',
      who: 'emp_priya',
      why: 'third person, no vocative — still work, still recorded silently',
    },
    {
      say: 'Dana, can you fix the spacing on the settings page by Friday?',
      expect: 'human_assignment',
      who: 'emp_dana',
      why: 'question-shaped, but a mutation verb and a deadline make it an assignment',
    },
    {
      say: "I'll finish the migration by tomorrow",
      speaker: 'emp_sarah',
      expect: 'human_assignment',
      who: 'emp_sarah',
      why: 'a self-assignment is still an action item worth reading back',
    },
  ];

  for (const row of rows) {
    it(`${row.expect}: "${row.say}" — ${row.why}`, () => {
      const result = run(row.say, row.speaker);
      expect(result.kind).toBe('human_assignment');
      if (result.kind === 'human_assignment' && row.who !== undefined) {
        expect(result.owner.employeeId).toBe(row.who);
      }
    });
  }

  it('extracts the deadline that was actually said', () => {
    const result = run('John, make sure you finish the auth refactor by Sunday');
    expect(result.kind).toBe('human_assignment');
    if (result.kind !== 'human_assignment') return;
    // Said on Saturday 2026-07-25, so "Sunday" is the next day.
    expect(result.due).toBe('2026-07-26');
  });

  it('leaves due null when nobody named one', () => {
    const result = run('Marcus you need to update the dashboard');
    expect(result.kind).toBe('human_assignment');
    if (result.kind !== 'human_assignment') return;
    expect(result.due).toBeNull();
  });
});

describe('classify — questions routed to a person', () => {
  const rows: readonly Row[] = [
    {
      say: 'Sarah, how does the login flow work?',
      expect: 'routed_question',
      who: 'emp_sarah',
      why: 'the brief\'s own example: a wh-question aimed at a named person',
    },
    {
      say: 'Marcus, can you walk us through the dashboard changes?',
      expect: 'routed_question',
      who: 'emp_marcus',
      why: '"walk us through" asks for knowledge, not for work',
    },
    {
      say: "Sarah, what's the status of the deploy?",
      expect: 'routed_question',
      who: 'emp_sarah',
      why: '"deploy" as a noun must not read as the mutating verb',
    },
    {
      say: 'how does the auth refactor land, John?',
      expect: 'routed_question',
      who: 'emp_john',
      why: 'trailing vocative addresses just as well as a leading one',
    },
    {
      say: 'Lily, ask Sarah how the login flow works',
      expect: 'routed_question',
      who: 'emp_sarah',
      why: 'an instruction to Lily to route a question — Sarah\'s agent, not Sarah',
    },
    {
      say: 'Lily, ask Priya about the roadmap',
      expect: 'routed_question',
      who: 'emp_priya',
      why: '"ask X about Y" is a routed question, not a message to pass on',
    },
  ];

  for (const row of rows) {
    it(`${row.expect}: "${row.say}" — ${row.why}`, () => {
      const result = run(row.say, row.speaker);
      expect(result.kind).toBe('routed_question');
      if (result.kind === 'routed_question' && row.who !== undefined) {
        expect(result.target.employeeId).toBe(row.who);
      }
    });
  }

  it('routed questions are always read-only', () => {
    const result = run('Sarah, how does the login flow work?');
    expect(result.kind).toBe('routed_question');
    if (result.kind !== 'routed_question') return;
    expect(result.mode).toBe('read_only');
  });
});

describe('classify — the traps', () => {
  it('"Lily, tell John to fix the build" is an instruction TO Lily ABOUT John', () => {
    const result = run('Lily, tell John to fix the build');

    // Lily acts: she relays it out loud. This is a lily_action.
    expect(result.kind).toBe('lily_action');
    if (result.kind !== 'lily_action') return;

    // And John is the one who owns the work — which is what stops this from
    // becoming a dispatch into John's machine.
    expect(result.relayTo?.employeeId).toBe('emp_john');
  });

  it('"Lily, remind Marcus to update the changelog" relays rather than dispatches', () => {
    const result = run('Lily, remind Marcus to update the changelog');
    expect(result.kind).toBe('lily_action');
    if (result.kind !== 'lily_action') return;
    expect(result.relayTo?.employeeId).toBe('emp_marcus');
  });

  it('"John, ask Lily to book the room" stays John\'s, even though it names Lily', () => {
    // The dangerous reading is that Lily should book the room. She should not:
    // the sentence was addressed to John, and it is his to action.
    const result = run('John, ask Lily to book the room');
    expect(result.kind).toBe('human_assignment');
    if (result.kind !== 'human_assignment') return;
    expect(result.owner.employeeId).toBe('emp_john');
  });

  it('being mentioned is not being addressed', () => {
    expect(run('We should get Lily to schedule that').kind).toBe('chatter');
    expect(run('Maybe Lily can do it, I don\'t know').kind).toBe('chatter');
  });

  it('a bare leading "Lily" without a direct-address verb is not an address', () => {
    // "Lily already booked the room" is someone reporting, not instructing.
    expect(run('Lily already booked the room').kind).toBe('chatter');
    expect(run('Lily was in the last one too').kind).toBe('chatter');
  });

  it('an unaddressed question is nobody\'s to answer', () => {
    expect(run('does anyone know why CI is slow?').kind).toBe('chatter');
    expect(run('the build is red again').kind).toBe('chatter');
  });

  it('acknowledgements are not instructions', () => {
    for (const filler of ['yeah', 'ok', 'got it', 'sure', 'thanks', 'hmm']) {
      expect(run(filler).kind).toBe('chatter');
    }
  });
});

describe('classify — the invariant that matters most', () => {
  /**
   * Every utterance that was aimed at a human, in every phrasing the table
   * covers. None of them may come back as something Lily executes on her own
   * initiative.
   */
  const addressedToHumans: readonly string[] = [
    'John, make sure you finish the auth refactor by Sunday',
    'Sarah, please push the fix before Friday',
    'Marcus you need to update the dashboard',
    'John, ask Lily to book the room',
    'Dana, can you fix the spacing on the settings page by Friday?',
    "Priya's going to handle the customer call on Thursday",
    'Sarah, deploy the hotfix when CI is green',
    'Marcus, take the design review tomorrow',
    'John — own the migration this sprint',
    'Priya, don\'t forget the customer follow-up',
  ];

  for (const say of addressedToHumans) {
    it(`never acts on: "${say}"`, () => {
      const result = run(say);
      expect(result.kind).not.toBe('lily_action');
    });
  }

  it('a human assignment never carries a relay instruction back to Lily', () => {
    for (const say of addressedToHumans) {
      const result = run(say);
      if (result.kind === 'lily_action') throw new Error('unreachable — asserted above');
      expect(result.kind === 'human_assignment' || result.kind === 'routed_question').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe('parseDue', () => {
  it('resolves relative dates against the injected clock', () => {
    expect(parseDue('by tomorrow', NOW)).toBe('2026-07-26');
    expect(parseDue('today please', NOW)).toBe('2026-07-25');
    expect(parseDue('in 3 days', NOW)).toBe('2026-07-28');
    expect(parseDue('in 2 weeks', NOW)).toBe('2026-08-08');
    expect(parseDue('next week', NOW)).toBe('2026-08-01');
  });

  it('pushes a weekday that has already passed today into next week', () => {
    // NOW is a Saturday; "by Saturday" means the next one, not today.
    expect(parseDue('by Saturday', NOW)).toBe('2026-08-01');
  });

  it('honours an explicit ISO date', () => {
    expect(parseDue('by 2026-09-01', NOW)).toBe('2026-09-01');
  });

  it('returns null when no deadline was said', () => {
    expect(parseDue('update the dashboard', NOW)).toBeNull();
  });
});

describe('readAnswer', () => {
  it('reads a plain yes and a plain no', () => {
    expect(readAnswer('yes')).toBe('yes');
    expect(readAnswer('yeah go ahead')).toBe('yes');
    expect(readAnswer('approved')).toBe('yes');
    expect(readAnswer('no')).toBe('no');
    expect(readAnswer("don't")).toBe('no');
    expect(readAnswer('hold off for now')).toBe('no');
  });

  it('treats a hedge as no answer at all', () => {
    // Not "no", and emphatically not "yes": the caller lets it time out, and a
    // timeout denies.
    expect(readAnswer('maybe')).toBe('unclear');
    expect(readAnswer('hmm let me think')).toBe('unclear');
    expect(readAnswer('what does it want to do')).toBe('unclear');
  });

  it('treats mixed signals as unclear', () => {
    expect(readAnswer('yeah, no')).toBe('unclear');
  });
});

// ---------------------------------------------------------------------------

describe('Roster', () => {
  it('refuses a participant whose name collides with the wake word', () => {
    expect(
      () =>
        new Roster(
          [
            {
              employeeId: 'emp_lily',
              name: 'Lily Fraser',
              aliases: [],
              jobDescription: 'Engineer',
              agentKind: null,
              capabilities: [],
              daemonEnrolled: false,
            },
          ],
          BOT_NAME,
        ),
      // Every "Lily, ..." in the room would be ambiguous, and the ambiguity
      // resolves in the acting direction. Fail at construction instead.
    ).toThrow(/shares a name with the assistant/);
  });

  it('refuses to guess between two people with the same first name', () => {
    const ambiguous = new Roster(
      [
        { ...PEOPLE[0]!, employeeId: 'emp_a', name: 'Sarah Chen', aliases: ['sarah'] },
        { ...PEOPLE[0]!, employeeId: 'emp_b', name: 'Sarah Diaz', aliases: ['sarah'] },
      ],
      BOT_NAME,
    );
    expect(ambiguous.byName('sarah')).toBeNull();
    expect(ambiguous.isAmbiguous('sarah')).toBe(true);
    expect(ambiguous.byName('sarah chen')?.employeeId).toBe('emp_a');
  });
});

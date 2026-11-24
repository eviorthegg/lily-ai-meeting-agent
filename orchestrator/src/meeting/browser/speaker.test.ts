/**
 * Speaker → employee, and the cases where the honest answer is "I don't know".
 *
 * This is the single most consequential mapping in the product. The permission
 * gate only accepts the owning employee's own spoken "yes", so an attribution
 * that guesses is a permission granted on the strength of a guess — on
 * somebody's actual machine, for a command they did not say.
 *
 * Every test below is really the same test: **uncertainty must produce null**,
 * because null denies.
 */

import { describe, expect, it } from 'vitest';

import type { EmployeeProfile } from '../../types.js';
import { SpeakerResolver, SpeakerTracker, cleanDisplayName } from './speaker.js';

const BOT = 'Lily (AI assistant)';

function employee(overrides: Partial<EmployeeProfile> & { employeeId: string; name: string }): EmployeeProfile {
  return {
    aliases: [],
    jobDescription: '',
    agentKind: null,
    capabilities: [],
    daemonEnrolled: true,
    ...overrides,
  };
}

const DIRECTORY: readonly EmployeeProfile[] = [
  employee({ employeeId: 'emp_sarah', name: 'Sarah Chen', aliases: ['sar'] }),
  employee({ employeeId: 'emp_john', name: 'John Rivera' }),
  employee({ employeeId: 'emp_amit', name: 'Amit Shah' }),
];

function resolver(directory: readonly EmployeeProfile[] = DIRECTORY): SpeakerResolver {
  let counter = 0;
  return new SpeakerResolver({
    directory,
    botDisplayName: BOT,
    newParticipantId: () => `p_${++counter}`,
  });
}

describe('a name the roster knows resolves to that employee', () => {
  it('matches a full name', () => {
    expect(resolver().resolve('Sarah Chen').employeeId).toBe('emp_sarah');
  });

  it('matches a first name', () => {
    expect(resolver().resolve('John').employeeId).toBe('emp_john');
  });

  it('matches a declared alias', () => {
    expect(resolver().resolve('sar').employeeId).toBe('emp_sarah');
  });

  it('strips the decoration platforms bolt onto a tile label', () => {
    // Meet appends "(You)", Zoom appends "(Host)", and a host who cannot be
    // identified is a host who cannot approve their own agent.
    const r = resolver();
    expect(r.resolve('John Rivera (Host)').employeeId).toBe('emp_john');
    expect(r.resolve('Amit Shah (You)').employeeId).toBe('emp_amit');
    expect(r.resolve('  Sarah   Chen  ').employeeId).toBe('emp_sarah');
  });

  it('gives the same participant id to the same person twice', () => {
    const r = resolver();
    const first = r.resolve('Sarah Chen');
    const second = r.resolve('sarah chen');
    expect(second.participantId).toBe(first.participantId);
  });
});

describe('the unknown speaker: every uncertain case is null', () => {
  it('an external guest is present but not identified', () => {
    const guest = resolver().resolve('Dana from Acme');
    expect(guest.employeeId).toBeNull();
    // Still a participant: they can talk to Lily, they simply cannot approve
    // anything, because they have no agent of their own to approve.
    expect(guest.displayName).toBe('Dana from Acme');
    expect(guest.isBot).toBe(false);
  });

  it('an ambiguous first name is null, not a coin flip', () => {
    const twoSarahs = resolver([
      ...DIRECTORY,
      employee({ employeeId: 'emp_sarah2', name: 'Sarah Kowalski' }),
    ]);
    expect(twoSarahs.resolve('Sarah').employeeId).toBeNull();
    // The full name is still unambiguous and still resolves.
    expect(twoSarahs.resolve('Sarah Kowalski').employeeId).toBe('emp_sarah2');
  });

  it('a speaker the DOM will not name at all is anonymous, not dropped', () => {
    // Losing the sentence entirely would be worse: the room heard it.
    const unknown = resolver().resolve(null);
    expect(unknown.employeeId).toBeNull();
    expect(unknown.displayName).toBe('unidentified speaker');
  });

  it('an empty or whitespace label is the same as no label', () => {
    const r = resolver();
    expect(r.resolve('   ').displayName).toBe('unidentified speaker');
    expect(r.resolve('   ').employeeId).toBeNull();
  });

  it('reports isKnownEmployee false for everything it could not pin down', () => {
    const r = resolver();
    expect(r.isKnownEmployee('Sarah Chen')).toBe(true);
    expect(r.isKnownEmployee('Dana from Acme')).toBe(false);
    expect(r.isKnownEmployee('')).toBe(false);
  });
});

describe("Lily's own tile is never a speaker", () => {
  it('recognises the bot by its configured display name', () => {
    const r = resolver();
    const self = r.resolve(BOT);
    expect(self.isBot).toBe(true);
    expect(self.employeeId).toBeNull();
  });

  it('recognises the bot by its wake word alone', () => {
    // Platforms truncate long names in the tile label.
    expect(resolver().resolve('Lily').isBot).toBe(true);
    expect(resolver().isBotName('lily (ai assistant)')).toBe(true);
  });

  it('does not mistake a human for the bot', () => {
    expect(resolver().resolve('Sarah Chen').isBot).toBe(false);
  });
});

describe('cleanDisplayName', () => {
  it('removes presence words without eating the name', () => {
    expect(cleanDisplayName('Amit Shah is speaking')).toBe('Amit Shah');
    expect(cleanDisplayName('John Rivera (Co-host), muted')).toBe('John Rivera');
  });

  it('leaves a name that needs no cleaning alone', () => {
    expect(cleanDisplayName('Sarah Chen')).toBe('Sarah Chen');
  });
});

describe('the speaker highlight is debounced, because it flickers', () => {
  it('ignores a name that does not hold', () => {
    const tracker = new SpeakerTracker(350);
    // A cough in the middle of someone else's sentence.
    expect(tracker.observe('Sarah Chen', 0).changed).toBe(false);
    expect(tracker.observe('John Rivera', 100).changed).toBe(false);
    expect(tracker.observe('Sarah Chen', 200).changed).toBe(false);
    expect(tracker.current).toBeNull();
  });

  it('settles on a name that holds for the full window', () => {
    const tracker = new SpeakerTracker(350);
    expect(tracker.observe('Sarah Chen', 0).changed).toBe(false);
    expect(tracker.observe('Sarah Chen', 200).changed).toBe(false);

    const settled = tracker.observe('Sarah Chen', 400);
    expect(settled).toEqual({ changed: true, speaker: 'Sarah Chen' });
    expect(tracker.current).toBe('Sarah Chen');
  });

  it('reports silence falling as its own change, not as "nothing settled"', () => {
    // The distinction the API exists for: "nobody is speaking now" is an event,
    // and collapsing it into `null` would make it indistinguishable from "still
    // deciding".
    const tracker = new SpeakerTracker(350);
    tracker.observe('Sarah Chen', 0);
    tracker.observe('Sarah Chen', 400);
    expect(tracker.current).toBe('Sarah Chen');

    expect(tracker.observe(null, 500).changed).toBe(false);
    expect(tracker.observe(null, 900)).toEqual({ changed: true, speaker: null });
    expect(tracker.current).toBeNull();
  });

  it('does not re-announce a speaker who is still speaking', () => {
    const tracker = new SpeakerTracker(350);
    tracker.observe('John Rivera', 0);
    tracker.observe('John Rivera', 400);
    expect(tracker.observe('John Rivera', 800).changed).toBe(false);
    expect(tracker.observe('John Rivera', 5_000).changed).toBe(false);
  });
});

/**
 * The join state machine.
 *
 * These tests exist because the alternative — a straight line of awaits — makes
 * "the host never clicked admit" and "the vendor renamed a button" produce the
 * same message. The machine's only job is to make a stall say *where*, and that
 * is what is asserted here.
 */

import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../util/clock.js';
import { JoinStateError, JoinStateMachine, isTerminal } from './state.js';

describe('the join state machine moves forward and only forward', () => {
  it('walks the full documented sequence', () => {
    const machine = new JoinStateMachine(new ManualClock());

    machine.to('navigating');
    machine.to('name-entry');
    machine.to('lobby');
    machine.to('admitted');
    machine.to('in-call');
    machine.to('left');

    expect(machine.trail()).toBe('idle>navigating>name-entry>lobby>admitted>in-call>left');
  });

  it('lets a platform skip states it does not have', () => {
    // Jitsi with the name already in the URL and no lobby goes almost straight
    // through. Skipping forward is legal; that is the point of an ordering
    // rather than a table of adjacent pairs.
    const machine = new JoinStateMachine(new ManualClock());
    machine.to('navigating');
    machine.to('in-call');
    expect(machine.state).toBe('in-call');
  });

  it('refuses to go backwards', () => {
    const machine = new JoinStateMachine(new ManualClock());
    machine.to('navigating');
    machine.to('admitted');

    expect(() => machine.to('lobby')).toThrow(JoinStateError);
    // And the message says what the legal shape is, rather than just "invalid".
    expect(() => machine.to('name-entry')).toThrow(/moves forward through/);
    expect(machine.state).toBe('admitted');
  });

  it('treats re-entering the same state as a no-op, not an error', () => {
    // A driver polling the lobby must not have to remember whether it already
    // announced it, and twenty identical history entries help nobody.
    const machine = new JoinStateMachine(new ManualClock());
    machine.to('navigating');
    machine.to('lobby');
    machine.to('lobby');
    machine.to('lobby');
    expect(machine.history.filter((entry) => entry.state === 'lobby')).toHaveLength(1);
  });

  it('can fail from anywhere, and can still record teardown afterwards', () => {
    const machine = new JoinStateMachine(new ManualClock());
    machine.to('navigating');
    machine.to('failed', 'selector missing');

    expect(isTerminal(machine.state)).toBe(true);
    // The browser still has to be closed, and that it was is worth having.
    machine.to('left');
    expect(machine.trail()).toBe('idle>navigating>failed>left');
  });

  it('will not resurrect a meeting that has been left', () => {
    const machine = new JoinStateMachine(new ManualClock());
    machine.to('navigating');
    machine.to('in-call');
    machine.to('left');
    expect(() => machine.to('in-call')).toThrow(JoinStateError);
  });
});

describe('a stall says where it stalled, because that decides whose problem it is', () => {
  const clock = (): ManualClock => new ManualClock();

  it('names the lobby as a person who has not clicked admit', () => {
    const time = clock();
    const machine = new JoinStateMachine(time);
    machine.to('navigating');
    machine.to('lobby');
    time.advance(92_000);

    const stall = machine.describeStall();
    expect(stall).toContain('lobby');
    expect(stall).toContain('92s');
    // The distinguishing sentence: this is not a code failure.
    expect(stall).toContain('admitted');
  });

  it('names name-entry as a field that has moved', () => {
    const time = clock();
    const machine = new JoinStateMachine(time);
    machine.to('navigating');
    machine.to('name-entry');
    time.advance(15_000);

    expect(machine.describeStall()).toContain('guest-name field');
  });

  it('distinguishes "page never loaded" from "call UI never rendered"', () => {
    const navigating = new JoinStateMachine(clock());
    navigating.to('navigating');
    expect(navigating.describeStall()).toContain('never finished loading');

    const admitted = new JoinStateMachine(clock());
    admitted.to('navigating');
    admitted.to('admitted');
    expect(admitted.describeStall()).toContain('in-call UI never rendered');
  });

  it('measures elapsed time in the current state, not since the start', () => {
    const time = clock();
    const machine = new JoinStateMachine(time);
    machine.to('navigating');
    time.advance(30_000);
    machine.to('lobby');
    time.advance(5_000);

    expect(machine.elapsedMs).toBe(5_000);
  });
});

import { describe, expect, it } from 'vitest';
import { Backoff } from './backoff.js';

describe('Backoff', () => {
  it('never exceeds maxMs however many attempts have failed', () => {
    // random() === 1 is the worst case: full jitter returns the whole window.
    const backoff = new Backoff({ baseMs: 1_000, maxMs: 30_000, random: () => 1 });

    for (let i = 0; i < 100; i += 1) {
      expect(backoff.next()).toBeLessThanOrEqual(30_000);
    }
  });

  it('never returns a delay that would produce a tight reconnect loop', () => {
    const backoff = new Backoff({ baseMs: 1_000, maxMs: 30_000, random: () => 0 });

    for (let i = 0; i < 20; i += 1) {
      expect(backoff.next()).toBeGreaterThanOrEqual(500);
    }
  });

  it('grows the window exponentially up to the ceiling', () => {
    const backoff = new Backoff({ baseMs: 1_000, maxMs: 30_000, factor: 2, random: () => 1 });

    expect(backoff.next()).toBe(1_000);
    expect(backoff.next()).toBe(2_000);
    expect(backoff.next()).toBe(4_000);
    expect(backoff.next()).toBe(8_000);
    expect(backoff.next()).toBe(16_000);
    expect(backoff.next()).toBe(30_000);
    expect(backoff.next()).toBe(30_000);
  });

  it('spreads concurrent daemons across the window rather than clustering them', () => {
    // Two daemons that failed at the same instant must not retry at the same instant.
    const a = new Backoff({ baseMs: 1_000, maxMs: 30_000, random: () => 0.9 });
    const b = new Backoff({ baseMs: 1_000, maxMs: 30_000, random: () => 0.1 });

    a.next();
    b.next();
    a.next();
    b.next();

    expect(a.next()).not.toBe(b.next());
  });

  it('resets to the cheap window after a successful connection', () => {
    const backoff = new Backoff({ baseMs: 1_000, maxMs: 30_000, random: () => 1 });

    backoff.next();
    backoff.next();
    backoff.next();
    expect(backoff.attempt).toBe(3);

    backoff.reset();
    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(1_000);
  });
});

/**
 * The voice gate.
 *
 * Every test here is about one property: nothing gets approved that the owning
 * employee did not, out loud, approve. Silence does not. A colleague does not.
 * A hedge does not. And some things are not approvable at all and are never put
 * to the room in the first place.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { PermissionRelay, type PermissionDecision, type PermissionSubmission } from './permissions.js';
import { ManualClock } from './util/clock.js';

const TIMEOUT_SEC = 45; // config.permissions.voiceApprovalTimeoutSec
const OWNER = 'emp_sarah';
const BYSTANDER = 'emp_john';

interface Harness {
  readonly relay: PermissionRelay;
  readonly clock: ManualClock;
  readonly spoken: string[];
  readonly decisions: PermissionDecision[];
}

function harness(overrides: { maxQueued?: number; selfRequestImpliesApproval?: boolean } = {}): Harness {
  const clock = new ManualClock();
  const spoken: string[] = [];
  const decisions: PermissionDecision[] = [];

  const relay = new PermissionRelay({
    timeoutSec: TIMEOUT_SEC,
    maxQueued: overrides.maxQueued ?? 10,
    selfRequestImpliesApproval: overrides.selfRequestImpliesApproval ?? true,
    nameOf: (employeeId) => (employeeId === OWNER ? 'Sarah' : 'John'),
    voice: async (line) => {
      spoken.push(line);
    },
    respond: (decision) => {
      decisions.push(decision);
    },
    clock,
    timers: clock,
  });

  return { relay, clock, spoken, decisions };
}

function request(overrides: Partial<PermissionSubmission> = {}): PermissionSubmission {
  return {
    requestId: 'req_1',
    taskId: 'tsk_1',
    kind: 'shell',
    detail: 'npm run migrate',
    ownerEmployeeId: OWNER,
    receivedAt: new Date(),
    selfRequested: false,
    requestedText: null,
    ...overrides,
  };
}

/** Let the relay's internal awaits settle. Independent of the manual clock. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------

describe('permission relay — who may approve', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('grants when the owning employee says yes', async () => {
    h.relay.submit(request());
    await settle();

    expect(h.spoken[0]).toContain('npm run migrate');
    h.relay.hear(OWNER, 'yes go ahead');

    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0]).toMatchObject({ approved: true, reason: 'granted' });
  });

  it('a third party saying yes does nothing at all', async () => {
    h.relay.submit(request());
    await settle();

    const consumed = h.relay.hear(BYSTANDER, 'yeah go for it');

    // Not consumed as an answer, and crucially not settled either way — the
    // owner can still speak, and until they do nothing has been decided.
    expect(consumed).toBe(false);
    expect(h.decisions).toHaveLength(0);
    expect(h.relay.activeRequestId).toBe('req_1');
  });

  it('a third party cannot deny on the owner\'s behalf either', async () => {
    h.relay.submit(request());
    await settle();

    h.relay.hear(BYSTANDER, 'no, definitely not');
    expect(h.decisions).toHaveLength(0);

    // The owner still has the floor.
    h.relay.hear(OWNER, 'yes');
    expect(h.decisions[0]).toMatchObject({ approved: true });
  });

  it('records wrong_speaker when a bystander tried and the owner never answered', async () => {
    h.relay.submit(request());
    await settle();

    h.relay.hear(BYSTANDER, 'yes');
    h.clock.advance(TIMEOUT_SEC * 1000 + 1);

    expect(h.decisions).toHaveLength(1);
    // Distinct from a plain timeout in the audit log: somebody did try to
    // approve this, and it was not the person whose machine it is.
    expect(h.decisions[0]).toMatchObject({ approved: false, reason: 'wrong_speaker' });
  });
});

describe('permission relay — silence and hedging deny', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('denies at the timeout when nobody answers', async () => {
    h.relay.submit(request());
    await settle();

    h.clock.advance(TIMEOUT_SEC * 1000 - 1);
    expect(h.decisions).toHaveLength(0);

    h.clock.advance(2);
    expect(h.decisions[0]).toMatchObject({ approved: false, reason: 'timeout' });
  });

  it('an ambiguous answer is not an approval and runs out the clock', async () => {
    h.relay.submit(request());
    await settle();

    h.relay.hear(OWNER, 'hmm, maybe');
    h.relay.hear(OWNER, 'what does it want to do exactly');
    expect(h.decisions).toHaveLength(0);

    h.clock.advance(TIMEOUT_SEC * 1000 + 1);
    expect(h.decisions[0]).toMatchObject({ approved: false, reason: 'timeout' });
  });

  it('an explicit no denies immediately', async () => {
    h.relay.submit(request());
    await settle();

    h.relay.hear(OWNER, 'no, leave it');
    expect(h.decisions[0]).toMatchObject({ approved: false, reason: 'denied' });
  });

  it('the window opens when the question is asked, not when it was queued', async () => {
    h.relay.submit(request());
    h.relay.submit(request({ requestId: 'req_2', taskId: 'tsk_2', detail: 'npm test' }));
    await settle();

    // The second request has not been voiced yet, so its clock has not started.
    h.clock.advance(TIMEOUT_SEC * 1000 + 1);
    expect(h.decisions).toHaveLength(1);
    await settle();

    expect(h.spoken.some((line) => line.includes('npm test'))).toBe(true);
    h.relay.hear(OWNER, 'yes');
    expect(h.decisions[1]).toMatchObject({ approved: true, requestId: 'req_2' });
  });
});

describe('permission relay — hard-blocked actions', () => {
  it('never voices a hard-blocked action as approvable', async () => {
    const h = harness();
    h.relay.submit(request({ kind: 'delete', detail: 'rm -rf ./services' }));
    await settle();

    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0]).toMatchObject({ approved: false, reason: 'hard_blocked' });

    // The room is told it happened and that it was stopped. It is never asked.
    // The line may well contain the word "approve" — it says she *cannot* — so
    // the assertion is against the prompt's actual shape, not the vocabulary.
    const line = h.spoken.join(' ');
    expect(line).toContain('blocked');
    expect(line).not.toContain('Is that okay?');
    expect(line).not.toContain('your agent wants to');
    expect(h.relay.activeRequestId).toBeNull();
  });

  it('blocks every hard-blocked kind, not just delete', async () => {
    for (const kind of ['vcs_push_protected', 'delete', 'deploy', 'credential_access'] as const) {
      const h = harness();
      h.relay.submit(request({ kind, detail: `do ${kind}` }));
      await settle();
      expect(h.decisions[0]).toMatchObject({ approved: false, reason: 'hard_blocked' });
      expect(h.spoken.join(' ')).not.toContain('Is that okay?');
    }
  });

  it('a hard-blocked request cannot be approved by anyone afterwards', async () => {
    const h = harness();
    h.relay.submit(request({ kind: 'deploy', detail: 'deploy to prod' }));
    await settle();

    h.relay.hear(OWNER, 'yes, approved');
    // Still exactly one decision, still a denial.
    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0]?.approved).toBe(false);
  });
});

describe('permission relay — one at a time', () => {
  it('voices only one request and queues the rest', async () => {
    const h = harness();

    h.relay.submit(request({ requestId: 'req_1', detail: 'npm run migrate' }));
    h.relay.submit(request({ requestId: 'req_2', taskId: 'tsk_2', detail: 'npm test' }));
    h.relay.submit(request({ requestId: 'req_3', taskId: 'tsk_3', detail: 'npm install zod' }));
    await settle();

    const prompts = h.spoken.filter((line) => /is that okay/i.test(line));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('npm run migrate');
    expect(h.relay.queuedCount).toBe(2);
  });

  it('moves to the next request only after the current one resolves', async () => {
    const h = harness();
    h.relay.submit(request({ requestId: 'req_1', detail: 'npm run migrate' }));
    h.relay.submit(request({ requestId: 'req_2', taskId: 'tsk_2', detail: 'npm test' }));
    await settle();

    h.relay.hear(OWNER, 'yes');
    await settle();

    const prompts = h.spoken.filter((line) => /is that okay/i.test(line));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('npm test');
  });

  it('refuses to queue past maxQueuedRequests', async () => {
    const h = harness({ maxQueued: 1 });

    h.relay.submit(request({ requestId: 'req_1' }));
    await settle();
    h.relay.submit(request({ requestId: 'req_2', taskId: 'tsk_2' }));
    h.relay.submit(request({ requestId: 'req_3', taskId: 'tsk_3' }));

    const overflow = h.decisions.find((decision) => decision.requestId === 'req_3');
    expect(overflow).toMatchObject({ approved: false, reason: 'denied' });
  });
});

describe('permission relay — repeating back, and the narrow self-request rule', () => {
  it('repeats the command verbatim before asking', async () => {
    const h = harness();
    const detail = 'psql -c "DROP INDEX idx_sessions_stale"';
    h.relay.submit(request({ kind: 'shell', detail }));
    await settle();

    // Verbatim, character for character. A paraphrase of a command is not the
    // thing the owner would be approving.
    expect(h.spoken[0]).toContain(detail);
  });

  it('skips the prompt only when the owner literally said the command', async () => {
    const h = harness();
    h.relay.submit(
      request({
        selfRequested: true,
        detail: 'npm test',
        requestedText: 'Lily, get my agent to run npm test on the auth branch',
      }),
    );
    await settle();

    expect(h.decisions[0]).toMatchObject({ approved: true, reason: 'granted' });
    expect(h.spoken).toHaveLength(0);
  });

  it('still asks when the agent wants something beyond what was said', async () => {
    const h = harness();
    h.relay.submit(
      request({
        selfRequested: true,
        detail: 'rm -rf node_modules && npm install',
        requestedText: 'Lily, get my agent to run npm test on the auth branch',
      }),
    );
    await settle();

    // Self-request covers the named action and nothing else.
    expect(h.decisions).toHaveLength(0);
    expect(h.spoken[0]).toContain('rm -rf node_modules');
  });

  it('honours selfRequestImpliesApproval being off', async () => {
    const h = harness({ selfRequestImpliesApproval: false });
    h.relay.submit(
      request({ selfRequested: true, detail: 'npm test', requestedText: 'run npm test' }),
    );
    await settle();

    expect(h.decisions).toHaveLength(0);
    expect(h.spoken[0]).toContain('npm test');
  });
});

describe('permission relay — teardown', () => {
  it('denies everything outstanding when the meeting ends', async () => {
    const h = harness();
    h.relay.submit(request({ requestId: 'req_1' }));
    h.relay.submit(request({ requestId: 'req_2', taskId: 'tsk_2' }));
    await settle();

    h.relay.dispose();

    expect(h.decisions).toHaveLength(2);
    expect(h.decisions.every((decision) => !decision.approved)).toBe(true);
  });

  it('drops requests belonging to a cancelled task', async () => {
    const h = harness();
    h.relay.submit(request({ requestId: 'req_1', taskId: 'tsk_1' }));
    h.relay.submit(request({ requestId: 'req_2', taskId: 'tsk_2' }));
    await settle();

    h.relay.cancelTask('tsk_2');
    expect(h.decisions.find((decision) => decision.requestId === 'req_2')).toMatchObject({
      approved: false,
    });
  });

  it('auto-approved kinds never spend the room\'s attention', async () => {
    const h = harness();
    h.relay.submit(request({ kind: 'read', detail: 'read src/auth/login.ts' }));
    await settle();

    expect(h.decisions[0]).toMatchObject({ approved: true, reason: 'granted' });
    expect(h.spoken).toHaveLength(0);
  });
});

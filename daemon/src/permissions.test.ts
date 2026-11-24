import { describe, expect, it, vi } from 'vitest';
import { tierFor } from '@lily/shared';
import {
  PermissionGate,
  classifyCommand,
  classifyFull,
  decide,
  type PendingRequest,
} from './permissions.js';

const standard = { mode: 'standard', selfRequested: false } as const;

describe('classification', () => {
  it('auto-approves non-mutating inspection', () => {
    for (const command of ['cat src/auth.ts', 'grep -r login .', 'git log --oneline', 'ls -la']) {
      expect(tierFor(classifyFull(command)), command).toBe('auto');
    }
  });

  it('gates mutation, tests, installs and network calls', () => {
    for (const command of ['npm test', 'npm install lodash', 'curl https://x.dev', 'git commit -m x']) {
      expect(tierFor(classifyFull(command)), command).toBe('gated');
    }
  });

  it('hard-blocks destruction, deploys and credential access', () => {
    for (const command of [
      'rm -rf node_modules',
      'kubectl apply -f prod.yaml',
      'cat ~/.aws/credentials',
      'git reset --hard HEAD~3',
      'npm publish',
    ]) {
      expect(tierFor(classifyFull(command)), command).toBe('blocked');
    }
  });

  it('classifies an unrecognised command as shell rather than read', () => {
    // Failing toward the strict tier is the whole point — an unknown binary must
    // never inherit an auto-approval.
    expect(classifyCommand('./scripts/mystery-binary --yolo')).toBe('shell');
    expect(tierFor(classifyCommand('./scripts/mystery-binary --yolo'))).toBe('gated');
  });

  describe('git push', () => {
    it('hard-blocks a push to a protected branch', () => {
      expect(classifyFull('git push origin main')).toBe('vcs_push_protected');
      expect(classifyFull('git push origin production')).toBe('vcs_push_protected');
    });

    it('treats a feature-branch push as an ordinary gated write', () => {
      expect(tierFor(classifyFull('git push origin feature/login-fix'))).toBe('gated');
    });

    it('hard-blocks force push regardless of branch', () => {
      expect(tierFor(classifyFull('git push --force origin feature/x'))).toBe('blocked');
      expect(tierFor(classifyFull('git push -f origin anything'))).toBe('blocked');
    });
  });

  describe('command chaining', () => {
    it('takes the strictest kind across a chain', () => {
      // The attack this defends: smuggling a blocked action behind an innocuous one.
      expect(tierFor(classifyFull('npm test && rm -rf .'))).toBe('blocked');
      expect(tierFor(classifyFull('ls; kubectl apply -f prod.yaml'))).toBe('blocked');
      expect(tierFor(classifyFull('cat x.ts | grep foo'))).toBe('auto');
    });

    it('treats command substitution as unrecognised', () => {
      // Substitution can hide anything, so it cannot be auto-approved.
      expect(tierFor(classifyFull('cat $(find / -name id_rsa)'))).not.toBe('auto');
      expect(tierFor(classifyFull('echo `whoami`'))).not.toBe('auto');
    });
  });
});

describe('decisions', () => {
  it('never asks about a hard-blocked action', () => {
    // Voicing these would train people to approve destructive operations.
    for (const command of ['rm -rf /', 'git push --force origin main', 'cat ~/.ssh/id_rsa']) {
      const decision = decide({ command, ...standard });
      expect(decision.outcome, command).toBe('refuse');
    }
  });

  it('asks about a gated action in standard mode', () => {
    const decision = decide({ command: 'npm test', ...standard });
    expect(decision.outcome).toBe('ask');
    if (decision.outcome === 'ask') expect(decision.detail).toBe('npm test');
  });

  it('allows an auto action without asking', () => {
    const decision = decide({ command: 'git diff', ...standard });
    expect(decision.outcome).toBe('allow');
  });

  it('refuses rather than asks when the task was dispatched read-only', () => {
    // A question should not interrupt the meeting to request a mutation it never needed.
    const decision = decide({ command: 'npm test', mode: 'read_only', selfRequested: false });
    expect(decision.outcome).toBe('refuse');
  });

  describe('self-requested actions', () => {
    it('covers the write and network calls a spoken request implies', () => {
      // "Lily, book a meeting with Chris" — re-prompting the asker adds no security.
      for (const command of ['curl -X POST https://calendar.googleapis.com/events', 'git commit -m "notes"']) {
        const decision = decide({ command, mode: 'standard', selfRequested: true });
        expect(decision.outcome, command).toBe('allow');
      }
    });

    it('still gates shell, test and install even for the requester', () => {
      // No sentence spoken in a meeting implies "run arbitrary commands on my laptop".
      for (const command of ['npm test', 'npm install left-pad', './deploy-helper.sh']) {
        const decision = decide({ command, mode: 'standard', selfRequested: true });
        expect(decision.outcome, command).toBe('ask');
      }
    });

    it('never lets a self-request unlock a hard-blocked action', () => {
      const decision = decide({ command: 'rm -rf .', mode: 'standard', selfRequested: true });
      expect(decision.outcome).toBe('refuse');
    });
  });
});

describe('PermissionGate', () => {
  function makeGate() {
    const asked: PendingRequest[] = [];
    const gate = new PermissionGate({ onAsk: (r) => asked.push(r) }, { backstopMs: 50 });
    return { gate, asked };
  }

  it('emits no request for a hard-blocked action', async () => {
    const { gate, asked } = makeGate();
    const result = await gate.request('t1', 'r1', { command: 'rm -rf .', ...standard });

    expect(asked).toHaveLength(0);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('hard_blocked');
  });

  it('emits no request for an auto action', async () => {
    const { gate, asked } = makeGate();
    const result = await gate.request('t1', 'r1', { command: 'git log', ...standard });

    expect(asked).toHaveLength(0);
    expect(result.approved).toBe(true);
  });

  it('blocks until the meeting responds, then proceeds', async () => {
    const { gate, asked } = makeGate();
    const pending = gate.request('t1', 'r1', { command: 'npm test', ...standard });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.detail).toBe('npm test');

    gate.resolve('r1', { approved: true, reason: 'granted' });
    await expect(pending).resolves.toMatchObject({ approved: true, reason: 'granted' });
  });

  it('denies on the local backstop when no response ever arrives', async () => {
    vi.useFakeTimers();
    try {
      const { gate } = makeGate();
      const pending = gate.request('t1', 'r1', { command: 'npm test', ...standard });
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({ approved: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a response for an unknown request', () => {
    const { gate } = makeGate();
    expect(gate.resolve('never-issued', { approved: true, reason: 'granted' })).toBe(false);
  });

  it('denies everything outstanding when the meeting ends', async () => {
    const { gate } = makeGate();
    const a = gate.request('t1', 'r1', { command: 'npm test', ...standard });
    const b = gate.request('t2', 'r2', { command: 'npm install x', ...standard });

    expect(gate.pendingCount).toBe(2);
    gate.abandonAll();

    await expect(a).resolves.toMatchObject({ approved: false });
    await expect(b).resolves.toMatchObject({ approved: false });
    expect(gate.pendingCount).toBe(0);
  });
});

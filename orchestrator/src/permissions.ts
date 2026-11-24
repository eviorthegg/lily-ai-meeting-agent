/**
 * Voice-gated permission relay.
 *
 * An employee's agent hits something it will not do unsupervised. That request
 * arrives here, and this module decides whether it ever reaches the room, who
 * is allowed to answer it, and what happens when nobody does.
 *
 * The rules, in the order they bind:
 *
 *   1. Hard-blocked kinds are never voiced. They are not "usually declined" —
 *      there is no phrasing of them that a room could approve, so offering them
 *      out loud would teach people that pressure works. They are refused before
 *      anyone hears about them.
 *   2. One request is voiced at a time. A queue of spoken yes/no questions is
 *      how the wrong "yes" lands on the wrong question.
 *   3. Only the owning employee's answer counts. A colleague saying "yeah go
 *      for it" is not consent from the person whose machine it is, and it is
 *      not treated as input at all — it does not approve and it does not deny.
 *   4. Silence and hedging deny. The window closes at
 *      `config.permissions.voiceApprovalTimeoutSec` and the answer is no.
 *
 * Point 4 is the one that matters most: absence of an answer is a denial, never
 * a default-allow, and every path out of this module that is not an explicit
 * "yes" from the owner ends in `approved: false`.
 */

import { tierFor, type ActionKind } from '@lily/shared/protocol';
import { readAnswer } from './classify.js';
import { speech } from './speech.js';
import { log } from './util/log.js';
import type { Clock, TimerHandle, Timers } from './util/clock.js';
import { systemClock, systemTimers } from './util/clock.js';
import type { PendingPermission, PermissionOutcome } from './types.js';

export interface PermissionDecision {
  readonly taskId: string;
  readonly requestId: string;
  readonly approved: boolean;
  readonly reason: PermissionOutcome;
}

export interface PermissionSubmission extends PendingPermission {
  /**
   * True when the owner themselves asked for this task out loud in the meeting.
   * Combined with `selfRequestImpliesApproval` and an exact-substring check it
   * can skip the second prompt — see `#impliedByOwnRequest`.
   */
  readonly selfRequested: boolean;
  /** The owner's original spoken instruction, for the exact-match check only. */
  readonly requestedText: string | null;
}

export interface PermissionRelayOptions {
  readonly timeoutSec: number;
  readonly maxQueued: number;
  readonly selfRequestImpliesApproval: boolean;
  /** Resolve an employeeId to how the room refers to them. */
  readonly nameOf: (employeeId: string) => string;
  /**
   * Put a line in Lily's mouth. Resolves when it has actually been spoken —
   * the approval window opens then, not when the request was queued, so a
   * request that waits behind a long answer still gets its full window.
   */
  readonly voice: (line: string, pending: PendingPermission) => Promise<void>;
  /** Send the decision back down the wire. */
  readonly respond: (decision: PermissionDecision) => void;
  readonly onAudit?: (entry: PermissionAuditEntry) => void;
  readonly clock?: Clock;
  readonly timers?: Timers;
}

export interface PermissionAuditEntry {
  readonly action: 'permission.granted' | 'permission.denied' | 'permission.timed_out';
  readonly taskId: string;
  readonly requestId: string;
  readonly ownerEmployeeId: string;
  readonly kind: ActionKind;
  /** The command itself, which is what `AuditLogDoc.detail` is for. Never output. */
  readonly detail: string;
  readonly reason: PermissionOutcome;
  readonly at: Date;
}

interface ActiveRequest {
  readonly pending: PendingPermission;
  readonly timer: TimerHandle;
  /** Set when someone who is not the owner tried to approve. */
  wrongSpeakerAttempt: boolean;
}

export class PermissionRelay {
  readonly #options: PermissionRelayOptions;
  readonly #clock: Clock;
  readonly #timers: Timers;
  readonly #queue: PermissionSubmission[] = [];
  #active: ActiveRequest | null = null;
  #voicing = false;
  #disposed = false;

  constructor(options: PermissionRelayOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? systemTimers;
  }

  get activeRequestId(): string | null {
    return this.#active?.pending.requestId ?? null;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  /** Accept a `permission.request` from a daemon. */
  submit(request: PermissionSubmission): void {
    if (this.#disposed) {
      this.#settle(request, false, 'denied');
      return;
    }

    const tier = tierFor(request.kind);

    // Rule 1. Never reaches the room.
    if (tier === 'blocked') {
      log.warn('permission.hard_blocked', {
        taskId: request.taskId,
        requestId: request.requestId,
        kind: request.kind,
      });
      this.#settle(request, false, 'hard_blocked');
      // The room is told it happened and that it was stopped — not asked.
      void this.#options.voice(
        speech.permissionBlocked(this.#options.nameOf(request.ownerEmployeeId), request),
        request,
      );
      return;
    }

    // A daemon should not be asking about auto-approved kinds; if one does,
    // grant without spending the room's attention on it.
    if (tier === 'auto') {
      this.#settle(request, true, 'granted');
      return;
    }

    if (this.#impliedByOwnRequest(request)) {
      log.info('permission.self_request_implied', {
        taskId: request.taskId,
        requestId: request.requestId,
        kind: request.kind,
      });
      this.#settle(request, true, 'granted');
      return;
    }

    if (this.#queue.length >= this.#options.maxQueued) {
      log.warn('permission.queue_full', {
        requestId: request.requestId,
        queued: this.#queue.length,
      });
      this.#settle(request, false, 'denied');
      return;
    }

    this.#queue.push(request);
    void this.#pump();
  }

  /**
   * Feed the relay something said in the room.
   *
   * Returns true when the utterance was consumed as an answer, so the caller
   * knows not to also classify it as a new instruction.
   */
  hear(speakerEmployeeId: string | null, text: string): boolean {
    const active = this.#active;
    if (active === null) return false;

    const answer = readAnswer(text);
    if (answer === 'unclear') return false;

    // Rule 3. Not the owner: not an answer. Recorded, then ignored — the owner
    // can still speak, and the attempt changes the audit reason if nobody does.
    if (speakerEmployeeId !== active.pending.ownerEmployeeId) {
      if (answer === 'yes') {
        active.wrongSpeakerAttempt = true;
        log.warn('permission.wrong_speaker_attempt', {
          requestId: active.pending.requestId,
          ownerEmployeeId: active.pending.ownerEmployeeId,
        });
      }
      return false;
    }

    this.#resolveActive(answer === 'yes' ? 'granted' : 'denied');
    return true;
  }

  /** Drop anything belonging to a cancelled task. */
  cancelTask(taskId: string): void {
    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      const queued = this.#queue[i];
      if (queued !== undefined && queued.taskId === taskId) {
        this.#queue.splice(i, 1);
        this.#settle(queued, false, 'denied');
      }
    }

    if (this.#active?.pending.taskId === taskId) this.#resolveActive('denied');
  }

  /** Deny everything outstanding. Called when the meeting ends. */
  dispose(): void {
    this.#disposed = true;

    // Queue first, then the active one: draining in this order keeps the exit
    // synchronous and cannot race the pump.
    while (this.#queue.length > 0) {
      const queued = this.#queue.shift();
      if (queued !== undefined) this.#settle(queued, false, 'denied');
    }

    if (this.#active !== null) this.#resolveActive('denied');
  }

  // -------------------------------------------------------------------------

  /**
   * `selfRequestImpliesApproval`, applied narrowly.
   *
   * Only when the command the agent wants to run appears *verbatim* inside what
   * the owner just asked for. Anything looser would be the orchestrator
   * deciding, on a similarity judgement, that a person consented to a command
   * they never said — which is the exact shape of the failure the voice gate
   * exists to prevent.
   */
  #impliedByOwnRequest(request: PermissionSubmission): boolean {
    if (!this.#options.selfRequestImpliesApproval) return false;
    if (!request.selfRequested) return false;

    const spoken = request.requestedText;
    if (spoken === null || spoken.trim() === '') return false;

    const detail = request.detail.trim().toLowerCase();
    if (detail.length < 3) return false;

    return spoken.toLowerCase().includes(detail);
  }

  async #pump(): Promise<void> {
    // Bail before touching the queue once disposed. `#resolveActive` ends by
    // pumping, so without this a teardown would pull the next request out of
    // the queue and suspend on `voice()`, leaving `dispose()`'s drain loop with
    // nothing to find and that request never answered.
    if (this.#disposed) return;
    if (this.#voicing) return; // Rule 2.
    if (this.#active !== null) return;

    const next = this.#queue.shift();
    if (next === undefined) return;

    this.#voicing = true;
    try {
      // The window opens when the question is actually asked.
      await this.#options.voice(
        speech.permissionPrompt(this.#options.nameOf(next.ownerEmployeeId), next),
        next,
      );
    } catch (cause) {
      this.#voicing = false;
      log.error('permission.voice_failed', {
        requestId: next.requestId,
        error: cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200),
      });
      // Could not ask, so it was not approved.
      this.#settle(next, false, 'denied');
      void this.#pump();
      return;
    }
    this.#voicing = false;

    if (this.#disposed) {
      this.#settle(next, false, 'denied');
      return;
    }

    const timer = this.#timers.after(this.#options.timeoutSec * 1000, () => {
      const current = this.#active;
      if (current === null) return;
      // Rule 4.
      this.#resolveActive(current.wrongSpeakerAttempt ? 'wrong_speaker' : 'timeout');
    });

    this.#active = { pending: next, timer, wrongSpeakerAttempt: false };
  }

  #resolveActive(outcome: Exclude<PermissionOutcome, 'hard_blocked'>): void {
    const active = this.#active;
    if (active === null) return;

    this.#timers.cancel(active.timer);
    this.#active = null;

    this.#settle(active.pending, outcome === 'granted', outcome);

    const ownerName = this.#options.nameOf(active.pending.ownerEmployeeId);
    const line =
      outcome === 'granted'
        ? speech.permissionGranted(active.pending.detail)
        : speech.permissionDenied(ownerName, active.pending.detail, outcome);
    void this.#options.voice(line, active.pending);

    void this.#pump();
  }

  #settle(pending: PendingPermission, approved: boolean, reason: PermissionOutcome): void {
    this.#options.respond({
      taskId: pending.taskId,
      requestId: pending.requestId,
      approved,
      reason,
    });

    this.#options.onAudit?.({
      action: approved
        ? 'permission.granted'
        : reason === 'timeout'
          ? 'permission.timed_out'
          : 'permission.denied',
      taskId: pending.taskId,
      requestId: pending.requestId,
      ownerEmployeeId: pending.ownerEmployeeId,
      kind: pending.kind,
      detail: pending.detail,
      reason,
      at: this.#clock.date(),
    });
  }
}

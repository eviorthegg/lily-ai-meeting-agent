/**
 * The meeting, orchestrated.
 *
 * This is the code path that must be identical under both brains. A brain
 * supplies ears and a voice; everything below decides what Lily does, and it
 * does it the same way whether the words arrived as speech from OpenAI's
 * Realtime session or as text typed into the local room.
 *
 * Responsibilities, in the order they matter:
 *
 *   - Classify every utterance, and act only on the ones addressed to Lily.
 *   - Dispatch to an employee's own agent without ever blocking the room. A
 *     task may take minutes; acknowledgement is immediate, the conversation
 *     carries on, and the answer re-enters when it arrives.
 *   - Relay permission requests through the voice gate.
 *   - Hold the meeting's tasks in RAM and read the unconfirmed ones back before
 *     the end.
 *   - Meter Lily's own consumption, and nothing else.
 *   - Wind down on its own: meeting end, empty room, silence, hard cap.
 *
 * Nothing here writes a transcript anywhere. The only content that leaves this
 * process is short task text and the summary — the two exceptions the data
 * policy names — plus the dispatch text an employee explicitly asked for, which
 * is transient and goes only to that employee's own machine.
 */

import type { LilyConfig } from '@lily/shared/config';

import { classify, readAnswer, taskTextFrom, type Classification } from './classify.js';
import { PermissionRelay, type PermissionAuditEntry } from './permissions.js';
import { Roster, spokenName } from './roster.js';
import { speech } from './speech.js';
import { SpeechScheduler } from './turn.js';
import { TaskMemory } from './tasks.js';
import { UsageMeter, type UsageSink } from './usage.js';
import { errorField, log } from './util/log.js';
import { newTaskId } from './util/ids.js';
import type { Clock, TimerHandle, Timers } from './util/clock.js';
import { systemClock, systemTimers } from './util/clock.js';
import type { EmployeeProfile, HeardUtterance, MeetingTask, Participant } from './types.js';
import type { BrainHooks, BrainPerson, LilyBrain } from './brain/types.js';
import type { MeetingAdapter, MeetingEndReason, Unsubscribe } from './meeting/adapter.js';
import type { DaemonLink, PermissionRequest, TaskDispatch } from './dispatch/link.js';
import type { RoomTaskView } from './meeting/local/wire.js';

// ---------------------------------------------------------------------------
// Outcome sink
// ---------------------------------------------------------------------------

export interface MeetingSummary {
  readonly meetingId: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationSec: number;
  readonly endReason: MeetingEndReason;
  readonly participantEmployeeIds: readonly string[];
  readonly externalParticipantCount: number;
  readonly taskCount: number;
  readonly unconfirmedCount: number;
  readonly dispatchedTaskCount: number;
}

/**
 * Where meeting output goes when the meeting is over.
 *
 * Three methods, and deliberately no fourth. There is no `recordUtterance`,
 * no `recordConversation`, no way for this process to hand a transcript to
 * anything — which is enforcement, not documentation.
 */
export interface MeetingOutcomeSink {
  recordTasks(tasks: readonly MeetingTask[]): void | Promise<void>;
  recordSummary(summary: MeetingSummary): void | Promise<void>;
  recordAudit(entry: PermissionAuditEntry): void | Promise<void>;
}

export const NULL_OUTCOME_SINK: MeetingOutcomeSink = {
  recordTasks: () => {},
  recordSummary: () => {},
  recordAudit: () => {},
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MeetingSessionOptions {
  readonly meetingId: string;
  readonly config: LilyConfig;
  readonly adapter: MeetingAdapter;
  readonly brain: LilyBrain;
  readonly daemon: DaemonLink;
  readonly directory: readonly EmployeeProfile[];
  readonly usageSink: UsageSink;
  readonly outcomeSink?: MeetingOutcomeSink;
  /**
   * How long a dispatched task may run before the daemon gives up. Injected
   * rather than read from config because `config.meeting` has no field for it
   * yet — see the orchestrator README's note on suggested shared-config additions.
   */
  readonly dispatchDeadlineSec?: number;
  readonly clock?: Clock;
  readonly timers?: Timers;
}

interface PendingConfirmation {
  readonly taskId: string;
  readonly ownerEmployeeId: string;
  readonly resolve: (confirmed: boolean) => void;
}

interface InFlightTask {
  readonly taskId: string;
  readonly employeeId: string;
  readonly requesterParticipantId: string;
  readonly askedAt: Date;
  /** What the requester said, for the narrow self-request approval check. */
  readonly requestedText: string;
  readonly selfRequested: boolean;
}

export class MeetingSession {
  readonly #options: MeetingSessionOptions;
  readonly #config: LilyConfig;
  readonly #clock: Clock;
  readonly #timers: Timers;
  readonly #roster: Roster;
  readonly #tasks: TaskMemory;
  readonly #meter: UsageMeter;
  readonly #scheduler: SpeechScheduler;
  readonly #relay: PermissionRelay;
  readonly #outcome: MeetingOutcomeSink;
  readonly #unsubscribes: Unsubscribe[] = [];
  readonly #participants = new Map<string, Participant>();
  readonly #inFlight = new Map<string, InFlightTask>();
  /** dispatch taskId → task-memory id, so a result can find its row. */
  readonly #taskIdByDispatch = new Map<string, string>();

  #startedAt: Date | null = null;
  #pendingConfirmation: PendingConfirmation | null = null;
  #silenceTimer: TimerHandle | null = null;
  #emptyRoomTimer: TimerHandle | null = null;
  #maxDurationTimer: TimerHandle | null = null;
  #ending = false;
  #ended: Promise<MeetingSummary> | null = null;
  #resolveEnded: ((summary: MeetingSummary) => void) | null = null;
  #externalParticipants = new Set<string>();

  constructor(options: MeetingSessionOptions) {
    this.#options = options;
    this.#config = options.config;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? systemTimers;
    this.#outcome = options.outcomeSink ?? NULL_OUTCOME_SINK;

    this.#roster = new Roster(options.directory, this.#config.meeting.botDisplayName);
    this.#tasks = new TaskMemory(() => this.#clock.date());

    this.#meter = new UsageMeter({
      sink: options.usageSink,
      flushIntervalSec: this.#config.meeting.usageFlushIntervalSec,
      clock: this.#clock,
      timers: this.#timers,
    });

    this.#scheduler = new SpeechScheduler({
      pauseMs: this.#config.realtime.turnDetection.silenceDurationMs,
      bargeInCutoffMs: this.#config.realtime.bargeInCutoffMs,
      speak: async (line) => {
        const output = await options.brain.render(line);
        await options.adapter.speak(output);
      },
      stopSpeaking: async () => {
        await options.brain.bargeIn();
        await options.adapter.stopSpeaking();
      },
      clock: this.#clock,
      timers: this.#timers,
    });

    this.#relay = new PermissionRelay({
      timeoutSec: this.#config.permissions.voiceApprovalTimeoutSec,
      maxQueued: this.#config.permissions.maxQueuedRequests,
      selfRequestImpliesApproval: this.#config.permissions.selfRequestImpliesApproval,
      nameOf: (employeeId) => this.#spokenNameOf(employeeId),
      voice: async (line) => {
        await this.#scheduler.say(line, 'permission', { mustDeliver: true });
      },
      respond: (decision) => {
        const employeeId = this.#inFlight.get(decision.taskId)?.employeeId;
        if (employeeId === undefined) return;
        void this.#options.daemon
          .respondToPermission(employeeId, {
            taskId: decision.taskId,
            requestId: decision.requestId,
            approved: decision.approved,
            reason: decision.reason,
          })
          .catch((cause: unknown) => {
            log.warn('permission.response_undeliverable', { error: errorField(cause) });
          });
      },
      onAudit: (entry) => {
        void this.#outcome.recordAudit(entry);
      },
      clock: this.#clock,
      timers: this.#timers,
    });
  }

  get tasks(): TaskMemory {
    return this.#tasks;
  }

  get roster(): Roster {
    return this.#roster;
  }

  /** Resolves when the meeting has fully wound down. */
  get finished(): Promise<MeetingSummary> {
    this.#ended ??= new Promise<MeetingSummary>((resolve) => {
      this.#resolveEnded = resolve;
    });
    return this.#ended;
  }

  /** Task memory, shaped for the room UI. */
  taskViews(): readonly RoomTaskView[] {
    return this.#tasks.all().map((task) => ({
      id: task.id,
      text: task.text,
      owner_employee_id: task.owner_employee_id,
      ownerName: this.#roster.byId(task.owner_employee_id)?.name ?? task.owner_employee_id,
      assigned_by: task.assigned_by,
      assignedByName: this.#roster.byId(task.assigned_by)?.name ?? task.assigned_by,
      due: task.due,
      status: task.status,
      type: task.type,
      created_at: task.created_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const { adapter, brain, daemon } = this.#options;

    if (brain.requiresAudio && !adapter.capabilities.audio) {
      throw new Error(
        `The ${brain.kind} brain needs an audio-capable platform, but the ${adapter.platform} ` +
          `adapter reports capabilities.audio === false. Use LILY_BRAIN=text with this platform.`,
      );
    }

    brain.attach(this.#hooks());

    const joined = await adapter.join();
    this.#startedAt = joined.joinedAt;
    for (const participant of joined.participants) {
      this.#participants.set(participant.participantId, participant);
    }

    await brain.start();
    this.#meter.start();
    this.#wire();
    this.#wireAudio();

    // Announced, not just listed. Consent depends on the room being told, and
    // this goes out ahead of the queue rather than waiting for a gap.
    await this.#scheduler.sayImmediately(
      speech.joinAnnouncement(this.#config.meeting.botDisplayName),
      'ambient',
    );

    this.#armSilenceTimer();
    this.#maxDurationTimer = this.#timers.after(this.#config.meeting.maxDurationSec * 1000, () => {
      void this.end('max_duration');
    });

    log.info('session.started', {
      meetingId: this.#options.meetingId,
      platform: adapter.platform,
      brain: brain.kind,
      connectedAgents: daemon.connectedEmployees().length,
    });
  }

  #wire(): void {
    const { adapter, daemon } = this.#options;

    this.#unsubscribes.push(
      adapter.onUtterance((utterance) => {
        void this.#onUtterance(utterance).catch((cause: unknown) => {
          log.error('session.utterance_failed', { error: errorField(cause) });
        });
      }),
      adapter.onParticipantJoin((participant) => this.#onParticipantJoin(participant)),
      adapter.onParticipantLeave((participant) => this.#onParticipantLeave(participant)),
      adapter.onMeetingEnd((reason) => {
        void this.end(reason);
      }),
      daemon.onStatus(({ payload }) => {
        void adapter.setStatus({
          state: payload.state,
          ...(payload.note === undefined ? {} : { note: payload.note }),
        });
      }),
      daemon.onResult(({ employeeId, payload }) => {
        void this.#onTaskResult(employeeId, payload.taskId, payload.ok, payload.answer, payload.error ?? null);
      }),
      daemon.onPermissionRequest(({ employeeId, payload }) => {
        this.#onPermissionRequest(employeeId, payload);
      }),
      daemon.onPresenceChange((employeeId, connected) => {
        log.info('session.agent_presence', { employeeId, connected });
      }),
    );
  }

  /**
   * Carry the platform's audio and speaker attribution into the brain.
   *
   * Two halves of one answer, and neither is useful alone:
   *
   *   - The **frames** are what the brain hears. Without this pump an
   *     audio-capable adapter is decorative — `getAudioStream()` would return a
   *     live PCM stream that nothing ever reads, and Lily would talk into a
   *     meeting she could not hear.
   *   - The **speaker** is who to attribute the resulting transcript to. No
   *     speech model diarizes a mixed meeting stream well enough to gate a
   *     permission on, and this product's whole permission model rests on
   *     knowing which human said "yes". A platform that marks the active
   *     speaker in its own UI already knows; the adapter reads it, and null
   *     means "could not tell", which denies.
   *
   * `onActiveSpeakerChange` is duck-typed rather than added to `MeetingAdapter`,
   * the same way `publishTasks` is: it is an adapter capability, not a contract
   * every adapter must implement, and the local text room has no such concept.
   */
  #wireAudio(): void {
    const { adapter, brain } = this.#options;
    if (!adapter.capabilities.audio) return;

    const speakerSource = adapter as {
      onActiveSpeakerChange?: (handler: (participant: Participant | null) => void) => Unsubscribe;
    };
    const unsubscribe = speakerSource.onActiveSpeakerChange?.((participant) => {
      brain.noteSpeaker(
        participant === null
          ? null
          : {
              participantId: participant.participantId,
              employeeId: participant.employeeId,
              displayName: participant.displayName,
            },
      );
    });
    if (unsubscribe !== undefined) this.#unsubscribes.push(unsubscribe);

    const stream = adapter.getAudioStream();
    if (stream === null) return;

    // Detached on purpose: the pump runs for the length of the meeting and
    // `start()` must not wait for it. It ends when the adapter closes the
    // stream, which `leave()` does.
    void (async () => {
      try {
        for await (const frame of stream) {
          if (this.#ending) break;
          await brain.hearAudio(frame);
        }
      } catch (cause) {
        log.warn('session.audio_pump_stopped', { error: errorField(cause) });
      }
    })();
  }

  /**
   * Wind the meeting down.
   *
   * Idempotent: the platform ending the call, the room emptying and the hard cap
   * can all fire at once, and only the first one should matter.
   */
  async end(reason: MeetingEndReason): Promise<MeetingSummary> {
    if (this.#ending) return this.finished;
    this.#ending = true;

    // Touch the lazy promise so `#resolveEnded` exists before anything below
    // can resolve it. A caller awaiting `finished` rather than `end()` must not
    // be able to miss the resolution by a tick.
    void this.finished;
    log.info('session.ending', { meetingId: this.#options.meetingId, reason });

    this.#clearTimer(this.#silenceTimer);
    this.#clearTimer(this.#emptyRoomTimer);
    this.#clearTimer(this.#maxDurationTimer);

    // A room that has already gone cannot confirm anything, and a bot that was
    // removed should not keep talking on the way out.
    const canSpeak = reason !== 'empty_room' && reason !== 'kicked' && reason !== 'error';

    if (canSpeak) {
      try {
        await this.#readBackUnconfirmed();
      } catch (cause) {
        log.warn('session.wrapup_failed', { error: errorField(cause) });
      }
      await this.#scheduler.say(speech.leaving(mapLeaveReason(reason)), 'wrapup', {
        mustDeliver: true,
      });
    }

    for (const inFlight of this.#inFlight.values()) {
      await this.#options.daemon
        .cancel(inFlight.employeeId, { taskId: inFlight.taskId, reason: 'meeting_ended' })
        .catch(() => undefined);
    }
    this.#inFlight.clear();

    this.#relay.dispose();
    await this.#scheduler.close();

    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes.length = 0;

    const summary = this.#buildSummary(reason);
    await this.#outcome.recordTasks(this.#tasks.all());
    await this.#outcome.recordSummary(summary);

    await this.#options.brain.stop();
    await this.#options.adapter.leave(reason);
    await this.#options.daemon.close();
    await this.#meter.close();

    // Task memory is dropped once it has been handed over. Nothing about this
    // meeting outlives the process.
    this.#tasks.clear();
    this.#participants.clear();

    this.#resolveEnded?.(summary);
    return summary;
  }

  #buildSummary(reason: MeetingEndReason): MeetingSummary {
    const startedAt = this.#startedAt ?? this.#clock.date();
    const endedAt = this.#clock.date();
    return {
      meetingId: this.#options.meetingId,
      startedAt,
      endedAt,
      durationSec: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)),
      endReason: reason,
      participantEmployeeIds: [
        ...new Set(
          [...this.#participants.values()]
            .map((participant) => participant.employeeId)
            .filter((id): id is string => id !== null),
        ),
      ],
      externalParticipantCount: this.#externalParticipants.size,
      taskCount: this.#tasks.all().length,
      unconfirmedCount: this.#tasks.unconfirmed().length,
      dispatchedTaskCount: this.#meter.dispatchedTaskCount,
    };
  }

  // -------------------------------------------------------------------------
  // Brain hooks — the shared orchestration surface
  // -------------------------------------------------------------------------

  #hooks(): BrainHooks {
    return {
      context: () => ({
        meetingId: this.#options.meetingId,
        botDisplayName: this.#config.meeting.botDisplayName,
        people: this.#roster.employees.map(
          (employee): BrainPerson => ({
            employeeId: employee.employeeId,
            name: employee.name,
            jobDescription: employee.jobDescription,
            capabilities: employee.capabilities,
            daemonEnrolled: employee.daemonEnrolled,
          }),
        ),
      }),
      classify: (utterance) =>
        classify({
          text: utterance.text,
          speakerEmployeeId: utterance.employeeId,
          roster: this.#roster,
          now: utterance.at,
        }),
      apply: (utterance, classification) => this.#apply(utterance, classification),
      meterAudioSec: (seconds) => this.#meter.addRealtimeAudioSec(seconds),
      meterReasoningTokens: (tokens) => this.#meter.addReasoningTokens(tokens),
      meterTtsChars: (chars) => this.#meter.addTtsChars(chars),
    };
  }

  // -------------------------------------------------------------------------
  // Inbound speech
  // -------------------------------------------------------------------------

  async #onUtterance(utterance: HeardUtterance): Promise<void> {
    this.#scheduler.noteRoomSpeech();
    this.#armSilenceTimer();

    // Order matters. An answer to a question Lily just asked is an answer, not
    // a new instruction — classifying "yes" as an action would be absurd, and
    // classifying it as chatter would drop an approval on the floor.
    if (this.#relay.hear(utterance.employeeId, utterance.text)) return;
    if (this.#consumeConfirmation(utterance)) return;

    await this.#options.brain.hear(utterance);
  }

  #consumeConfirmation(utterance: HeardUtterance): boolean {
    const pending = this.#pendingConfirmation;
    if (pending === null) return false;

    // Same rule as the permission gate: only the person the item belongs to can
    // say it is theirs.
    if (utterance.employeeId !== pending.ownerEmployeeId) return false;

    const answer = readAnswer(utterance.text);
    if (answer === 'unclear') return false;

    this.#pendingConfirmation = null;
    pending.resolve(answer === 'yes');
    return true;
  }

  /**
   * Everything that follows from a classification.
   *
   * This is the whole policy, and it is the same under both brains.
   */
  async #apply(utterance: HeardUtterance, classification: Classification): Promise<void> {
    switch (classification.kind) {
      case 'chatter':
        return;

      case 'human_assignment': {
        // Silent. Logged, never spoken, never dispatched — this instruction was
        // for a person and Lily acting on it is the failure this product cannot
        // have. It surfaces at the wrap-up read-back and nowhere before it.
        this.#recordAssignment(
          classification.owner.employeeId,
          utterance.employeeId ?? 'external',
          taskTextFrom(classification.text),
          classification.due,
        );
        log.info('task.assignment_recorded', {
          rule: classification.rule,
          ownerEmployeeId: classification.owner.employeeId,
          hasDue: classification.due !== null,
        });
        return;
      }

      case 'routed_question': {
        await this.#dispatch({
          target: classification.target,
          text: classification.question,
          mode: 'read_only',
          utterance,
          selfRequested: classification.target.employeeId === utterance.employeeId,
        });
        return;
      }

      case 'lily_action': {
        if (classification.relayTo !== undefined) {
          // "Lily, tell John to fix the build." Lily acts — she says it out
          // loud — and John's item is recorded. What does not happen is a
          // dispatch to John's agent: nobody asked his machine for anything.
          const relayText = taskTextFrom(stripRelayPrefix(classification.instruction));
          this.#recordAssignment(
            classification.relayTo.employeeId,
            utterance.employeeId ?? 'external',
            relayText,
            classification.due,
          );
          await this.#scheduler.say(
            speech.relayToHuman(spokenName(classification.relayTo), relayText),
            'answer',
          );
          return;
        }

        await this.#performLilyAction(utterance, classification.instruction);
        return;
      }
    }
  }

  /** How the room refers to someone. See `spokenName`. */
  #spokenNameOf(employeeId: string): string {
    const profile = this.#roster.byId(employeeId);
    return profile === null ? employeeId : spokenName(profile);
  }

  #recordAssignment(
    ownerEmployeeId: string,
    assignedBy: string,
    text: string,
    due: string | null,
  ): MeetingTask {
    const task = this.#tasks.add({
      text,
      owner_employee_id: ownerEmployeeId,
      assigned_by: assignedBy,
      due,
      type: 'human_assignment',
      status: 'unconfirmed',
    });
    this.#publishTasks();
    return task;
  }

  // -------------------------------------------------------------------------
  // Lily's own actions
  // -------------------------------------------------------------------------

  /**
   * What Lily can actually do herself.
   *
   * A short, honest list. Anything outside it that needs a tool goes to the
   * speaker's own agent if they have a capability for it, and if they do not,
   * she says so rather than claiming to have done it. "Lily, book a meeting
   * with Chris tomorrow" is a calendar call, and the calendar credential lives
   * on the asker's machine — not here.
   */
  async #performLilyAction(utterance: HeardUtterance, instruction: string): Promise<void> {
    const wanted = instruction.toLowerCase();
    const speaker = utterance.employeeId === null ? null : this.#roster.byId(utterance.employeeId);

    if (/\b(what|anything).*(my plate|for me|on me|my list|assigned to me)\b/.test(wanted) ||
        /\b(read|list|run).*(back|through).*(items|tasks|actions)\b/.test(wanted)) {
      await this.#speakOwnTasks(speaker);
      return;
    }

    if (/\b(share|show|put).*(screen|board|list|items)\b/.test(wanted)) {
      if (!this.#options.adapter.capabilities.screenshare) {
        await this.#scheduler.say(speech.cannotDoThat('screen sharing'), 'answer');
        return;
      }
      await this.#options.adapter.startScreenshare('/board');
      await this.#scheduler.say(speech.confirmLilyAction('the action items are on screen'), 'answer');
      return;
    }

    if (/\b(stop|end).*(sharing|screen ?share)\b/.test(wanted)) {
      await this.#options.adapter.stopScreenshare();
      await this.#scheduler.say(speech.confirmLilyAction('stopped sharing'), 'answer');
      return;
    }

    if (/^\s*(mute|be quiet|stay quiet|stop talking)\b/.test(wanted)) {
      await this.#options.adapter.mute();
      await this.#scheduler.say(speech.confirmLilyAction('muted'), 'ack');
      return;
    }

    // Everything else is work for a machine, and the only machine whose consent
    // is implied is the asker's own.
    if (speaker !== null && this.#options.daemon.isConnected(speaker.employeeId)) {
      await this.#dispatch({
        target: speaker,
        text: instruction,
        mode: 'standard',
        utterance,
        selfRequested: true,
      });
      return;
    }

    await this.#scheduler.say(speech.cannotDoThat(instruction), 'answer');
  }

  async #speakOwnTasks(speaker: EmployeeProfile | null): Promise<void> {
    if (speaker === null) {
      await this.#scheduler.say(
        `I don't have you on the roster for this meeting, so I haven't got anything under your name.`,
        'answer',
      );
      return;
    }

    const mine = this.#tasks.byOwner(speaker.employeeId);
    if (mine.length === 0) {
      await this.#scheduler.say(
        `Nothing under your name so far, ${spokenName(speaker)}.`,
        'answer',
      );
      return;
    }

    const lines = mine.map((task) => `${task.text}${task.due === null ? '' : ` by ${task.due}`}`);
    await this.#scheduler.say(
      `${spokenName(speaker)}, I've got ${lines.length === 1 ? 'one thing' : `${lines.length} things`}: ${lines.join('; ')}.`,
      'answer',
    );
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Send work to an employee's own agent.
   *
   * Never blocks. A dispatched task can take minutes, and a room that has to
   * wait in silence for it will stop using the product. Lily acknowledges, the
   * conversation carries on, and the answer re-enters through `#onTaskResult`.
   */
  async #dispatch(request: {
    target: EmployeeProfile;
    text: string;
    mode: 'read_only' | 'standard';
    utterance: HeardUtterance;
    selfRequested: boolean;
  }): Promise<void> {
    const { target, utterance } = request;
    const daemon = this.#options.daemon;

    if (!target.daemonEnrolled || !daemon.isConnected(target.employeeId)) {
      // Not a failure — the employee simply never enrolled, or is offline. The
      // question becomes a note for them instead of vanishing.
      this.#recordAssignment(
        target.employeeId,
        utterance.employeeId ?? 'external',
        taskTextFrom(request.text),
        null,
      );
      await this.#scheduler.say(speech.noAgent(spokenName(target)), 'answer');
      return;
    }

    if (daemon.isDnd(target.employeeId)) {
      this.#recordAssignment(
        target.employeeId,
        utterance.employeeId ?? 'external',
        taskTextFrom(request.text),
        null,
      );
      await this.#scheduler.say(
        `${spokenName(target)} has their agent on do not disturb, so I've noted it instead of asking.`,
        'answer',
      );
      return;
    }

    const taskId = newTaskId();
    const task = this.#tasks.add({
      text: request.text,
      owner_employee_id: target.employeeId,
      assigned_by: utterance.employeeId ?? 'external',
      due: null,
      type: 'lily_action',
      status: 'in_progress',
    });

    const payload: TaskDispatch = {
      taskId,
      meetingId: this.#options.meetingId,
      text: request.text,
      requesterEmployeeId: utterance.employeeId ?? 'external',
      mode: request.mode,
      selfRequested: request.selfRequested,
      deadlineSec: this.#options.dispatchDeadlineSec ?? 300,
    };

    this.#inFlight.set(taskId, {
      taskId,
      employeeId: target.employeeId,
      requesterParticipantId: utterance.participantId,
      askedAt: this.#clock.date(),
      requestedText: utterance.text,
      selfRequested: request.selfRequested,
    });
    // Task memory keys off the memory id; the dispatch keys off `taskId`. Bind
    // them so a result can find its way back to the right row.
    this.#taskIdByDispatch.set(taskId, task.id);

    // Counted, and free. This is the employee's own machine spending the
    // employee's own subscription — see the header of usage.ts.
    this.#meter.noteDispatch();
    this.#publishTasks();

    try {
      await daemon.dispatch(target.employeeId, payload);
    } catch (cause) {
      this.#inFlight.delete(taskId);
      this.#taskIdByDispatch.delete(taskId);
      this.#tasks.setStatus(task.id, 'cancelled');
      this.#publishTasks();
      log.warn('dispatch.failed', { employeeId: target.employeeId, error: errorField(cause) });
      await this.#scheduler.say(speech.dispatchFailed(spokenName(target), null), 'answer');
      return;
    }

    log.info('task.dispatched', {
      taskId,
      ownerEmployeeId: target.employeeId,
      mode: request.mode,
      selfRequested: request.selfRequested,
    });

    await this.#scheduler.say(speech.acknowledgeDispatch(spokenName(target)), 'ack');
  }

  async #onTaskResult(
    employeeId: string,
    dispatchTaskId: string,
    ok: boolean,
    answer: string,
    error: string | null,
  ): Promise<void> {
    const inFlight = this.#inFlight.get(dispatchTaskId);
    if (inFlight === undefined) return;
    this.#inFlight.delete(dispatchTaskId);

    const memoryId = this.#taskIdByDispatch.get(dispatchTaskId);
    this.#taskIdByDispatch.delete(dispatchTaskId);
    if (memoryId !== undefined) this.#tasks.setStatus(memoryId, ok ? 'done' : 'cancelled');
    this.#publishTasks();

    this.#meter.noteDispatchComplete();
    void this.#options.adapter.setStatus(null);

    const name = this.#spokenNameOf(employeeId);

    // Re-entering the conversation, possibly minutes later. The scheduler waits
    // for a gap rather than cutting across whatever is being discussed now.
    if (ok) {
      await this.#scheduler.say(speech.answerFromAgent(name, answer), 'answer', {
        mustDeliver: true,
      });
    } else {
      await this.#scheduler.say(speech.dispatchFailed(name, error), 'answer', {
        mustDeliver: true,
      });
    }
  }

  #onPermissionRequest(employeeId: string, payload: PermissionRequest): void {
    const inFlight = this.#inFlight.get(payload.taskId);

    this.#relay.submit({
      requestId: payload.requestId,
      taskId: payload.taskId,
      kind: payload.kind,
      detail: payload.detail,
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
      // The owner is whoever's machine this is, always. Not whoever asked.
      ownerEmployeeId: employeeId,
      receivedAt: this.#clock.date(),
      selfRequested: inFlight?.selfRequested ?? false,
      requestedText: inFlight?.requestedText ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Wrap-up
  // -------------------------------------------------------------------------

  /**
   * "Before we wrap — John, you've got the auth refactor by Sunday. Confirming?"
   *
   * One item at a time, and only the owner's yes counts. An item nobody
   * confirms stays unconfirmed rather than being quietly promoted, because an
   * unconfirmed item is honest and a wrongly-confirmed one is a lie in someone's
   * task list.
   */
  async #readBackUnconfirmed(): Promise<void> {
    const pending = this.#tasks.unconfirmed();
    if (pending.length === 0) {
      await this.#scheduler.say(speech.wrapUpNothing(), 'wrapup', { mustDeliver: true });
      return;
    }

    await this.#scheduler.say(speech.wrapUpIntro(), 'wrapup', { mustDeliver: true });

    for (const task of pending) {
      const ownerName = this.#spokenNameOf(task.owner_employee_id);

      await this.#scheduler.say(speech.wrapUpItem(ownerName, task), 'wrapup', {
        mustDeliver: true,
      });

      const confirmed = await this.#awaitConfirmation(task.id, task.owner_employee_id);
      if (confirmed) {
        this.#tasks.setStatus(task.id, 'confirmed');
        this.#publishTasks();
        await this.#scheduler.say(speech.wrapUpConfirmed(ownerName), 'wrapup');
      }
    }

    const stillUnconfirmed = this.#tasks.unconfirmed().length;
    if (stillUnconfirmed > 0) {
      await this.#scheduler.say(speech.wrapUpUnconfirmed(stillUnconfirmed), 'wrapup', {
        mustDeliver: true,
      });
    }
  }

  #awaitConfirmation(taskId: string, ownerEmployeeId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.#pendingConfirmation?.taskId === taskId) this.#pendingConfirmation = null;
        resolve(confirmed);
      };

      this.#pendingConfirmation = { taskId, ownerEmployeeId, resolve: settle };

      // Reuses the voice-approval window rather than inventing a second
      // timeout: it is the same question — "did a specific person say yes out
      // loud?" — and it should not have two different answers about how long to
      // wait. Silence leaves the item unconfirmed, which is the safe default.
      this.#timers.after(this.#config.permissions.voiceApprovalTimeoutSec * 1000, () =>
        settle(false),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Presence & self-termination
  // -------------------------------------------------------------------------

  #onParticipantJoin(participant: Participant): void {
    this.#participants.set(participant.participantId, participant);
    if (participant.employeeId === null && !participant.isBot) {
      this.#externalParticipants.add(participant.participantId);
    }

    this.#clearTimer(this.#emptyRoomTimer);
    this.#emptyRoomTimer = null;

    log.info('session.participant_joined', {
      isBot: participant.isBot,
      known: participant.employeeId !== null,
      total: this.#participants.size,
    });
  }

  #onParticipantLeave(participant: Participant): void {
    this.#participants.delete(participant.participantId);

    const humansLeft = [...this.#participants.values()].filter((p) => !p.isBot).length;
    if (humansLeft > 0) return;

    // Everyone else has gone. Wait out the grace period in case it was a
    // reconnect, then leave rather than sitting in an empty room billing.
    this.#clearTimer(this.#emptyRoomTimer);
    this.#emptyRoomTimer = this.#timers.after(
      this.#config.meeting.emptyRoomGraceSec * 1000,
      () => {
        const stillEmpty = [...this.#participants.values()].filter((p) => !p.isBot).length === 0;
        if (stillEmpty) void this.end('empty_room');
      },
    );
  }

  #armSilenceTimer(): void {
    this.#clearTimer(this.#silenceTimer);
    this.#silenceTimer = this.#timers.after(this.#config.meeting.silenceTimeoutSec * 1000, () => {
      // A quiet room while an agent is still working is expected, not idle.
      // A dispatched task can easily outlast the silence window — Lily
      // acknowledges immediately, the conversation moves on, and she re-enters
      // with the result later. Ending here would throw away the answer the room
      // is waiting for, which is exactly what happened in testing: dispatched at
      // 16:41:39, ended `silence` at 16:46:39, answer never delivered.
      //
      // Deliberately NOT applied to the empty-room timer: if everyone has left,
      // there is nobody to hear the answer, so waiting for it is pointless.
      // The hard duration cap is unaffected and still ends the meeting
      // unconditionally, so this cannot keep an instance alive indefinitely.
      if (this.#inFlight.size > 0) {
        this.#armSilenceTimer();
        return;
      }
      void this.end('silence');
    });
  }

  #clearTimer(handle: TimerHandle | null): void {
    if (handle !== null) this.#timers.cancel(handle);
  }

  #publishTasks(): void {
    const adapter = this.#options.adapter as { publishTasks?: () => void };
    adapter.publishTasks?.();
  }
}

function mapLeaveReason(reason: MeetingEndReason): 'meeting_ended' | 'empty_room' | 'silence' | 'max_duration' {
  switch (reason) {
    case 'empty_room':
    case 'silence':
    case 'max_duration':
      return reason;
    default:
      return 'meeting_ended';
  }
}

/** "tell John to fix the build" → "fix the build". */
function stripRelayPrefix(instruction: string): string {
  return instruction
    .replace(/^(tell|ask|remind|let|check with|ping|get)\s+\S+\s+(to|that)\s+/i, '')
    .replace(/^(tell|ask|remind|let|check with|ping|get)\s+\S+\s+/i, '')
    .trim();
}

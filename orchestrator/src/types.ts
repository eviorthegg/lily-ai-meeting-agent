/**
 * Types shared across the orchestrator.
 *
 * Anything that also crosses the daemon boundary is imported from
 * `@lily/shared/protocol` rather than redeclared — that module is the wire
 * contract and this package is a consumer of it, not a second source of truth.
 */

import type { ActionKind } from '@lily/shared/protocol';

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface EmployeeProfile {
  /** Stable public routing id. Matches `UserDoc.employeeId`. */
  readonly employeeId: string;
  readonly name: string;
  /** Nicknames and handles the room actually uses. */
  readonly aliases: readonly string[];
  /** Org-authored "what they do here". Used to route questions. */
  readonly jobDescription: string;
  readonly agentKind: string | null;
  /** MCP server / tool names only. Never anything those tools can see. */
  readonly capabilities: readonly string[];
  /** False when the employee never enrolled a daemon; nothing can be dispatched. */
  readonly daemonEnrolled: boolean;
}

/**
 * Someone in the room right now.
 *
 * `employeeId` is null for a guest: an external attendee who is counted but not
 * identified, matching `MeetingDoc.externalParticipantCount`.
 */
export interface Participant {
  readonly participantId: string;
  readonly displayName: string;
  readonly employeeId: string | null;
  readonly isBot: boolean;
  readonly joinedAt: Date;
}

// ---------------------------------------------------------------------------
// Speech in and out
// ---------------------------------------------------------------------------

/**
 * One thing a person said, on its way through Lily.
 *
 * This is the single most sensitive object in the system. It exists in memory
 * for as long as it takes to classify and respond, and is then dropped. It is
 * never written to Mongo, never logged, and never leaves the process except as
 * the `text` of a `task.dispatch` the speaker asked for.
 */
export interface HeardUtterance {
  readonly participantId: string;
  readonly employeeId: string | null;
  readonly speakerName: string;
  readonly text: string;
  readonly at: Date;
  /** True when this came from real speech rather than typed text. */
  readonly fromAudio: boolean;
}

export type SpeechPriority = 'permission' | 'answer' | 'ack' | 'wrapup' | 'ambient';

/** Something Lily is going to say. */
export interface LilyUtterance {
  readonly id: string;
  readonly text: string;
  readonly priority: SpeechPriority;
  /** Set when the line must not be dropped even if the moment passes. */
  readonly mustDeliver: boolean;
}

export interface AudioFrame {
  readonly pcm16: Uint8Array;
  readonly sampleRate: number;
  readonly at: number;
}

export interface AudioStream extends AsyncIterable<AudioFrame> {
  close(): void;
}

/**
 * What `MeetingAdapter.speak` accepts.
 *
 * Audio carries an optional `text` so a text-only room (and the meeting
 * transcript panel of a real client) can render what was said without a second
 * synthesis pass.
 */
export type SpeechOutput =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'audio';
      readonly pcm16: Uint8Array;
      readonly sampleRate: number;
      readonly text?: string;
    };

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

export type MeetingTaskType = 'lily_action' | 'human_assignment';

export type MeetingTaskStatus =
  | 'unconfirmed'
  | 'confirmed'
  | 'in_progress'
  | 'done'
  | 'cancelled';

/**
 * A task as it exists during the meeting.
 *
 * Field names are snake_case because this shape is the meeting-local record the
 * product spec defines; the API maps it onto `TaskDoc` when it persists the
 * short text. Nothing here is written from this process.
 */
export interface MeetingTask {
  readonly id: string;
  readonly text: string;
  readonly owner_employee_id: string;
  readonly assigned_by: string;
  /** ISO date, or null when nobody named a deadline. */
  readonly due: string | null;
  readonly status: MeetingTaskStatus;
  readonly type: MeetingTaskType;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface PendingPermission {
  readonly requestId: string;
  readonly taskId: string;
  readonly kind: ActionKind;
  /** Verbatim, spoken back before approval is relayed. */
  readonly detail: string;
  readonly reason?: string;
  /** Only this employee's approval counts. */
  readonly ownerEmployeeId: string;
  readonly receivedAt: Date;
}

export type PermissionOutcome =
  | 'granted'
  | 'denied'
  | 'timeout'
  | 'wrong_speaker'
  | 'hard_blocked';

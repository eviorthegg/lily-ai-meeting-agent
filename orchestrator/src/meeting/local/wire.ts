/**
 * Browser ↔ room-server messages.
 *
 * Separate from `@lily/shared/protocol`, which is the daemon wire and is not
 * this. Kept zod-validated for the same reason that one is: the other end is a
 * browser tab, and a browser tab is not a trusted peer just because we served
 * the page to it.
 */

import { z } from 'zod';

export const ROOM_PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// browser → room server
// ---------------------------------------------------------------------------

export const roomJoinSchema = z.object({
  t: z.literal('join'),
  displayName: z.string().min(1).max(64),
  /** Null for a guest — counted, not identified, like a real external attendee. */
  employeeId: z.string().min(1).max(128).nullable(),
});

export const roomSaySchema = z.object({
  t: z.literal('say'),
  text: z.string().min(1).max(2_000),
});

export const roomLeaveSchema = z.object({ t: z.literal('leave') });

/** Ends the meeting for everyone. The room's "hang up" button. */
export const roomEndSchema = z.object({ t: z.literal('end') });

export const clientToRoomSchema = z.discriminatedUnion('t', [
  roomJoinSchema,
  roomSaySchema,
  roomLeaveSchema,
  roomEndSchema,
]);

export type ClientToRoom = z.infer<typeof clientToRoomSchema>;

// ---------------------------------------------------------------------------
// room server → browser
// ---------------------------------------------------------------------------

export interface RoomParticipantView {
  participantId: string;
  displayName: string;
  employeeId: string | null;
  isBot: boolean;
  joinedAt: string;
}

export interface RoomDirectoryEntry {
  employeeId: string;
  name: string;
  jobDescription: string;
  agentKind: string | null;
  capabilities: string[];
  daemonEnrolled: boolean;
  /** True while somebody in the room is signed in as this person. */
  taken: boolean;
}

export interface RoomTaskView {
  id: string;
  text: string;
  owner_employee_id: string;
  ownerName: string;
  assigned_by: string;
  assignedByName: string;
  due: string | null;
  status: string;
  type: string;
  created_at: string;
}

export type RoomToClient =
  | {
      t: 'welcome';
      v: typeof ROOM_PROTOCOL_VERSION;
      meetingId: string;
      botDisplayName: string;
      you: RoomParticipantView;
      participants: RoomParticipantView[];
      tasks: RoomTaskView[];
    }
  | { t: 'participant'; action: 'join' | 'leave'; participant: RoomParticipantView }
  | {
      t: 'message';
      id: string;
      from: string;
      fromEmployeeId: string | null;
      text: string;
      at: string;
      isBot: boolean;
    }
  | { t: 'status'; state: string; note: string | null }
  | { t: 'speaking'; on: boolean }
  | { t: 'hand'; raised: boolean }
  | { t: 'muted'; muted: boolean }
  | { t: 'screenshare'; url: string | null }
  | { t: 'tasks'; tasks: RoomTaskView[] }
  | { t: 'system'; text: string }
  | { t: 'error'; text: string }
  | { t: 'ended'; reason: string };

import type {
  AuditLogDoc,
  ConnectionDoc,
  MeetingDoc,
  OrgDoc,
  TaskDoc,
  UserDoc,
} from '../db/schema.js';

/**
 * Database documents → wire shapes.
 *
 * Two systematic substitutions, matching what web/src/lib/api/types.ts already
 * declares: ObjectId becomes a hex string, Date becomes an ISO 8601 string.
 * Field names are otherwise identical, so a drift between the two files is a
 * rename someone can grep for rather than a silent semantic difference.
 *
 * This layer is also the last line of the data policy. A document is never
 * spread wholesale into a response — every field is listed — so a column added
 * to a collection cannot leak into the API by default. `passwordHash`,
 * `totpSecretEncrypted`, `backupCodeHashes` and every token hash are absent here
 * for that reason and must stay absent.
 */

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function presentUser(user: UserDoc, options: { orgExists: boolean }): unknown {
  return {
    id: user._id.toHexString(),
    orgId: options.orgExists ? user.orgId.toHexString() : null,
    employeeId: user.employeeId,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    name: user.name,
    role: user.role,
    jobDescription: user.jobDescription,
    status: user.status,
    mfaEnrolled: user.mfa.enrolled,
    daemonEnrolled: user.daemonEnrolled,
    agentKind: user.agentKind,
    agentCapabilities: user.agentCapabilities,
  };
}

export function presentOrg(org: OrgDoc, memberCount: number): unknown {
  return {
    id: org._id.toHexString(),
    name: org.name,
    sizeBucket: org.sizeBucket,
    plan: org.billing.plan,
    tokenAllowance: org.billing.tokenAllowance,
    tokensUsedCycle: org.billing.tokensUsedCycle,
    topupBalance: org.billing.topupBalance,
    retentionDays: org.retention.days,
    memberCount,
  };
}

/** The team table's row. Presence is "what the server knew when it answered". */
export function presentTeamMember(user: UserDoc, connection: ConnectionDoc | undefined): unknown {
  return {
    id: user._id.toHexString(),
    employeeId: user.employeeId,
    name: user.name,
    email: user.email,
    role: user.role,
    jobDescription: user.jobDescription,
    status: user.status,
    daemonEnrolled: user.daemonEnrolled,
    mfaEnrolled: user.mfa.enrolled,
    agentKind: user.agentKind,
    agentCapabilities: user.agentCapabilities,
    daemonOnline: connection !== undefined,
    lastSeenAt: iso(user.lastSeenAt),
    invitedAt: iso(user.createdAt),
  };
}

export function presentInvite(user: UserDoc): unknown {
  return {
    id: user._id.toHexString(),
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    invitedAt: user.createdAt.toISOString(),
  };
}

export function presentMeeting(meeting: MeetingDoc): unknown {
  return {
    id: meeting._id.toHexString(),
    orgId: meeting.orgId.toHexString(),
    platform: meeting.platform,
    title: meeting.title,
    status: meeting.status,
    startedAt: iso(meeting.startedAt),
    endedAt: iso(meeting.endedAt),
    durationSec: meeting.durationSec,
    participantUserIds: meeting.participantUserIds.map((id) => id.toHexString()),
    externalParticipantCount: meeting.externalParticipantCount,
    tokensConsumed: meeting.tokensConsumed,
    summary: meeting.summary,
    decisions: meeting.decisions,
    // Note what is not here and never will be: the join URL. It is a credential,
    // it is not persisted, and it must not travel back out of this API.
  };
}

export function presentTask(task: TaskDoc): unknown {
  return {
    id: task._id.toHexString(),
    orgId: task.orgId.toHexString(),
    meetingId: task.meetingId === null ? null : task.meetingId.toHexString(),
    text: task.text,
    ownerEmployeeId: task.ownerEmployeeId,
    ownerUserId: task.ownerUserId === null ? null : task.ownerUserId.toHexString(),
    due: iso(task.due),
    status: task.status,
    type: task.type,
    dispatchOutcome: task.dispatchOutcome,
    createdAt: task.createdAt.toISOString(),
  };
}

/** Names are resolved by the caller and passed in, so this stays a pure mapping. */
export function presentAuditEntry(
  entry: AuditLogDoc,
  names: ReadonlyMap<string, string>,
): unknown {
  return {
    id: entry._id.toHexString(),
    action: entry.action,
    actorName: entry.actorUserId === null ? null : (names.get(entry.actorUserId.toHexString()) ?? null),
    subjectName:
      entry.subjectUserId === null ? null : (names.get(entry.subjectUserId.toHexString()) ?? null),
    meetingId: entry.meetingId === null ? null : entry.meetingId.toHexString(),
    detail: entry.detail,
    ip: entry.ip,
    at: entry.at.toISOString(),
  };
}

export function presentOrgSettings(
  org: OrgDoc,
  options: { currentPolicyVersion: string; acknowledgedByName: string | null },
): unknown {
  const roles = ['owner', 'admin', 'manager', 'employee'] as const;

  return {
    listeningMode: org.settings.listeningMode,
    deviceTokenRotationSec: org.settings.deviceTokenRotationSec,
    // An array rather than the stored Record, because the dashboard's type is an
    // array — see the note on RolePermissionPolicy about noUncheckedIndexedAccess.
    permissionPolicyByRole: roles.map((role) => ({
      role,
      gatedAllowed: org.settings.permissionPolicyByRole[role]?.gatedAllowed ?? true,
    })),
    taskVisibility: org.settings.taskVisibility,
    retentionDays: org.retention.days,
    consentNotice: {
      // The version in force now, not the one that was acknowledged: the screen's
      // job is to show whether the *current* notice has been accepted.
      policyVersion: options.currentPolicyVersion,
      acknowledgedAt:
        org.consentNotice === null || org.consentNotice.policyVersion !== options.currentPolicyVersion
          ? null
          : org.consentNotice.acknowledgedAt.toISOString(),
      acknowledgedByName: options.acknowledgedByName,
    },
    // Platform connections are an orchestrator concern and nothing writes them
    // yet. Reported as an empty list rather than omitted, so the settings screen
    // renders its empty state instead of throwing on a missing key.
    connectedPlatforms: [],
  };
}

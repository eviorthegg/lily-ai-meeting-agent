/**
 * Identifier helpers.
 *
 * The wire protocol caps ids at 64 characters (`envelopeSchema`, `taskId`,
 * `requestId`), so ids are generated short enough to survive a prefix without
 * ever tripping validation on the daemon side.
 */

const ID_BODY_LENGTH = 22;

function body(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, ID_BODY_LENGTH);
}

export function newId(prefix: string): string {
  const id = `${prefix}_${body()}`;
  if (id.length > 64) {
    throw new Error(`Generated id "${id}" exceeds the protocol's 64-character limit.`);
  }
  return id;
}

export const newTaskId = (): string => newId('tsk');
export const newRequestId = (): string => newId('req');
export const newMessageId = (): string => newId('msg');
export const newMeetingId = (): string => newId('mtg');

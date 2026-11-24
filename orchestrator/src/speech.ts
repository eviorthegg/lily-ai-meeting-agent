/**
 * Everything Lily says, in one place.
 *
 * Both brains render through here. The realtime brain hands these strings to
 * the model as the content of an assistant turn rather than letting it
 * improvise, for the lines where the exact words matter — a permission prompt
 * has to repeat the command verbatim, and a paraphrase of "rm -rf node_modules"
 * is a consent failure, not a style choice.
 */

import type { ActionKind } from '@lily/shared/protocol';
import type { MeetingTask, PendingPermission } from './types.js';

/** How each gated action is described out loud. Plain language, no jargon. */
const KIND_PHRASING: Record<ActionKind, string> = {
  read: 'read a file',
  search: 'search the repo',
  vcs_read: 'look at version control',
  write: 'change a file',
  shell: 'run a command',
  test: 'run tests',
  install: 'install a dependency',
  network: 'make a network call',
  vcs_push_protected: 'push to a protected branch',
  delete: 'delete something',
  deploy: 'deploy',
  credential_access: 'read a credential',
};

export const speech = {
  /** Said on join. Consent depends on the room knowing what she is. */
  joinAnnouncement(botDisplayName: string): string {
    return (
      `Hi everyone — ${botDisplayName} here. I'm an AI, I'm in this meeting as a participant, ` +
      `and I can pass work to your own coding agents when you ask me to. ` +
      `I'll only act on things addressed to me.`
    );
  },

  acknowledgeDispatch(targetName: string): string {
    return `Checking with ${targetName}'s agent now — I'll come back to you.`;
  },

  answerFromAgent(targetName: string, answer: string): string {
    return `${targetName}'s agent came back: ${answer}`;
  },

  dispatchFailed(targetName: string, reason: string | null): string {
    return reason === null
      ? `I couldn't get an answer from ${targetName}'s agent.`
      : `I couldn't get an answer from ${targetName}'s agent — ${reason}.`;
  },

  noAgent(targetName: string): string {
    return `${targetName} doesn't have an agent connected, so I can't ask their machine. Noted it for them instead.`;
  },

  relayToHuman(targetName: string, what: string): string {
    return `${targetName} — ${what}. I've noted it as yours.`;
  },

  confirmLilyAction(what: string): string {
    return `Done — ${what}.`;
  },

  cannotDoThat(what: string): string {
    return `I can't do that one myself — ${what} isn't something I have a tool for. Someone will need to pick it up.`;
  },

  /**
   * The permission prompt.
   *
   * `detail` is interpolated raw and unquoted-by-the-model on purpose: the
   * protocol already caps it at 200 characters and the owner is being asked to
   * approve exactly this string.
   */
  permissionPrompt(ownerName: string, pending: PendingPermission): string {
    const action = KIND_PHRASING[pending.kind];
    const because = pending.reason === undefined ? '' : ` It says: ${pending.reason}.`;
    return (
      `${ownerName}, your agent wants to ${action}. Exactly this: "${pending.detail}".` +
      `${because} Is that okay?`
    );
  },

  permissionGranted(detail: string): string {
    return `Approved — passing that through: "${detail}".`;
  },

  permissionDenied(ownerName: string, detail: string, reason: 'denied' | 'timeout' | 'wrong_speaker'): string {
    if (reason === 'denied') return `Understood, I've declined that one.`;
    if (reason === 'wrong_speaker') {
      return `I only take that from ${ownerName}, so I've declined "${detail}" for now.`;
    }
    return `No answer from ${ownerName}, so I've declined "${detail}". Ask again when you're ready.`;
  },

  /** Hard-blocked actions are reported as blocked, never offered as approvable. */
  permissionBlocked(ownerName: string, pending: PendingPermission): string {
    return (
      `${ownerName}, your agent tried to ${KIND_PHRASING[pending.kind]}. ` +
      `That's blocked for everyone and isn't something I can approve, so I've stopped it.`
    );
  },

  wrapUpIntro(): string {
    return `Before we wrap — a few things I picked up.`;
  },

  /**
   * Phrased so it reads correctly whatever the task text turned out to be —
   * a stripped imperative ("finish the auth refactor") and a question someone
   * was asked both fit after "down for:", where "you've got …" only fits one.
   */
  wrapUpItem(ownerName: string, task: MeetingTask): string {
    const when = task.due === null ? '' : `, due ${task.due}`;
    return `${ownerName}, I've got you down for: ${task.text}${when}. Confirming?`;
  },

  wrapUpNothing(): string {
    return `Before we wrap — I didn't pick up any action items. Nothing from me.`;
  },

  wrapUpConfirmed(ownerName: string): string {
    return `Thanks ${ownerName}, marked as confirmed.`;
  },

  wrapUpUnconfirmed(count: number): string {
    return count === 1
      ? `I've left one item unconfirmed.`
      : `I've left ${count} items unconfirmed.`;
  },

  leaving(reason: 'meeting_ended' | 'empty_room' | 'silence' | 'max_duration'): string {
    switch (reason) {
      case 'empty_room':
        return `Looks like everyone's gone — I'll drop off. Bye.`;
      case 'silence':
        return `It's gone quiet, so I'll drop off. Grab me again when you need me.`;
      case 'max_duration':
        return `I've hit my time limit for one meeting, so I'll drop off here.`;
      case 'meeting_ended':
        return `That's me done — talk soon.`;
    }
  },
};

export function describeKind(kind: ActionKind): string {
  return KIND_PHRASING[kind];
}

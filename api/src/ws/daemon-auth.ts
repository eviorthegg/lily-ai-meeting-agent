import { verifyDeviceToken } from '../auth/tokens.js';
import { users } from '../db/collections.js';
import type { DaemonAuthenticator, DaemonIdentity } from './handlers.js';

/**
 * The real daemon authenticator, backed by `daemon_tokens`.
 *
 * This replaces `LocalDevAuthenticator`, which held issued tokens in a process
 * map and therefore forgot every enrolment on restart. Nothing about this class
 * is local-only: it is the same code in every stage, which is the point — the
 * local stack now exercises the production authentication path rather than a
 * stand-in for it.
 *
 * All the cryptography lives in `verifyDeviceToken`; this is the policy layer on
 * top of it, and it makes two decisions that the token store cannot:
 *
 *   1. **A superseded token is refused.** The token store recognises it — the
 *      daemon is presenting the credential it was told to replace, which happens
 *      for real when a rotation response is lost — but recognising it is not
 *      accepting it. The daemon reconnects with its current token, or its owner
 *      re-enrols. Nothing is revoked, because a lost acknowledgement is not an
 *      attack and treating it as one would turn rotation into an outage.
 *
 *   2. **The user is re-checked on every connect.** A token that has not yet been
 *      swept must not let a removed or suspended employee attach. `handleConnect`
 *      checks this too; the duplication is deliberate, because this class is also
 *      used by anything else that authenticates a daemon.
 */
export class DeviceTokenAuthenticator implements DaemonAuthenticator {
  async verify(rawToken: string): Promise<DaemonIdentity | null> {
    if (rawToken === '') return null;

    const verification = await verifyDeviceToken({ presentedToken: rawToken });

    // 'superseded', 'revoked' and 'unknown' all land here. They are deliberately
    // indistinguishable to the caller: the socket layer has one answer for a
    // token it will not accept, and a richer response would only tell whoever
    // presented it which kind of invalid it was.
    if (verification.outcome !== 'valid') return null;

    const { token } = verification;

    const usersCol = await users();
    const user = await usersCol.findOne({ _id: token.userId });
    if (user === null || user.status === 'removed' || user.status === 'suspended') return null;

    // The employee id comes from the token record, not from the user document:
    // they are the same value, and reading it from the credential keeps identity
    // anchored to the thing that was authenticated.
    return {
      userId: token.userId,
      orgId: token.orgId,
      employeeId: token.employeeId,
    };
  }
}

/**
 * Passkey seam.
 *
 * `WebAuthnCredentialDoc` exists in api/src/db/schema.ts, so the storage side of
 * this is decided. What does not exist is the pair of endpoints WebAuthn needs:
 * a registration-options call that returns a server-generated challenge, and a
 * verification call that checks the attestation and stores the credential.
 *
 * That challenge cannot be manufactured in the browser — inventing one here
 * would produce a flow that looks like WebAuthn and proves nothing — so this
 * module reports the capability as unavailable and the enrollment UI says so,
 * rather than offering a button that cannot work.
 *
 * When those endpoints land:
 *   1. add `startPasskeyEnrollment()` / `confirmPasskeyEnrollment()` to LilyApi,
 *      returning `PublicKeyCredentialCreationOptions` (base64url fields decoded
 *      by the caller) and taking the attestation response;
 *   2. replace the body of `enrollPasskey()` below with the navigator.credentials
 *      call, keeping this signature;
 *   3. flip `passkeysSupported()` to also require the API capability flag.
 * Nothing else in the UI needs to change — MfaEnroll already renders this
 * module's availability rather than hardcoding TOTP.
 */

export type PasskeyAvailability =
  | { available: true }
  | { available: false; reason: 'browser_unsupported' | 'api_not_implemented' };

/** Whether the browser could do WebAuthn at all, ignoring the server side. */
export function browserSupportsPasskeys(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator.credentials?.create === 'function'
  );
}

/**
 * The API side is not implemented, so this is `false` on every browser today.
 * It is written as a two-part check so that turning it on later is a one-line
 * change with the browser half already correct.
 */
export function passkeyAvailability(): PasskeyAvailability {
  if (!browserSupportsPasskeys()) return { available: false, reason: 'browser_unsupported' };
  return { available: false, reason: 'api_not_implemented' };
}

export class PasskeysUnavailableError extends Error {
  constructor() {
    super('Passkey enrollment is not available yet.');
    this.name = 'PasskeysUnavailableError';
  }
}

export async function enrollPasskey(): Promise<never> {
  return Promise.reject(new PasskeysUnavailableError());
}

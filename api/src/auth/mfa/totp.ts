import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import { getConfig } from '@lily/shared';
import { mfaEncryptionKey } from '../keys.js';

/**
 * TOTP (RFC 6238) — the fallback second factor.
 *
 * WebAuthn is the primary method (see ./webauthn.ts); this exists for the people
 * and devices that cannot use it.
 *
 * Unlike a password, a TOTP secret has to be recoverable — the server needs the
 * original bytes on every verification — so it is encrypted rather than hashed,
 * with AES-256-GCM under a key from the secrets store. GCM specifically, so a
 * tampered ciphertext fails authentication outright instead of decrypting to
 * garbage that then merely fails to match and looks like a mistyped code.
 */

/** RFC 6238 default, and what every authenticator app assumes. */
const PERIOD_SEC = 30;

const IV_BYTES = 12;
const ENVELOPE_VERSION = 'v1';

export class TotpSecretFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpSecretFormatError';
  }
}

export function generateTotpSecret(): string {
  return generateSecret();
}

/**
 * `v1.<iv>.<authTag>.<ciphertext>`, all base64url.
 *
 * The version prefix is what makes a key rotation possible later: a reader can
 * tell which key an envelope was written under instead of having to guess.
 */
export async function encryptTotpSecret(secret: string): Promise<string> {
  const key = await mfaEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export async function decryptTotpSecret(envelope: string): Promise<string> {
  const parts = envelope.split('.');
  const [version, ivPart, tagPart, ciphertextPart] = parts;

  if (
    parts.length !== 4 ||
    version !== ENVELOPE_VERSION ||
    ivPart === undefined ||
    tagPart === undefined ||
    ciphertextPart === undefined
  ) {
    // Neither the envelope nor anything derived from it appears in this message.
    throw new TotpSecretFormatError('Stored TOTP secret is not a recognised envelope.');
  }

  const key = await mfaEncryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export interface TotpEnrollmentUriInput {
  readonly secret: string;
  /** What the user sees in their authenticator app — their email address. */
  readonly accountName: string;
  readonly issuer?: string;
}

export function totpEnrollmentUri(input: TotpEnrollmentUriInput): string {
  return generateURI({
    strategy: 'totp',
    issuer: input.issuer ?? getConfig().serviceName,
    label: input.accountName,
    secret: input.secret,
    period: PERIOD_SEC,
  });
}

export interface VerifyTotpInput {
  /** The envelope stored in `user.mfa.totpSecretEncrypted`. */
  readonly encryptedSecret: string;
  readonly token: string;
  readonly now?: Date;
  /**
   * Reject any code from this time step or earlier. Pass the `timeStep` returned
   * by the previous successful verification: without it a code stays usable for
   * its whole window, and anyone who saw it typed can replay it.
   */
  readonly afterTimeStep?: number;
}

export type TotpVerification =
  | { readonly valid: true; readonly timeStep: number }
  | { readonly valid: false };

export async function verifyTotp(input: VerifyTotpInput): Promise<TotpVerification> {
  const secret = await decryptTotpSecret(input.encryptedSecret);

  // `totpWindowSteps` is expressed in steps, as the RFC discusses drift; otplib
  // wants seconds. One step either side is the usual allowance for a phone whose
  // clock is slightly off.
  const toleranceSec = getConfig().auth.mfa.totpWindowSteps * PERIOD_SEC;

  const result = await verifyOtp({
    strategy: 'totp',
    secret,
    token: input.token,
    period: PERIOD_SEC,
    epochTolerance: toleranceSec,
    ...(input.now === undefined ? {} : { epoch: Math.floor(input.now.getTime() / 1_000) }),
    ...(input.afterTimeStep === undefined ? {} : { afterTimeStep: input.afterTimeStep }),
  });

  if (!result.valid) return { valid: false };

  // The shared result type also covers HOTP, which has no time step.
  return 'timeStep' in result ? { valid: true, timeStep: result.timeStep } : { valid: false };
}

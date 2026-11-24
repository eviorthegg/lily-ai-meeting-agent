import { hkdfSync } from 'node:crypto';
import { createProviders, getConfig, type SecretsProvider } from '@lily/shared';

/**
 * Key material for the auth layer.
 *
 * Everything here resolves through the SecretsProvider. There is deliberately no
 * literal, no default and no env-var read at a call site: a signing key that can
 * be defaulted is a signing key that ships defaulted.
 *
 * Names follow the same `lily/<stage>/<kind>` convention `config.mongo.uri` uses.
 * Stage is part of the name so a dev key and a prod key are different secrets by
 * construction rather than by deployment discipline.
 */
export const AUTH_SECRET_KINDS = [
  'jwt-signing-key',
  'token-pepper',
  'mfa-encryption-key',
] as const;

export type AuthSecretKind = (typeof AUTH_SECRET_KINDS)[number];

export function authSecretName(kind: AuthSecretKind): string {
  return `lily/${getConfig().stage}/${kind}`;
}

/**
 * Below this, the value is not key material regardless of what it was named.
 * 32 bytes is the floor for HS256 (a shorter HMAC key weakens the construction)
 * and the floor at which a peppered SHA-256 is worth doing at all.
 */
const MIN_SECRET_BYTES = 32;

const AES_KEY_BYTES = 32;

let providerCache: SecretsProvider | null = null;
const material = new Map<string, Promise<Buffer>>();

function secrets(): SecretsProvider {
  providerCache ??= createProviders(getConfig()).secrets;
  return providerCache;
}

async function load(name: string): Promise<Buffer> {
  const value = await secrets().get(name);
  const bytes = Buffer.from(value, 'utf8');

  if (bytes.length < MIN_SECRET_BYTES) {
    // The value itself is never included — an error string is a log line waiting
    // to happen, and a short secret is still a secret.
    throw new Error(
      `Secret "${name}" is ${bytes.length} bytes; at least ${MIN_SECRET_BYTES} are required. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
    );
  }

  return bytes;
}

function resolve(kind: AuthSecretKind): Promise<Buffer> {
  const name = authSecretName(kind);
  let pending = material.get(name);

  if (pending === undefined) {
    // Cache the promise, not the value, so a cold start with concurrent requests
    // makes one provider call. A rejection is dropped so the next call retries
    // instead of serving the same failure for the life of the container.
    pending = load(name).catch((error: unknown) => {
      material.delete(name);
      throw error;
    });
    material.set(name, pending);
  }

  return pending;
}

/** HS256 signing key for access tokens. */
export async function accessTokenSigningKey(): Promise<Uint8Array> {
  return resolve('jwt-signing-key');
}

/**
 * Pepper mixed into every opaque-token hash.
 *
 * Its whole job is to make a stolen database dump useless on its own: the hashes
 * cannot be checked against a candidate token without also holding this value,
 * which lives in a different system.
 */
export async function tokenPepper(): Promise<Buffer> {
  return resolve('token-pepper');
}

/**
 * AES-256-GCM key for TOTP secrets at rest, derived with HKDF.
 *
 * AES-256 needs exactly 32 bytes and the provisioned secret is an arbitrary
 * string, so it has to be turned into a fixed-width key somehow. HKDF is that
 * operation; hashing or truncating the secret directly would work but is the
 * kind of ad-hoc key derivation that is only ever wrong in ways nobody notices.
 *
 * This is a separate secret from the pepper on purpose. Rotating the pepper is
 * routine — it invalidates refresh tokens and everyone logs in again. If the
 * TOTP key were derived from it, that same routine rotation would make every
 * stored TOTP secret undecryptable and force the whole company to re-enrol.
 */
export async function mfaEncryptionKey(): Promise<Buffer> {
  const root = await resolve('mfa-encryption-key');
  return Buffer.from(
    hkdfSync('sha256', root, 'lily/mfa-secret-encryption', 'aes-256-gcm', AES_KEY_BYTES),
  );
}

/** Test seam, mirroring `resetConfigCache()`. Drops resolved key material. */
export function resetAuthKeyCache(): void {
  material.clear();
  providerCache = null;
}

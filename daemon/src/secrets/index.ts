import { log } from '../log.js';
import { DpapiSecretStore, dpapiAvailable } from './dpapi.js';
import { FileSecretStore } from './file.js';
import { KeychainSecretStore, keychainAvailable } from './keychain.js';
import { LibsecretSecretStore, libsecretAvailable } from './libsecret.js';
import type { SealedSecret, SecretStore } from './store.js';

export * from './store.js';
export { DpapiSecretStore } from './dpapi.js';
export { FileSecretStore } from './file.js';
export { KeychainSecretStore } from './keychain.js';
export { LibsecretSecretStore } from './libsecret.js';

/**
 * Pick the credential store for this platform.
 *
 * The fallback to plaintext is deliberately noisy: it warns here, and the sealed
 * record it produces is flagged so `doctor` and the status page keep saying so.
 * An install that quietly degraded to an unprotected token would be the worst
 * outcome, because nothing downstream would ever mention it again.
 */
export async function resolveSecretStore(platform = process.platform): Promise<SecretStore> {
  if (platform === 'win32' && (await dpapiAvailable())) return new DpapiSecretStore();
  if (platform === 'darwin' && (await keychainAvailable())) return new KeychainSecretStore();
  if (platform === 'linux' && (await libsecretAvailable())) return new LibsecretSecretStore();

  log.warn('secrets.fallback_to_plaintext', {
    platform,
    detail: 'no OS credential store available; device token will be stored unprotected',
  });
  return new FileSecretStore();
}

/**
 * Rebuild the store that produced an existing sealed record.
 *
 * Keyed off the record rather than the platform so a config file that was written
 * before a keyring was installed still opens, instead of the new store being asked
 * to read a blob it did not create.
 */
export function storeForSealed(sealed: SealedSecret): SecretStore {
  switch (sealed.backend) {
    case 'dpapi':
      return new DpapiSecretStore();
    case 'keychain':
      return new KeychainSecretStore();
    case 'libsecret':
      return new LibsecretSecretStore();
    case 'file':
      return new FileSecretStore();
  }
}

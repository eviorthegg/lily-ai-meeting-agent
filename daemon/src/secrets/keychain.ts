import { canRun, run } from './exec.js';
import {
  SECRET_ACCOUNT,
  SECRET_SERVICE,
  SecretStoreError,
  type SealedSecret,
  type SecretStore,
} from './store.js';

/**
 * macOS Keychain, via the `security` binary that ships with the OS.
 *
 * Unlike DPAPI this is a *store*, not an encrypt-to-blob API, so config.json
 * holds only the account name and the token itself lives in the login keychain.
 *
 * NOT VERIFIED ON HARDWARE: written from the documented `security(1)` interface,
 * never executed against a real Keychain. See the report.
 *
 * Known tradeoff: `add-generic-password` takes the secret as `-w <value>`, so it
 * is briefly visible in the process table. `security` offers no stdin path for
 * the password in non-interactive use. This is the same exposure every Keychain
 * CLI wrapper has, and it is bounded to the enrollment call rather than every
 * read — but it is a real gap and is called out rather than hidden.
 */
export class KeychainSecretStore implements SecretStore {
  readonly backend = 'keychain' as const;
  readonly description = 'macOS Keychain (login keychain, generic password)';
  readonly isInsecure = false;

  async seal(plaintext: string): Promise<SealedSecret> {
    // -U updates in place so re-enrolling does not accumulate duplicate items.
    const result = await run('security', [
      'add-generic-password',
      '-U',
      '-a',
      SECRET_ACCOUNT,
      '-s',
      SECRET_SERVICE,
      '-D',
      'Lily daemon device token',
      '-w',
      plaintext,
    ]);

    if (result.code !== 0) {
      throw new SecretStoreError(
        `Keychain write failed: ${result.stderr.trim() || `exit ${result.code}`}`,
        'keychain',
      );
    }

    return { backend: 'keychain', value: SECRET_ACCOUNT };
  }

  async open(sealed: SealedSecret): Promise<string> {
    const result = await run('security', [
      'find-generic-password',
      '-a',
      sealed.value,
      '-s',
      SECRET_SERVICE,
      '-w',
    ]);

    if (result.code !== 0) {
      throw new SecretStoreError(
        'Device token is not in the Keychain. Re-run enrollment.',
        'keychain',
      );
    }

    // `-w` prints the password followed by a newline.
    return result.stdout.replace(/\r?\n$/, '');
  }

  async clear(sealed: SealedSecret): Promise<void> {
    await run('security', [
      'delete-generic-password',
      '-a',
      sealed.value,
      '-s',
      SECRET_SERVICE,
    ]).catch(() => undefined);
  }
}

export function keychainAvailable(): Promise<boolean> {
  return canRun('security', ['-h']);
}

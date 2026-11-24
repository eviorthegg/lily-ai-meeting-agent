import { canRun, run } from './exec.js';
import {
  SECRET_ACCOUNT,
  SECRET_SERVICE,
  SecretStoreError,
  type SealedSecret,
  type SecretStore,
} from './store.js';

/**
 * Linux Secret Service (GNOME Keyring / KWallet) via `secret-tool` from libsecret.
 *
 * `secret-tool store` reads the secret from stdin, so unlike the macOS path the
 * token never appears in argv.
 *
 * NOT VERIFIED ON HARDWARE: written from the documented `secret-tool(1)`
 * interface, never executed against a real keyring. See the report.
 *
 * Availability is genuinely conditional on Linux: a headless server or a minimal
 * container has no Secret Service daemon at all, and `secret-tool` will hang or
 * fail there. `available()` probes for the binary; a store that is present but
 * unusable surfaces as an enrollment error rather than a silent downgrade.
 */
export class LibsecretSecretStore implements SecretStore {
  readonly backend = 'libsecret' as const;
  readonly description = 'Linux Secret Service via libsecret (secret-tool)';
  readonly isInsecure = false;

  async seal(plaintext: string): Promise<SealedSecret> {
    const result = await run(
      'secret-tool',
      [
        'store',
        '--label=Lily daemon device token',
        'service',
        SECRET_SERVICE,
        'account',
        SECRET_ACCOUNT,
      ],
      { stdin: plaintext },
    );

    if (result.code !== 0) {
      throw new SecretStoreError(
        `secret-tool store failed: ${result.stderr.trim() || `exit ${result.code}`}`,
        'libsecret',
      );
    }

    return { backend: 'libsecret', value: SECRET_ACCOUNT };
  }

  async open(sealed: SealedSecret): Promise<string> {
    const result = await run('secret-tool', [
      'lookup',
      'service',
      SECRET_SERVICE,
      'account',
      sealed.value,
    ]);

    // A missing entry exits non-zero with empty stdout; both are treated the same.
    if (result.code !== 0 || result.stdout === '') {
      throw new SecretStoreError(
        'Device token is not in the keyring. Re-run enrollment.',
        'libsecret',
      );
    }

    // `secret-tool lookup` does not append a newline, but strip one defensively.
    return result.stdout.replace(/\r?\n$/, '');
  }

  async clear(sealed: SealedSecret): Promise<void> {
    await run('secret-tool', ['clear', 'service', SECRET_SERVICE, 'account', sealed.value]).catch(
      () => undefined,
    );
  }
}

export function libsecretAvailable(): Promise<boolean> {
  return canRun('secret-tool', ['--version']);
}

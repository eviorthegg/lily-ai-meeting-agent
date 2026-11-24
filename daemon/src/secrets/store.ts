/**
 * Device-token storage.
 *
 * The device token is a bearer credential for this employee's daemon. It must not
 * sit in plaintext in `~/.lily/config.json`, because that file is readable by
 * anything running as the employee, ends up in backups, and gets pasted into
 * support tickets.
 *
 * Two shapes of OS backing store exist and the interface has to cover both:
 *
 *   - DPAPI (Windows) is an *encryption* API. It hands back ciphertext bound to
 *     the user account, which we store inline in config.json. Nothing is kept
 *     outside our file.
 *   - Keychain (macOS) and libsecret (Linux) are *storage* APIs. The secret lives
 *     in the OS store and config.json holds only a reference to it.
 *
 * `seal()` / `open()` covers both: the `SealedSecret` written to config.json is
 * either ciphertext or a handle, and in neither case is it the token.
 */

export type SecretBackend = 'dpapi' | 'keychain' | 'libsecret' | 'file';

export interface SealedSecret {
  readonly backend: SecretBackend;
  /** DPAPI: base64 ciphertext. Keychain/libsecret: the account name to look up. */
  readonly value: string;
  /**
   * Present only on the `file` backend. A loud, machine-readable marker that this
   * install fell back to an unprotected token, so `doctor` and the status UI can
   * surface it instead of it passing silently.
   *
   * `| undefined` is explicit rather than a bare optional: this record is parsed
   * from config.json by zod, whose `.optional()` always widens to include
   * `undefined`. Under exactOptionalPropertyTypes an absent key and an explicit
   * undefined are different types, and for a JSON-sourced value they are the
   * same thing.
   */
  readonly insecure?: true | undefined;
}

export interface SecretStore {
  readonly backend: SecretBackend;
  /** Human-readable description of where the token actually lives. Shown by `doctor`. */
  readonly description: string;
  /** True for backends that do not actually protect the value. */
  readonly isInsecure: boolean;
  seal(plaintext: string): Promise<SealedSecret>;
  open(sealed: SealedSecret): Promise<string>;
  /** Best-effort removal. Never throws — used on revocation, where failing loudly helps nobody. */
  clear(sealed: SealedSecret): Promise<void>;
}

/** Service/account identifiers, shared by the keychain and libsecret backends. */
export const SECRET_SERVICE = 'lily-daemon';
export const SECRET_ACCOUNT = 'device-token';

export class SecretStoreError extends Error {
  constructor(
    message: string,
    readonly backend: SecretBackend,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SecretStoreError';
  }
}

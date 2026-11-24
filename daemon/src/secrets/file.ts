import type { SealedSecret, SecretStore } from './store.js';

/**
 * Last-resort store for machines with no usable OS credential store.
 *
 * This does NOT protect the token. It writes it into config.json in the clear,
 * relying only on the 0600 file mode the config writer applies.
 *
 * It deliberately performs no encryption. Deriving a key from anything available
 * on the same machine would put the key next to the ciphertext and produce
 * something that *looks* protected while being trivially reversible — worse than
 * plaintext, because it would stop anyone asking why their token is unprotected.
 * Instead the sealed record carries `insecure: true`, which `doctor`, the status
 * UI and the install scripts all surface.
 */
export class FileSecretStore implements SecretStore {
  readonly backend = 'file' as const;
  readonly description =
    'UNPROTECTED file storage in ~/.lily/config.json (no OS credential store available)';
  readonly isInsecure = true;

  async seal(plaintext: string): Promise<SealedSecret> {
    return { backend: 'file', value: plaintext, insecure: true };
  }

  async open(sealed: SealedSecret): Promise<string> {
    return sealed.value;
  }

  async clear(): Promise<void> {
    // The caller drops the sealed record from config.json.
  }
}

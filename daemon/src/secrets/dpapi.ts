import { run } from './exec.js';
import { SecretStoreError, type SealedSecret, type SecretStore } from './store.js';

/**
 * Windows device-token protection via DPAPI (`CryptProtectData`).
 *
 * Driven through `powershell.exe` rather than a native addon. Node has no DPAPI
 * binding, and every npm package that provides one is a prebuilt native module —
 * which means either shipping binaries per Node ABI or requiring MSVC build tools
 * on every employee laptop. Windows PowerShell 5.1 is present on every supported
 * Windows build and exposes the same Win32 call through
 * `System.Security.Cryptography.ProtectedData`, so this is real DPAPI with no
 * install-time compilation.
 *
 * Scope is CurrentUser: the ciphertext is decryptable only by this Windows account
 * on this machine. Copying `config.json` to another machine or another user
 * profile yields an unusable blob, which is the property we want from a stolen
 * config file.
 */

/**
 * Secondary entropy mixed into the DPAPI blob.
 *
 * Without it, any other process running as this user can decrypt the blob simply
 * by calling Unprotect. With it, the caller also has to know this string — which
 * does not stop a determined local attacker (it is in this source file) but does
 * stop generic credential-sweeping tools that walk DPAPI blobs.
 */
const ENTROPY = 'lily-daemon/device-token/v1';

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/**
 * Both directions move base64 over stdin/stdout.
 *
 * stdin rather than argv because a command line is visible to every other process
 * on the box via WMI; base64 rather than raw text because the pipe between Node
 * and PowerShell is codepage-sensitive and a mangled byte would silently corrupt
 * the token.
 */
function script(direction: 'Protect' | 'Unprotect'): string {
  return [
    `$ErrorActionPreference='Stop'`,
    `Add-Type -AssemblyName System.Security`,
    `$in=[Console]::In.ReadToEnd().Trim()`,
    `$bytes=[Convert]::FromBase64String($in)`,
    `$ent=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    `$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser`,
    `$out=[Security.Cryptography.ProtectedData]::${direction}($bytes,$ent,$scope)`,
    `[Console]::Out.Write([Convert]::ToBase64String($out))`,
  ].join('; ');
}

/** PowerShell may prepend a BOM or append CRLF; neither is part of the payload. */
function cleanBase64(raw: string): string {
  return raw.replace(/[^A-Za-z0-9+/=]/g, '');
}

export class DpapiSecretStore implements SecretStore {
  readonly backend = 'dpapi' as const;
  readonly description = 'Windows DPAPI (CurrentUser scope), ciphertext stored in config.json';
  readonly isInsecure = false;

  async seal(plaintext: string): Promise<SealedSecret> {
    const result = await run('powershell.exe', [...PS_ARGS, script('Protect')], {
      stdin: Buffer.from(plaintext, 'utf8').toString('base64'),
    }).catch((cause: unknown) => {
      throw new SecretStoreError('Could not run powershell.exe to protect the token', 'dpapi', {
        cause,
      });
    });

    if (result.code !== 0) {
      throw new SecretStoreError(`DPAPI Protect failed: ${result.stderr.trim()}`, 'dpapi');
    }

    return { backend: 'dpapi', value: cleanBase64(result.stdout) };
  }

  async open(sealed: SealedSecret): Promise<string> {
    const result = await run('powershell.exe', [...PS_ARGS, script('Unprotect')], {
      stdin: sealed.value,
    }).catch((cause: unknown) => {
      throw new SecretStoreError('Could not run powershell.exe to unprotect the token', 'dpapi', {
        cause,
      });
    });

    if (result.code !== 0) {
      // The overwhelmingly likely cause is the config file having been copied from
      // another machine or user profile, so say that rather than the raw error.
      throw new SecretStoreError(
        'DPAPI could not decrypt the device token. This config was most likely created ' +
          'by a different Windows user or on a different machine — re-run enrollment.',
        'dpapi',
      );
    }

    return Buffer.from(cleanBase64(result.stdout), 'base64').toString('utf8');
  }

  async clear(): Promise<void> {
    // Nothing outside config.json to remove; the caller drops the sealed blob.
  }
}

export async function dpapiAvailable(): Promise<boolean> {
  try {
    const probe = new DpapiSecretStore();
    const sealed = await probe.seal('lily-dpapi-probe');
    return (await probe.open(sealed)) === 'lily-dpapi-probe';
  } catch {
    return false;
  }
}

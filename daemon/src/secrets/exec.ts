import { spawn } from 'node:child_process';

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** Written to the child's stdin and then closed. Used to keep secrets out of argv. */
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

/**
 * Run a helper binary and collect its output.
 *
 * `shell: false` throughout — every caller here builds argv from values that can
 * contain user data, and a shell would turn a token containing a quote into
 * command injection.
 */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out`));
    }, options.timeoutMs ?? 15_000);
    // A hung keychain helper must not hold the daemon's event loop open at exit.
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(cause);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

/** True when the binary is callable at all. Used to decide whether a backend is viable. */
export async function canRun(command: string, args: readonly string[]): Promise<boolean> {
  try {
    await run(command, args, { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

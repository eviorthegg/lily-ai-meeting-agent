import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { log } from '../log.js';
import type { AgentLauncher } from './detect.js';
import {
  truncateAnswer,
  type AgentAdapter,
  type AgentEvent,
  type AgentRunOptions,
} from './types.js';

const run = promisify(execFile);

/**
 * Claude Code adapter.
 *
 * Verified against Claude Code 2.0.31. The flags used here come from `claude
 * --help` on a real install, not from assumption:
 *
 *   -p / --print                  non-interactive
 *   --output-format stream-json   NDJSON events, so progress can be streamed
 *                                 into the meeting instead of arriving as one
 *                                 silent block at the end
 *   --include-partial-messages    finer-grained streaming
 *   --tools                       restricts the available tool set
 *   --add-dir                     scopes filesystem access to the work directory
 *   --append-system-prompt        injects meeting context
 *
 * ## How the restricted profile is enforced
 *
 * Meeting-dispatched work runs under tighter rules than the employee's own
 * interactive session. Enforcement is layered deliberately:
 *
 * 1. `--tools` removes mutating tools from the process entirely for read-only
 *    dispatches. This is the strongest control available — the agent cannot
 *    request what it does not have, so there is nothing to bypass.
 * 2. Our own PermissionGate classifies anything that does reach a shell.
 *
 * Layer 1 alone makes read-only question answering safe today. Live in-meeting
 * approval for mutating actions additionally needs a PreToolUse hook, which is
 * wired below but marked unverified — see `buildHookSettings`.
 */

/** Read-only dispatches get inspection tools only. Nothing here can mutate. */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/**
 * Standard dispatches additionally get Bash, whose invocations are classified by
 * our gate. Edit/Write are deliberately excluded even here: a meeting is a poor
 * venue for reviewing a code change, and the product's value is answering
 * questions and running known commands, not silently editing someone's repo.
 */
const STANDARD_TOOLS = [...READ_ONLY_TOOLS, 'Bash'] as const;

const SYSTEM_PROMPT = [
  'You are answering a question dispatched from a live meeting.',
  'Be brief: your reply is read aloud, so aim for two or three sentences.',
  'Do not paste code blocks or file contents — describe what you found instead.',
  'If you cannot answer from the repository, say so plainly.',
].join(' ');

export interface ClaudeCodeAdapterOptions {
  readonly executable: string;
  /**
   * How to spawn without a shell. On Windows this resolves past the npm `.cmd`
   * shim to `node cli.js` — see AgentLauncher in ./detect.ts for why that
   * matters for injection safety.
   */
  readonly launcher: AgentLauncher;
  /** Localhost URL the PreToolUse hook calls back into. */
  readonly hookEndpoint?: string;
  readonly hookScriptPath?: string;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = 'claude-code' as const;
  readonly label = 'Claude Code';
  readonly executable: string;

  readonly #launcher: AgentLauncher;
  readonly #hookEndpoint: string | undefined;
  readonly #hookScriptPath: string | undefined;

  constructor(options: ClaudeCodeAdapterOptions) {
    this.executable = options.executable;
    this.#launcher = options.launcher;
    this.#hookEndpoint = options.hookEndpoint;
    this.#hookScriptPath = options.hookScriptPath;
  }

  /**
   * MCP server names, which is what Lily routes on.
   *
   * `claude mcp list` prints one server per line, or a "No MCP servers
   * configured" sentinel. Parsing stdout is unfortunate but there is no
   * machine-readable form of this command in 2.0.31.
   */
  async capabilities(): Promise<string[]> {
    try {
      const { stdout } = await run(
        this.#launcher.command,
        [...this.#launcher.prefixArgs, 'mcp', 'list'],
        { timeout: 20_000, windowsHide: true },
      );

      if (/no mcp servers configured/i.test(stdout)) return [];

      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        // Lines look like "name: command" or "name: url (transport)".
        .map((line) => /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined);
    } catch (error) {
      log.warn('agent.capabilities_failed', { kind: this.kind, error: String(error).slice(0, 120) });
      return [];
    }
  }

  /**
   * Inline settings injecting a PreToolUse hook, so a gated command pauses for
   * spoken approval instead of failing.
   *
   * UNVERIFIED: the hook payload and response schema below follow Claude Code's
   * documented PreToolUse contract, but were not confirmed against 2.0.31 on
   * this machine. Until they are, `run()` only attaches this when a hook script
   * is explicitly configured — the default path relies on `--tools` restriction,
   * which is verified. Confirm the schema before enabling this in production.
   */
  #buildHookSettings(): string | null {
    if (this.#hookScriptPath === undefined || this.#hookEndpoint === undefined) return null;

    return JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: `${process.execPath} "${this.#hookScriptPath}" --endpoint "${this.#hookEndpoint}"`,
              },
            ],
          },
        ],
      },
    });
  }

  async *run(task: string, options: AgentRunOptions): AsyncIterable<AgentEvent> {
    const tools = options.mode === 'read_only' ? READ_ONLY_TOOLS : STANDARD_TOOLS;

    const args = [
      '-p',
      task,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--tools',
      tools.join(','),
      '--add-dir',
      options.cwd,
      '--append-system-prompt',
      SYSTEM_PROMPT,
    ];

    const hookSettings = this.#buildHookSettings();
    if (hookSettings !== null) args.push('--settings', hookSettings);

    log.info('agent.run_start', {
      taskId: options.taskId,
      kind: this.kind,
      mode: options.mode,
      tools: tools.join(','),
    });

    // shell: false throughout — `task` originates in a meeting and is passed as
    // an argument, so no shell may ever parse it.
    const child = spawn(this.#launcher.command, [...this.#launcher.prefixArgs, ...args], {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // A dispatched task must never outlive the meeting that asked for it.
    const deadline = setTimeout(() => {
      log.warn('agent.deadline_exceeded', { taskId: options.taskId });
      child.kill('SIGTERM');
      // SIGTERM first so the agent can clean up; SIGKILL only if it ignores it.
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
    }, options.deadlineSec * 1_000);
    deadline.unref?.();

    const onAbort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep only the tail: stderr can be long, and it is never persisted.
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-500);
    });

    const answerParts: string[] = [];

    try {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;

        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue; // Non-JSON noise on stdout is not fatal.
        }

        const parsed = interpret(event);
        if (parsed === null) continue;

        if (parsed.type === 'answer') {
          answerParts.push(parsed.text);
        } else {
          yield parsed;
        }
      }

      const exitCode = await new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? -1));
      });

      if (answerParts.length > 0) {
        const { text, truncated } = truncateAnswer(answerParts.join(''));
        yield { type: 'answer', text, truncated };
        return;
      }

      yield {
        type: 'error',
        message:
          exitCode === 0
            ? 'The agent finished without producing an answer.'
            : `The agent exited with code ${exitCode}. ${stderrTail.slice(-200)}`.trim(),
      };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }
}

/**
 * Map one stream-json event onto our vendor-neutral event type.
 *
 * Only the shapes we actually consume are handled; unknown events are ignored
 * rather than treated as errors, so a Claude Code update that adds an event type
 * does not break dispatch.
 */
function interpret(event: unknown): AgentEvent | null {
  if (typeof event !== 'object' || event === null) return null;
  const record = event as Record<string, unknown>;
  const type = record['type'];

  if (type === 'assistant' || type === 'result') {
    const text = extractText(record);
    return text === null ? null : { type: 'answer', text, truncated: false };
  }

  // Tool activity becomes a short, content-free progress note for the meeting.
  if (type === 'tool_use' || type === 'tool_result') {
    const name = typeof record['name'] === 'string' ? record['name'] : 'tool';
    return { type: 'status', note: noteForTool(name) };
  }

  return null;
}

function noteForTool(name: string): string {
  switch (name) {
    case 'Read':
      return 'reading files';
    case 'Grep':
    case 'Glob':
      return 'searching the repo';
    case 'Bash':
      return 'running a command';
    default:
      return 'working';
  }
}

function extractText(record: Record<string, unknown>): string | null {
  const direct = record['result'];
  if (typeof direct === 'string' && direct.trim() !== '') return direct;

  const message = record['message'];
  if (typeof message !== 'object' || message === null) return null;

  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;

  const text = content
    .map((block) =>
      typeof block === 'object' && block !== null && (block as Record<string, unknown>)['type'] === 'text'
        ? String((block as Record<string, unknown>)['text'] ?? '')
        : '',
    )
    .join('');

  return text.trim() === '' ? null : text;
}

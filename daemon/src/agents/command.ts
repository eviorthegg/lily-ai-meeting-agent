import { spawn } from 'node:child_process';
import { expandHome, type AgentTemplate } from '../config.js';
import { log } from '../log.js';
import { resolveLauncher, type AgentLauncher } from './detect.js';
import {
  truncateAnswer,
  type AgentAdapter,
  type AgentEvent,
  type AgentRunOptions,
} from './types.js';

/**
 * Generic, config-driven adapter.
 *
 * This is what makes "any agent can be wired in" true rather than aspirational.
 * An employee running something nobody has written an adapter for — an internal
 * CLI, a new vendor, a shell wrapper around their own tooling — describes it in
 * `~/.lily/config.json` and it participates in dispatch:
 *
 *   { "agent": { "command": "claude", "args": ["-p", "{{task}}"], "cwd": "~/work" } }
 *
 * The tradeoff is honest: a vendor-specific adapter can stream progress and read
 * structured events, while this one only knows "process ran, here is stdout". It
 * answers questions correctly; it just cannot narrate the middle.
 */

/** Placeholders substituted into `args`, in the order a template is likely to use them. */
const PLACEHOLDERS = ['task', 'taskId', 'mode', 'cwd'] as const;

export class CommandAdapterError extends Error {}

export class CommandAdapter implements AgentAdapter {
  readonly kind = 'custom' as const;
  readonly label: string;
  readonly executable: string;

  readonly #launcher: AgentLauncher;
  readonly #template: AgentTemplate;

  private constructor(template: AgentTemplate, launcher: AgentLauncher) {
    this.#template = template;
    this.#launcher = launcher;
    this.executable = template.command;
    this.label = `Custom agent (${template.command})`;
  }

  /**
   * Build an adapter from a config template.
   *
   * Validation happens here rather than at dispatch time: a template that can
   * never convey the task should fail when the daemon starts, not silently run
   * the agent with no prompt in the middle of a meeting.
   */
  static async create(template: AgentTemplate): Promise<CommandAdapter> {
    const carriesTask =
      template.stdin_task || template.args.some((arg) => arg.includes('{{task}}'));

    if (!carriesTask) {
      throw new CommandAdapterError(
        'agent template has no {{task}} placeholder in args and stdin_task is false, ' +
          'so the dispatched task would never reach the agent. Add "{{task}}" to args ' +
          'or set "stdin_task": true.',
      );
    }

    // Resolve past a Windows npm shim so the child can be spawned without a
    // shell. See AgentLauncher in ./detect.ts — the task text comes from a
    // meeting and goes into argv, so no shell may ever parse it.
    const launcher = await resolveLauncher(template.command);
    return new CommandAdapter(template, launcher);
  }

  /**
   * Declared in config, because a generic subprocess cannot be introspected.
   *
   * Returning [] when undeclared is the right default: Lily then simply never
   * routes calendar or GitHub work to this employee, which is a missed
   * opportunity rather than a broken promise made in a meeting.
   */
  async capabilities(): Promise<string[]> {
    return [...(this.#template.capabilities ?? [])];
  }

  #buildArgs(task: string, options: AgentRunOptions): string[] {
    const values: Record<(typeof PLACEHOLDERS)[number], string> = {
      task,
      taskId: options.taskId,
      mode: options.mode,
      cwd: options.cwd,
    };

    return this.#template.args.map((arg) => {
      let out = arg;
      for (const name of PLACEHOLDERS) {
        // Substituted into a single argv slot, never concatenated into a command
        // line, so a task containing quotes or semicolons stays inert.
        out = out.split(`{{${name}}}`).join(values[name]);
      }
      return out;
    });
  }

  async *run(task: string, options: AgentRunOptions): AsyncIterable<AgentEvent> {
    const cwd = this.#template.cwd === undefined ? options.cwd : expandHome(this.#template.cwd);
    const args = [...this.#launcher.prefixArgs, ...this.#buildArgs(task, options)];

    log.info('agent.run_start', {
      taskId: options.taskId,
      kind: this.kind,
      mode: options.mode,
      command: this.#template.command,
    });

    const child = spawn(this.#launcher.command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      // The agent is meant to run with the employee's own environment — its PATH,
      // its MCP server credentials, its tool config. That inheritance is the
      // product, not an oversight; the template can only add to it.
      env: { ...process.env, ...(this.#template.env ?? {}) },
      stdio: [this.#template.stdin_task ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    if (this.#template.stdin_task) child.stdin?.end(task, 'utf8');

    const deadline = setTimeout(() => {
      log.warn('agent.deadline_exceeded', { taskId: options.taskId, kind: this.kind });
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
    }, options.deadlineSec * 1_000);
    deadline.unref?.();

    const onAbort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let stdout = '';
    let stderrTail = '';
    let spawnError: Error | null = null;

    // `spawn` types these as nullable because they are null when the
    // corresponding stdio slot is 'ignore' or 'inherit'. This adapter always
    // pipes both, so a null here would mean the spawn options drifted — worth
    // failing loudly rather than silently capturing no output.
    if (child.stdout === null || child.stderr === null) {
      throw new Error(
        'CommandAdapter requires piped stdout and stderr; check the spawn stdio configuration.',
      );
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      // Bounded so a runaway agent cannot grow the daemon's heap without limit.
      // Kept from the end: the answer is almost always the last thing printed.
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-500);
    });
    child.on('error', (error) => {
      spawnError = error;
    });

    try {
      // Progress cannot be narrated from opaque stdout, so the meeting at least
      // learns that work has started.
      yield { type: 'status', note: 'working' };

      const exitCode = await new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? -1));
      });

      if (spawnError !== null) {
        yield {
          type: 'error',
          message: `Could not start "${this.#template.command}": ${(spawnError as Error).message}`,
        };
        return;
      }

      if (exitCode !== 0) {
        yield {
          type: 'error',
          message: `The agent exited with code ${exitCode}. ${stderrTail.slice(-200)}`.trim(),
        };
        return;
      }

      const { text, truncated } = truncateAnswer(stdout);
      if (text === '') {
        yield { type: 'error', message: 'The agent finished without producing an answer.' };
        return;
      }

      yield { type: 'answer', text, truncated };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }
}

import type { DaemonConfig } from '../config.js';
import { log } from '../log.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CommandAdapter } from './command.js';
import { detectAgents, resolveLauncher, type DetectedAgent } from './detect.js';
import type { AgentAdapter } from './types.js';

export * from './types.js';
export { detectAgents, detectAgent, type DetectedAgent } from './detect.js';
export { ClaudeCodeAdapter } from './claude-code.js';
export { CommandAdapter, CommandAdapterError } from './command.js';

export class NoAgentError extends Error {}

/**
 * Decide which agent this daemon drives.
 *
 * Explicit config always wins over detection. An employee who has written an
 * `agent` block has made a decision, and silently driving something else because
 * it happened to be on PATH would be the wrong kind of helpful.
 *
 * Auto-detection only ever selects Claude Code, because that is the only agent
 * whose non-interactive surface has been verified. The others are reported by
 * `detect` so the employee knows they were seen, but wiring one up is a
 * deliberate act via the `agent` template — guessing at another vendor's flags
 * would produce an agent that fails silently in a meeting.
 */
export async function resolveAdapter(config: DaemonConfig): Promise<AgentAdapter> {
  const template = config.agent;

  if (template !== undefined) {
    if (template.kind === 'claude-code') {
      const launcher = await resolveLauncher(template.command);
      return new ClaudeCodeAdapter({ executable: template.command, launcher });
    }
    return CommandAdapter.create(template);
  }

  const detected = await detectAgents();
  const claude = detected.find((agent) => agent.kind === 'claude-code');

  if (claude !== undefined) {
    log.info('agents.auto_selected', { kind: claude.kind, version: claude.version ?? 'unknown' });
    return new ClaudeCodeAdapter({ executable: claude.executable, launcher: claude.launcher });
  }

  throw new NoAgentError(describeNoAgent(detected));
}

function describeNoAgent(detected: readonly DetectedAgent[]): string {
  if (detected.length === 0) {
    return (
      'No coding agent was found on PATH. Install Claude Code (npm i -g @anthropic-ai/claude-code), ' +
      'or describe your own agent in ~/.lily/config.json under "agent".'
    );
  }

  const names = detected.map((agent) => agent.label).join(', ');
  return (
    `Found ${names}, but only Claude Code can be driven automatically. ` +
    'Add an "agent" block to ~/.lily/config.json describing how to run yours, e.g. ' +
    '{ "agent": { "command": "codex", "args": ["exec", "{{task}}"], "cwd": "~/work" } }'
  );
}

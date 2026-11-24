import type { DispatchMode } from '../permissions.js';

/**
 * Agent adapter contract.
 *
 * The product promise is that ANY coding agent can be wired in — Claude Code,
 * Codex, Cursor, Gemini CLI, Windsurf, or a bespoke CLI — so nothing above this
 * interface may assume a particular vendor's flags or output format.
 */

export type AgentKind =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'gemini-cli'
  | 'windsurf'
  | 'custom';

export interface AgentRunOptions {
  readonly taskId: string;
  readonly cwd: string;
  readonly mode: DispatchMode;
  /** Wall-clock budget. A dispatched task must not outlive the meeting. */
  readonly deadlineSec: number;
  readonly signal?: AbortSignal;
}

/**
 * Streamed progress.
 *
 * `status` exists so the meeting sees live work-in-progress under Lily's avatar
 * rather than 30 seconds of silence. Notes are short and content-free by
 * construction — "searching the repo", never what was found.
 */
export type AgentEvent =
  | { readonly type: 'status'; readonly note: string }
  | { readonly type: 'permission'; readonly requestId: string; readonly command: string }
  | { readonly type: 'answer'; readonly text: string; readonly truncated: boolean }
  | { readonly type: 'error'; readonly message: string };

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** Human-readable, for the status UI. */
  readonly label: string;

  /** Absolute path to the executable this adapter drives. */
  readonly executable: string;

  /**
   * Run a task, streaming progress. Implementations must terminate the child
   * process when the signal aborts or the deadline passes — an orphaned agent
   * holding a repo lock outlives the meeting that started it.
   */
  run(task: string, options: AgentRunOptions): AsyncIterable<AgentEvent>;

  /**
   * Tool and MCP server NAMES this agent can reach, e.g. ['google-calendar'].
   *
   * Lily routes on this — she needs to know John's agent can reach a calendar
   * and Sarah's cannot, so she doesn't promise something undeliverable. Names
   * only: never anything those tools can see.
   */
  capabilities(): Promise<string[]>;
}

/** Cap on the answer relayed back, mirroring the protocol's own limit. */
export const MAX_ANSWER_CHARS = 4_000;

export function truncateAnswer(text: string): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  return trimmed.length <= MAX_ANSWER_CHARS
    ? { text: trimmed, truncated: false }
    : { text: `${trimmed.slice(0, MAX_ANSWER_CHARS - 1)}…`, truncated: true };
}

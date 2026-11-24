/**
 * Stand-in employee agents, in this process.
 *
 * What this is: a substitute for machines that are not here. Running the demo
 * on one laptop means there is exactly one computer in the room, so the other
 * four employees' agents have to come from somewhere.
 *
 * What this is NOT: a mock of anything this package owns. It implements
 * `DaemonLink` and nothing else. Classification, the permission gate,
 * turn-taking, task memory, metering and wrap-up are the same code with this
 * link as with `WsDaemonLink` — the only difference is which side of the socket
 * the agent lives on.
 *
 * Its answers are labelled as simulated rather than invented. A plausible-
 * sounding fake answer about a codebase is worse than an honest placeholder,
 * because someone will eventually screenshot it and believe it.
 */

import { newRequestId } from '../util/ids.js';
import type { Timers } from '../util/clock.js';
import { systemTimers } from '../util/clock.js';
import {
  DaemonNotConnectedError,
  Emitter,
  type AgentStatus,
  type DaemonLink,
  type FromEmployee,
  type PermissionRequest,
  type PermissionResponse,
  type TaskCancel,
  type TaskDispatch,
  type TaskResult,
  type Unsubscribe,
} from './link.js';
import type { ActionKind } from '@lily/shared/protocol';

export type SimulatedStep =
  | { readonly kind: 'status'; readonly afterMs: number; readonly state: AgentStatus['state']; readonly note?: string }
  | {
      readonly kind: 'permission';
      readonly afterMs: number;
      readonly actionKind: ActionKind;
      readonly detail: string;
      readonly reason?: string;
    }
  | { readonly kind: 'result'; readonly afterMs: number; readonly ok: boolean; readonly answer: string; readonly error?: string };

export interface SimulatedAgent {
  readonly employeeId: string;
  readonly agentKind: string;
  readonly capabilities: readonly string[];
  dnd?: boolean;
  /** Produce the script for one dispatched task. */
  readonly plan?: (task: TaskDispatch) => readonly SimulatedStep[];
}

export interface LoopbackDaemonLinkOptions {
  readonly agents: readonly SimulatedAgent[];
  readonly timers?: Timers;
  /**
   * Scale every scripted delay. Tests set 0 for instant completion; the demo
   * leaves it at 1 so the room actually sees the work-in-progress status and
   * the "acknowledge now, answer later" behaviour it is there to demonstrate.
   */
  readonly speed?: number;
}

/** The default script: think for a moment, then answer. */
function defaultPlan(task: TaskDispatch): readonly SimulatedStep[] {
  const wantsChange = task.mode === 'standard';

  const steps: SimulatedStep[] = [
    { kind: 'status', afterMs: 150, state: 'running', note: 'reading the repo' },
    { kind: 'status', afterMs: 1_600, state: 'running', note: 'putting an answer together' },
  ];

  if (wantsChange) {
    steps.push({
      kind: 'status',
      afterMs: 2_400,
      state: 'awaiting_permission',
      note: 'waiting on approval',
    });
    steps.push({
      kind: 'permission',
      afterMs: 2_500,
      actionKind: 'test',
      detail: 'npm test',
      reason: 'to check nothing broke before reporting back',
    });
  }

  steps.push({
    kind: 'result',
    afterMs: wantsChange ? 6_000 : 3_200,
    ok: true,
    answer:
      `[simulated agent] I received: "${task.text}". ` +
      `A real Claude Code daemon would answer this from the repo on ${task.requesterEmployeeId}'s ` +
      `machine. Point one at the daemon port to get a real answer.`,
  });

  return steps;
}

export class LoopbackDaemonLink implements DaemonLink {
  readonly kind = 'loopback' as const;

  readonly #agents = new Map<string, SimulatedAgent>();
  readonly #timers: Timers;
  readonly #speed: number;
  readonly #inFlight = new Map<string, { employeeId: string; cancelled: boolean }>();
  /** requestId → the task it belongs to, so a response can be routed back. */
  readonly #awaiting = new Map<string, { taskId: string; employeeId: string }>();

  readonly #status = new Emitter<[FromEmployee<AgentStatus>]>();
  readonly #result = new Emitter<[FromEmployee<TaskResult>]>();
  readonly #permission = new Emitter<[FromEmployee<PermissionRequest>]>();
  readonly #presence = new Emitter<[string, boolean]>();

  #closed = false;

  constructor(options: LoopbackDaemonLinkOptions) {
    for (const agent of options.agents) this.#agents.set(agent.employeeId, agent);
    this.#timers = options.timers ?? systemTimers;
    this.#speed = options.speed ?? 1;
  }

  connectedEmployees(): readonly string[] {
    return [...this.#agents.keys()];
  }

  isConnected(employeeId: string): boolean {
    return !this.#closed && this.#agents.has(employeeId);
  }

  isDnd(employeeId: string): boolean {
    return this.#agents.get(employeeId)?.dnd === true;
  }

  /** Flip an agent's presence, for demonstrating a mid-meeting disconnect. */
  setConnected(employeeId: string, agent: SimulatedAgent | null): void {
    if (agent === null) {
      this.#agents.delete(employeeId);
      this.#presence.emit(employeeId, false);
      return;
    }
    this.#agents.set(employeeId, agent);
    this.#presence.emit(employeeId, true);
  }

  async dispatch(employeeId: string, payload: TaskDispatch): Promise<void> {
    const agent = this.#agents.get(employeeId);
    if (agent === undefined || this.#closed) throw new DaemonNotConnectedError(employeeId);

    this.#inFlight.set(payload.taskId, { employeeId, cancelled: false });

    const steps = (agent.plan ?? defaultPlan)(payload);
    for (const step of steps) {
      const delay = Math.max(0, Math.round(step.afterMs * this.#speed));
      this.#timers.after(delay, () => {
        const record = this.#inFlight.get(payload.taskId);
        if (record === undefined || record.cancelled) return;

        switch (step.kind) {
          case 'status':
            this.#status.emit({
              employeeId,
              payload: {
                taskId: payload.taskId,
                state: step.state,
                ...(step.note === undefined ? {} : { note: step.note }),
              },
            });
            return;

          case 'permission': {
            const requestId = newRequestId();
            this.#awaiting.set(requestId, { taskId: payload.taskId, employeeId });
            this.#permission.emit({
              employeeId,
              payload: {
                taskId: payload.taskId,
                requestId,
                kind: step.actionKind,
                detail: step.detail,
                ...(step.reason === undefined ? {} : { reason: step.reason }),
              },
            });
            return;
          }

          case 'result':
            this.#inFlight.delete(payload.taskId);
            this.#status.emit({
              employeeId,
              payload: { taskId: payload.taskId, state: step.ok ? 'done' : 'failed' },
            });
            this.#result.emit({
              employeeId,
              payload: {
                taskId: payload.taskId,
                ok: step.ok,
                answer: step.answer,
                truncated: false,
                ...(step.error === undefined ? {} : { error: step.error }),
              },
            });
            return;
        }
      });
    }
  }

  async cancel(employeeId: string, payload: TaskCancel): Promise<void> {
    const record = this.#inFlight.get(payload.taskId);
    if (record === undefined) return;
    record.cancelled = true;
    this.#inFlight.delete(payload.taskId);
    void employeeId;
  }

  async respondToPermission(employeeId: string, payload: PermissionResponse): Promise<void> {
    const waiting = this.#awaiting.get(payload.requestId);
    if (waiting === undefined) return;
    this.#awaiting.delete(payload.requestId);

    // A denial is not a failure of the task; the agent reports what it could do
    // without the thing it was refused. That is the behaviour the room should
    // see, so the simulator reproduces it rather than erroring out.
    if (!payload.approved) {
      this.#status.emit({
        employeeId,
        payload: { taskId: payload.taskId, state: 'running', note: 'continuing without that step' },
      });
    }
  }

  onStatus(handler: (event: FromEmployee<AgentStatus>) => void): Unsubscribe {
    return this.#status.on(handler);
  }
  onResult(handler: (event: FromEmployee<TaskResult>) => void): Unsubscribe {
    return this.#result.on(handler);
  }
  onPermissionRequest(handler: (event: FromEmployee<PermissionRequest>) => void): Unsubscribe {
    return this.#permission.on(handler);
  }
  onPresenceChange(handler: (employeeId: string, connected: boolean) => void): Unsubscribe {
    return this.#presence.on(handler);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const record of this.#inFlight.values()) record.cancelled = true;
    this.#inFlight.clear();
    this.#awaiting.clear();
    this.#status.clear();
    this.#result.clear();
    this.#permission.clear();
    this.#presence.clear();
  }
}

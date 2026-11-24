/**
 * Real daemons where they exist; stand-ins for the rest.
 *
 * The demo runs on one laptop, so at most one employee's agent can be genuinely
 * present. Rather than make that an all-or-nothing choice, this routes each
 * employee to whichever link actually has them — and a real connection always
 * wins, including one that arrives mid-meeting.
 *
 * The practical shape of the demo: start the room, attach your own Claude Code
 * daemon as one of the participants, and watch Lily dispatch real work to it
 * while the other four employees answer from the simulator.
 */

import { log } from '../util/log.js';
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

export class CompositeDaemonLink implements DaemonLink {
  readonly kind = 'websocket' as const;

  readonly #primary: DaemonLink;
  readonly #fallback: DaemonLink;
  readonly #subscriptions: Unsubscribe[] = [];

  readonly #status = new Emitter<[FromEmployee<AgentStatus>]>();
  readonly #result = new Emitter<[FromEmployee<TaskResult>]>();
  readonly #permission = new Emitter<[FromEmployee<PermissionRequest>]>();
  readonly #presence = new Emitter<[string, boolean]>();

  /** Which link a task went out on, so its cancel and its permission response follow it. */
  readonly #routeByTask = new Map<string, DaemonLink>();

  constructor(primary: DaemonLink, fallback: DaemonLink) {
    this.#primary = primary;
    this.#fallback = fallback;

    for (const link of [primary, fallback]) {
      this.#subscriptions.push(
        link.onStatus((event) => this.#status.emit(event)),
        link.onResult((event) => this.#result.emit(event)),
        link.onPermissionRequest((event) => this.#permission.emit(event)),
        link.onPresenceChange((employeeId, connected) => {
          this.#presence.emit(employeeId, connected);
          if (link === primary) {
            log.info('daemon_link.real_agent', { employeeId, connected });
          }
        }),
      );
    }
  }

  #linkFor(employeeId: string): DaemonLink | null {
    if (this.#primary.isConnected(employeeId)) return this.#primary;
    if (this.#fallback.isConnected(employeeId)) return this.#fallback;
    return null;
  }

  connectedEmployees(): readonly string[] {
    return [
      ...new Set([...this.#primary.connectedEmployees(), ...this.#fallback.connectedEmployees()]),
    ];
  }

  isConnected(employeeId: string): boolean {
    return this.#linkFor(employeeId) !== null;
  }

  isDnd(employeeId: string): boolean {
    return this.#linkFor(employeeId)?.isDnd(employeeId) ?? false;
  }

  async dispatch(employeeId: string, payload: TaskDispatch): Promise<void> {
    const link = this.#linkFor(employeeId);
    if (link === null) throw new DaemonNotConnectedError(employeeId);
    this.#routeByTask.set(payload.taskId, link);
    await link.dispatch(employeeId, payload);
  }

  async cancel(employeeId: string, payload: TaskCancel): Promise<void> {
    const link = this.#routeByTask.get(payload.taskId) ?? this.#linkFor(employeeId);
    this.#routeByTask.delete(payload.taskId);
    await link?.cancel(employeeId, payload);
  }

  async respondToPermission(employeeId: string, payload: PermissionResponse): Promise<void> {
    // Must go back to the link the task went out on: answering the simulator
    // for a request a real agent made would leave that agent waiting forever.
    const link = this.#routeByTask.get(payload.taskId) ?? this.#linkFor(employeeId);
    if (link === null) throw new DaemonNotConnectedError(employeeId);
    await link.respondToPermission(employeeId, payload);
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
    for (const unsubscribe of this.#subscriptions) unsubscribe();
    this.#subscriptions.length = 0;
    this.#routeByTask.clear();
    await this.#primary.close();
    await this.#fallback.close();
  }
}

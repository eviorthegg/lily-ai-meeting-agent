/**
 * The orchestrator's side of the daemon conversation.
 *
 * Payload shapes come from `@lily/shared/protocol` and are not restated here.
 * That module is the wire contract; this one is a consumer of it, and a second
 * declaration of `task.dispatch` in this package would be a second source of
 * truth that drifts.
 *
 * Two implementations exist. `WsDaemonLink` accepts real daemon connections
 * over the documented protocol. `LoopbackDaemonLink` stands in for employee
 * machines that are not present — which is a legitimate absence locally, not a
 * mock of anything this package owns: every line of orchestration above this
 * interface is the same in both cases.
 */

import type { z } from 'zod';
import type {
  permissionRequestSchema,
  permissionResponseSchema,
  agentStatusSchema,
  taskCancelSchema,
  taskDispatchSchema,
  taskResultSchema,
} from '@lily/shared/protocol';

export type TaskDispatch = z.infer<typeof taskDispatchSchema>;
export type TaskCancel = z.infer<typeof taskCancelSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;
export type PermissionResponse = z.infer<typeof permissionResponseSchema>;

export type Unsubscribe = () => void;

/** Which employee a daemon message came from. The link resolves it, not the caller. */
export interface FromEmployee<T> {
  readonly employeeId: string;
  readonly payload: T;
}

export interface DaemonLink {
  readonly kind: 'websocket' | 'loopback';

  /** Employees with a live daemon right now. */
  connectedEmployees(): readonly string[];
  isConnected(employeeId: string): boolean;
  /** Employee-set Do Not Disturb. Nothing is dispatched to a daemon in DND. */
  isDnd(employeeId: string): boolean;

  dispatch(employeeId: string, payload: TaskDispatch): Promise<void>;
  cancel(employeeId: string, payload: TaskCancel): Promise<void>;
  respondToPermission(employeeId: string, payload: PermissionResponse): Promise<void>;

  onStatus(handler: (event: FromEmployee<AgentStatus>) => void): Unsubscribe;
  onResult(handler: (event: FromEmployee<TaskResult>) => void): Unsubscribe;
  onPermissionRequest(handler: (event: FromEmployee<PermissionRequest>) => void): Unsubscribe;
  onPresenceChange(handler: (employeeId: string, connected: boolean) => void): Unsubscribe;

  close(): Promise<void>;
}

export class DaemonNotConnectedError extends Error {
  override readonly name = 'DaemonNotConnectedError';
  readonly employeeId: string;

  constructor(employeeId: string) {
    super(`No daemon is connected for employee ${employeeId}.`);
    this.employeeId = employeeId;
  }
}

/** Small shared emitter, so both links behave identically around subscription. */
export class Emitter<T extends unknown[]> {
  readonly #handlers = new Set<(...args: T) => void>();

  on(handler: (...args: T) => void): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  emit(...args: T): void {
    for (const handler of [...this.#handlers]) handler(...args);
  }

  clear(): void {
    this.#handlers.clear();
  }
}

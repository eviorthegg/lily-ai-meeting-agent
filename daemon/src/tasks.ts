import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from './agents/types.js';
import type { PermissionResponse, TaskCancel, TaskDispatch } from './connection.js';
import { errText, log } from './log.js';
import { PermissionGate, type GateResolution } from './permissions.js';

/**
 * Runs meeting-dispatched tasks against the local agent.
 *
 * Kept separate from the socket so that "what happens when a task arrives" can be
 * reasoned about — and tested — without a WebSocket, and so that a bug in task
 * execution cannot take the connection down with it.
 */

export type TaskState = 'queued' | 'running' | 'awaiting_permission' | 'done' | 'failed';

/**
 * What the local status page shows.
 *
 * In memory only, capped, and never written to disk. `label` is a clipped copy of
 * the dispatch text — which came from the meeting, not from this machine — kept
 * solely so the employee can see what their agent was asked to do. It is never
 * sent anywhere and dies with the process.
 */
export interface TaskRecord {
  readonly taskId: string;
  readonly label: string;
  readonly mode: 'read_only' | 'standard';
  readonly startedAt: number;
  state: TaskState;
  endedAt: number | null;
  ok: boolean | null;
}

export interface TaskRunnerDeps {
  readonly adapter: AgentAdapter;
  readonly workspace: string;
  /** Employee-owned. Checked at dispatch time, not just at connect time. */
  readonly isDnd: () => boolean;
  readonly sendStatus: (taskId: string, state: TaskState, note?: string) => void;
  readonly sendResult: (result: {
    taskId: string;
    ok: boolean;
    answer: string;
    truncated: boolean;
    error?: string;
  }) => void;
  readonly sendPermissionRequest: (request: {
    taskId: string;
    requestId: string;
    kind: string;
    detail: string;
  }) => void;
  /** Notifies the status UI that something changed. */
  readonly onChange?: () => void;
}

interface ActiveTask {
  readonly record: TaskRecord;
  readonly controller: AbortController;
}

const MAX_RECENT_TASKS = 20;

export class TaskRunner {
  readonly #deps: TaskRunnerDeps;
  readonly #gate: PermissionGate;
  readonly #active = new Map<string, ActiveTask>();
  readonly #recent: TaskRecord[] = [];

  constructor(deps: TaskRunnerDeps) {
    this.#deps = deps;
    this.#gate = new PermissionGate({
      onAsk: (request) => {
        deps.sendPermissionRequest({
          taskId: request.taskId,
          requestId: request.requestId,
          kind: request.kind,
          detail: request.detail,
        });
      },
    });
  }

  get recent(): readonly TaskRecord[] {
    return this.#recent;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  /** Entry point for an inbound `task.dispatch`. Never throws. */
  dispatch(payload: TaskDispatch): void {
    void this.#run(payload).catch((cause: unknown) => {
      log.error('task.unhandled', { taskId: payload.taskId, error: errText(cause) });
    });
  }

  /** Route an inbound `permission.response` to whatever is waiting on it. */
  resolvePermission(payload: PermissionResponse): void {
    const resolution: GateResolution = { approved: payload.approved, reason: payload.reason };
    if (!this.#gate.resolve(payload.requestId, resolution)) {
      // Late or duplicate answers are normal — the backstop timeout may have
      // already fired — and are not an error condition.
      log.debug('task.permission_response_unmatched', { requestId: payload.requestId });
    }
  }

  cancel(payload: TaskCancel): void {
    const active = this.#active.get(payload.taskId);
    if (active === undefined) return;

    log.info('task.cancelled', { taskId: payload.taskId, reason: payload.reason });
    // Anything waiting on a spoken answer is denied first: the meeting that would
    // have answered is gone.
    this.#gate.abandonAll('denied');
    active.controller.abort();
  }

  /** Local shutdown or DND engaging mid-flight. */
  cancelAll(reason: TaskCancel['reason'] = 'employee_dnd'): void {
    this.#gate.abandonAll('denied');
    for (const taskId of [...this.#active.keys()]) {
      this.cancel({ taskId, reason });
    }
  }

  async #run(payload: TaskDispatch): Promise<void> {
    if (this.#active.has(payload.taskId)) {
      log.warn('task.duplicate_dispatch', { taskId: payload.taskId });
      return;
    }

    const record: TaskRecord = {
      taskId: payload.taskId,
      label: payload.text.slice(0, 120),
      mode: payload.mode,
      startedAt: Date.now(),
      state: 'queued',
      endedAt: null,
      ok: null,
    };

    // DND is the employee's switch and nothing inbound can override it, so this
    // is checked here rather than only being advertised on the heartbeat.
    if (this.#deps.isDnd()) {
      log.info('task.refused_dnd', { taskId: payload.taskId });
      this.#finish(record, false, 'The employee has Do Not Disturb on, so nothing was run.');
      return;
    }

    const controller = new AbortController();
    this.#active.set(payload.taskId, { record, controller });
    this.#remember(record);

    this.#setState(record, 'running', 'starting the agent');

    let answer = '';
    let truncated = false;
    let failure: string | null = null;

    try {
      const events = this.#deps.adapter.run(payload.text, {
        taskId: payload.taskId,
        cwd: this.#deps.workspace,
        mode: payload.mode,
        deadlineSec: payload.deadlineSec,
        signal: controller.signal,
      });

      for await (const event of events) {
        switch (event.type) {
          case 'status':
            this.#setState(record, 'running', event.note);
            break;

          case 'permission': {
            // Awaiting here suspends the adapter's generator at its `yield`, so
            // the agent genuinely stops until the meeting answers rather than
            // running ahead and being vetoed afterwards.
            const outcome = await this.#askPermission(record, payload, event.command);
            if (!outcome.approved) {
              failure = outcome.message;
              controller.abort();
            }
            break;
          }

          case 'answer':
            answer = event.text;
            truncated = event.truncated;
            break;

          case 'error':
            failure = event.message;
            break;
        }
      }
    } catch (cause) {
      failure = errText(cause);
      log.error('task.failed', { taskId: payload.taskId, error: failure });
    } finally {
      this.#active.delete(payload.taskId);
    }

    if (failure !== null) {
      this.#finish(record, false, failure);
      return;
    }

    this.#finish(record, true, null, answer, truncated);
  }

  async #askPermission(
    record: TaskRecord,
    payload: TaskDispatch,
    command: string,
  ): Promise<{ approved: boolean; message: string }> {
    const requestId = randomUUID();
    this.#setState(record, 'awaiting_permission', 'waiting for approval');

    const result = await this.#gate.request(payload.taskId, requestId, {
      command,
      mode: payload.mode,
      selfRequested: payload.selfRequested,
    });

    if (result.approved) {
      this.#setState(record, 'running', 'approved');
      return { approved: true, message: '' };
    }

    const message =
      result.decision.outcome === 'refuse'
        ? result.decision.message
        : result.reason === 'timeout'
          ? 'Nobody approved that in time, so it was not run.'
          : 'That was not approved, so it was not run.';

    return { approved: false, message };
  }

  #setState(record: TaskRecord, state: TaskState, note?: string): void {
    record.state = state;
    this.#deps.sendStatus(record.taskId, state, note);
    this.#deps.onChange?.();
  }

  #finish(
    record: TaskRecord,
    ok: boolean,
    error: string | null,
    answer = '',
    truncated = false,
  ): void {
    record.state = ok ? 'done' : 'failed';
    record.endedAt = Date.now();
    record.ok = ok;

    this.#deps.sendStatus(record.taskId, record.state);
    this.#deps.sendResult({
      taskId: record.taskId,
      ok,
      answer,
      truncated,
      ...(error === null ? {} : { error }),
    });
    this.#deps.onChange?.();

    log.info('task.finished', {
      taskId: record.taskId,
      ok,
      ms: record.endedAt - record.startedAt,
    });
  }

  #remember(record: TaskRecord): void {
    this.#recent.unshift(record);
    if (this.#recent.length > MAX_RECENT_TASKS) this.#recent.length = MAX_RECENT_TASKS;
  }
}

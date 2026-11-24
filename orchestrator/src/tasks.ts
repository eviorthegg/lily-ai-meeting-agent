/**
 * Task memory for the life of one meeting.
 *
 * An array in RAM, deliberately. The meeting's working set is small, the
 * process is disposable, and the only durable record is what the API chooses to
 * write from the summary Lily hands back at the end. Nothing here touches a
 * database and nothing here survives the process.
 */

import { newTaskId } from './util/ids.js';
import type { MeetingTask, MeetingTaskStatus, MeetingTaskType } from './types.js';

export interface NewTask {
  readonly text: string;
  readonly owner_employee_id: string;
  readonly assigned_by: string;
  readonly due: string | null;
  readonly type: MeetingTaskType;
  readonly status: MeetingTaskStatus;
}

export class TaskMemory {
  readonly #tasks: MeetingTask[] = [];
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  add(task: NewTask): MeetingTask {
    const created: MeetingTask = {
      id: newTaskId(),
      text: task.text,
      owner_employee_id: task.owner_employee_id,
      assigned_by: task.assigned_by,
      due: task.due,
      status: task.status,
      type: task.type,
      created_at: this.#now().toISOString(),
    };
    this.#tasks.push(created);
    return created;
  }

  get(id: string): MeetingTask | null {
    return this.#tasks.find((task) => task.id === id) ?? null;
  }

  all(): readonly MeetingTask[] {
    return [...this.#tasks];
  }

  byOwner(employeeId: string): readonly MeetingTask[] {
    return this.#tasks.filter((task) => task.owner_employee_id === employeeId);
  }

  /** Human assignments nobody has said yes to yet — the wrap-up read-back list. */
  unconfirmed(): readonly MeetingTask[] {
    return this.#tasks.filter(
      (task) => task.type === 'human_assignment' && task.status === 'unconfirmed',
    );
  }

  setStatus(id: string, status: MeetingTaskStatus): MeetingTask | null {
    const index = this.#tasks.findIndex((task) => task.id === id);
    if (index === -1) return null;

    const existing = this.#tasks[index];
    if (existing === undefined) return null;

    const updated: MeetingTask = { ...existing, status };
    this.#tasks[index] = updated;
    return updated;
  }

  /**
   * Drop everything.
   *
   * Called on shutdown after the summary has been handed off, so a lingering
   * reference to the process cannot be used to read back the meeting's content.
   */
  clear(): void {
    this.#tasks.length = 0;
  }
}

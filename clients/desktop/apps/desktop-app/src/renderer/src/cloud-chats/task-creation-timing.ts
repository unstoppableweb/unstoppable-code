/**
 * Performance marks for opening a new cloud task (CAN-6098), so a run reads
 * click-to-usable time and where the rest goes with
 * `performance.getEntriesByName`. Each mark's `detail` names the task.
 */
export const CLOUD_TASK_TIMING_MARKS = {
  click: 'canopy:cloud-task:click',
  rowShown: 'canopy:cloud-task:row-shown',
  composerUsable: 'canopy:cloud-task:composer-usable',
  createSettled: 'canopy:cloud-task:create-settled',
} as const;

type ShownMark = 'rowShown' | 'composerUsable';

/** The marks each newly opened task has yet to reach, by bare task id. */
const awaiting = new Map<string, Set<ShownMark>>();

function mark(name: string, detail: Record<string, unknown>): void {
  // A host without the User Timing API records nothing.
  if (typeof globalThis.performance?.mark !== 'function') return;
  performance.mark(name, { detail });
}

/** The user asked for a new task: the clock starts. */
export function markCloudTaskClick(taskId: string): void {
  awaiting.set(taskId, new Set<ShownMark>(['rowShown', 'composerUsable']));
  mark(CLOUD_TASK_TIMING_MARKS.click, { taskId });
}

/** The task's row or composer rendered; marks only the first time. */
export function markCloudTaskShown(taskId: string, which: ShownMark): void {
  const pending = awaiting.get(taskId);
  if (pending?.delete(which) !== true) return;
  if (pending.size === 0) awaiting.delete(taskId);
  mark(CLOUD_TASK_TIMING_MARKS[which], { taskId });
}

/** The web core answered the task's create, either way. */
export function markCloudTaskCreateSettled(
  taskId: string,
  created: boolean,
): void {
  mark(CLOUD_TASK_TIMING_MARKS.createSettled, { taskId, created });
}

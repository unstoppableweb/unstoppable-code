/**
 * The event a schedule's run starts from (CAN-5782): `workflow` for a
 * definition that declares `workflow` without `dispatch`, `dispatch` for one
 * that declares `dispatch`, and `unsupported` for one that declares neither,
 * which no schedule may run. A definition that declares both runs as
 * `dispatch`, so no existing schedule changes its event, its inputs or what
 * its child pipelines inherit. The same rule as the cloud runner's
 * `eventNameFor`, so a schedule runs as the same event on this computer and
 * in the cloud. Browser-safe: main and the renderer both call it.
 */
export type ScheduleRunEvent = 'dispatch' | 'workflow' | 'unsupported';

export function scheduleRunEvent(
  triggerTypes: readonly string[],
): ScheduleRunEvent {
  if (triggerTypes.includes('dispatch')) return 'dispatch';
  if (triggerTypes.includes('workflow')) return 'workflow';
  return 'unsupported';
}

/** Whether a schedule may target a definition with these triggers. */
export function schedulableTriggerTypes(
  triggerTypes: readonly string[],
): boolean {
  return scheduleRunEvent(triggerTypes) !== 'unsupported';
}

/** Whether a definition runs its schedules as `workflow`. */
export function isWorkflowOnlyTriggerTypes(
  triggerTypes: readonly string[],
): boolean {
  return scheduleRunEvent(triggerTypes) === 'workflow';
}

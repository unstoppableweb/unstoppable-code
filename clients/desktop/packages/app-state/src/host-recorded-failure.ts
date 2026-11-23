import { AppErrorSchema, toAppError } from '@canopy/protocol/app-errors';

/**
 * True when the host already recorded the failure a call rejected with, so the
 * surface showing it links to that record instead of recording it again. A
 * desktop IPC rejection carries main's record either as an `appError` the
 * adapter attached or as the restored IPC shape `toAppError` reads. Any other
 * failure, including every browser host's, was not recorded.
 */
export function isHostRecordedFailure(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const carried = AppErrorSchema.safeParse(Reflect.get(error, 'appError'));
    if (carried.success && carried.data.recordedBy !== undefined) return true;
  }
  return toAppError(error)?.recordedBy !== undefined;
}

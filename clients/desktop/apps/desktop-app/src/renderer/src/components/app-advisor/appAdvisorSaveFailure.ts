import type { AppError } from '@canopy/protocol/app-errors';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';

export const APP_ADVISOR_SAVE_FAILED_COPY =
  "Couldn't save the settings. Try again.";

/**
 * The Orchestrator settings banner for a failed save, given the caught value
 * after `toAppError(resolveClientAppError(...))`; `null` for a cancellation.
 * A recorded or typed failure keeps its catalog copy (a full disk says so)
 * and main's recording; an unrecorded one leads with our sentence, the raw
 * reason behind Copy details. There is no offline wording: these are local
 * writes.
 */
export function appAdvisorSaveFailure(
  appError: AppError | undefined,
): InlineFailure | null {
  return appError
    ? inlineFailure(appError, APP_ADVISOR_SAVE_FAILED_COPY)
    : null;
}

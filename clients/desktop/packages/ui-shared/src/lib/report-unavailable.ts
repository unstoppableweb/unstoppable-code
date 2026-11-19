import { createAppError } from '@canopy/protocol/app-errors';
import { recordSurfacedError } from './surfaced-error-port';

/** Defects already recorded as unreportable; bounded, oldest out first. */
const UNREPORTABLE_REFERENCES = new Set<string>();
const MAX_UNREPORTABLE_REFERENCES = 256;

/**
 * Records that the report action itself failed, so a defect the person could
 * not report is not silent. A fixed source only: nothing about the failure,
 * which could carry user content, is passed. With the defect's reference, it
 * records once per defect however many surfaces or retries offered to report
 * it.
 */
export function recordReportUnavailable(referenceId?: string): void {
  if (referenceId !== undefined) {
    if (UNREPORTABLE_REFERENCES.has(referenceId)) return;
    if (UNREPORTABLE_REFERENCES.size >= MAX_UNREPORTABLE_REFERENCES) {
      const oldest = UNREPORTABLE_REFERENCES.values().next();
      if (!oldest.done) UNREPORTABLE_REFERENCES.delete(oldest.value);
    }
    UNREPORTABLE_REFERENCES.add(referenceId);
  }
  recordSurfacedError({
    chokePoint: 'boundary',
    surface: 'inline',
    error: createAppError('app.unexpected', {
      source: 'feedback.report_unavailable',
    }),
  });
}

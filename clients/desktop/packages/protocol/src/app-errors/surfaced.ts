import { z } from 'zod';
import type { AppErrorCode } from './catalog';
import { createAppError } from './create';
import type {
  AppErrorHandler,
  AppErrorReport,
  AppErrorThrownType,
} from './handler';
import { AppErrorTimestampSchema, type AppErrorSurface } from './primitives';

const ChokePointSchema = z.enum(['toast', 'notice', 'banner', 'boundary']);
export type SurfacedErrorChokePoint = z.infer<typeof ChokePointSchema>;

export interface SurfacedErrorInput {
  chokePoint: SurfacedErrorChokePoint;
  /** Trusted static identifier only. Formatting does not establish provenance. */
  identifier?: string;
  surface?: AppErrorSurface;
  text?: string;
  /** An existing classification supported by the display call site. */
  displayErrorCode?: AppErrorCode;
  /** Missing or uncertain sensitivity fails closed. */
  textIsSensitive?: boolean;
  /** Presence selects caught-value classification, even for null/undefined. */
  error?: unknown;
  thrownType?: AppErrorThrownType | undefined;
}

export interface SurfacedErrorRecorderOptions {
  report: AppErrorHandler['report'];
  /** Host permission from the existing raw-detail policy, not a build guess. */
  recordsMessageText: boolean;
  clock?: () => number;
  windowMs?: number;
  maxEntries?: number;
}

export interface SurfacedErrorRecorder {
  record(input: SurfacedErrorInput): AppErrorReport | undefined;
  reset(): void;
  dispose(): void;
}

/** Formatting only: never pass error text, paths or user-derived identifiers. */
export function surfacedErrorSource(
  chokePoint: SurfacedErrorChokePoint,
  identifier?: string,
): string {
  ChokePointSchema.parse(chokePoint);
  let suffix = '';
  for (const token of (identifier ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!token || /\d/.test(token)) continue;
    const candidate = suffix ? `${suffix}-${token}` : token;
    if (candidate.length > 64) break;
    suffix = candidate;
  }
  return suffix ? `${chokePoint}:${suffix}` : chokePoint;
}

const ConfigSchema = z.object({
  recordsMessageText: z.boolean(),
  windowMs: z.number().int().positive().max(60000),
  maxEntries: z.number().int().positive().max(256),
});

/**
 * Samples display sightings before the handler can count structural duplicates.
 * Sensitive text exists only in this instance's bounded cache, never in reports.
 */
export function createSurfacedErrorRecorder(
  options: SurfacedErrorRecorderOptions,
): SurfacedErrorRecorder {
  const config = ConfigSchema.parse({
    recordsMessageText: options.recordsMessageText,
    windowMs: options.windowMs ?? 60000,
    maxEntries: options.maxEntries ?? 256,
  });
  if (typeof options.report !== 'function')
    throw new TypeError('Invalid surfaced error reporter');
  if (options.clock !== undefined && typeof options.clock !== 'function')
    throw new TypeError('Invalid surfaced error clock');
  const clock = options.clock ?? Date.now;
  const report = options.report;
  const sightings = new Map<string, { acceptedAt: number }>();
  let disposed = false;

  function record(input: SurfacedErrorInput): AppErrorReport | undefined {
    try {
      if (disposed) return undefined;
      const source = surfacedErrorSource(input.chokePoint, input.identifier);
      const presentation =
        input.surface === undefined ? {} : { surface: input.surface };
      if (Object.prototype.hasOwnProperty.call(input, 'error')) {
        return report(input.error, {
          ...presentation,
          source,
          ...(input.thrownType === undefined
            ? {}
            : { thrownType: input.thrownType }),
        });
      }

      const text = (input.text ?? '').replace(/\s+/g, ' ').trim();
      const code = input.displayErrorCode ?? 'app.unexpected';
      // Notices and banners can share copy across distinct operations.
      const textSource =
        input.chokePoint === 'notice' || input.chokePoint === 'banner'
          ? source
          : null;
      const key = JSON.stringify(
        text ? [code, 'text', textSource, text] : [code, 'source', source],
      );
      const now = AppErrorTimestampSchema.parse(clock());
      for (const [existingKey, sighting] of sightings) {
        if (now - sighting.acceptedAt >= config.windowMs)
          sightings.delete(existingKey);
      }
      if (sightings.has(key)) return undefined;
      if (sightings.size >= config.maxEntries) {
        const oldest = sightings.keys().next();
        if (!oldest.done) sightings.delete(oldest.value);
      }
      const claim = { acceptedAt: now };
      sightings.set(key, claim);
      try {
        const error = createAppError(code, {
          source,
          ...(config.recordsMessageText &&
          input.textIsSensitive === false &&
          text
            ? { detail: { message: text.slice(0, 4096) } }
            : {}),
        });
        return report(error, presentation);
      } catch {
        // A reentrant reset/report may have replaced this particular claim.
        if (sightings.get(key) === claim) sightings.delete(key);
        return undefined;
      }
    } catch {
      // Best-effort adapters never throw into the product or report themselves.
      return undefined;
    }
  }

  return {
    record,
    reset(): void {
      sightings.clear();
    },
    dispose(): void {
      disposed = true;
      sightings.clear();
    },
  };
}

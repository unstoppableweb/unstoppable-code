import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../common';
import { defineCanopyQuery, defineCanopyQueryRegistry } from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';

/** `worker.visual.render` is its own grant: rendering runs an untrusted page (CAN-6040). */
export const WORKER_VISUAL_GRANTS = {
  render: 'worker.visual.render',
} as const;

// These mirror the offscreen preview service's limits
// (`apps/desktop-app/src/main/browser/visual-preview-types.ts`) and the
// prepared-document bound of `core.chat.visual.stage`; a drift test in the
// desktop app keeps them equal.
export const WORKER_VISUAL_LIMITS = Object.freeze({
  preparedMaxBytes: 4 * 1024 * 1024,
  minWidth: 240,
  maxWidth: 1_600,
  minHeight: 80,
  maxHeight: 2_000,
  measureWidths: 8,
  measureDeadlineMs: 3_000,
  imageBudgetBytes: 1024 * 1024,
  diagnostics: { console: 100, cspViolations: 50, blockedRequests: 50 },
  diagnosticChars: 4096,
});

/**
 * The prepared document only. Image paths the preparer could not resolve are
 * host paths, so they stay with the caller, which reports them itself.
 */
const PreparedVisualSchema = z.strictObject({
  /** The preparer and the staging store bound its UTF-8 size; this bounds its length. */
  html: z.string().max(WORKER_VISUAL_LIMITS.preparedMaxBytes),
});

const width = z
  .number()
  .int()
  .min(WORKER_VISUAL_LIMITS.minWidth)
  .max(WORKER_VISUAL_LIMITS.maxWidth);

/** Rendering is per machine: a scope selects only the authority and target. */
export const WorkerVisualScopeSchema = CanopyWorkspaceScopeSchema.pick({
  authorityId: true,
  targetId: true,
});

export const WorkerVisualRenderParamsSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    scope: WorkerVisualScopeSchema,
    mode: z.literal('measure'),
    prepared: PreparedVisualSchema,
    appearance: z.enum(['light', 'dark']).optional(),
    /** The visual's `maxHeight`; each width is measured in a frame this tall. */
    maxHeight: z
      .number()
      .int()
      .min(WORKER_VISUAL_LIMITS.minHeight)
      .max(WORKER_VISUAL_LIMITS.maxHeight),
    widths: z.array(width).min(1).max(WORKER_VISUAL_LIMITS.measureWidths),
    /** Absolute budget, including any wait for a free render slot. */
    deadlineMs: z
      .number()
      .int()
      .min(0)
      .max(WORKER_VISUAL_LIMITS.measureDeadlineMs),
  }),
  z.strictObject({
    scope: WorkerVisualScopeSchema,
    mode: z.literal('preview'),
    prepared: PreparedVisualSchema,
    appearance: z.enum(['light', 'dark']).optional(),
    width,
    /** Encoded image budget in bytes; 0 means return no image. */
    imageBudgetBytes: z
      .number()
      .int()
      .min(0)
      .max(WORKER_VISUAL_LIMITS.imageBudgetBytes),
  }),
]);

export type WorkerVisualRenderParams = z.output<
  typeof WorkerVisualRenderParamsSchema
>;

const status = z.enum(['ok', 'busy', 'timeout', 'aborted', 'error']);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ms = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(WORKER_VISUAL_LIMITS.diagnosticChars);
const line = z.number().int().optional();

/** Untrusted page output: the agent document can forge any of it. */
const DiagnosticSchema = z.strictObject({
  level: z.enum(['log', 'info', 'warning', 'error']),
  message: text,
  line,
  source: text.optional(),
});

const CspViolationSchema = z.strictObject({
  directive: text,
  blockedUri: text,
  line,
  source: text.optional(),
});

const ImageSchema = z.strictObject({
  dataUrl: z
    .string()
    .max(Math.ceil(WORKER_VISUAL_LIMITS.imageBudgetBytes / 3) * 4 + 64),
  mime: z.enum(['image/png', 'image/jpeg']),
  width: count,
  height: count,
  bytes: count.max(WORKER_VISUAL_LIMITS.imageBudgetBytes),
});

export const WorkerVisualRenderResultSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('measure'),
    status,
    /** `[width, height]` per requested width when `status` is `ok`, else empty. */
    heights: z
      .array(z.tuple([count, count]))
      .max(WORKER_VISUAL_LIMITS.measureWidths),
  }),
  z.strictObject({
    mode: z.literal('preview'),
    status,
    image: ImageSchema.nullable(),
    /** Why `image` is null when the run itself succeeded. */
    imageOmittedReason: text.optional(),
    contentHeight: count,
    capturedHeight: count,
    console: z
      .array(DiagnosticSchema)
      .max(WORKER_VISUAL_LIMITS.diagnostics.console),
    cspViolations: z
      .array(CspViolationSchema)
      .max(WORKER_VISUAL_LIMITS.diagnostics.cspViolations),
    /** Requests the session policy cancelled; not a complete network log. */
    blockedRequests: z
      .array(text)
      .max(WORKER_VISUAL_LIMITS.diagnostics.blockedRequests),
    omitted: z.strictObject({
      console: count,
      cspViolations: count,
      blockedRequests: count,
    }),
    timing: z.strictObject({
      queuedMs: ms,
      loadMs: ms,
      settleMs: ms,
      captureMs: ms,
      totalMs: ms,
    }),
  }),
]);

export type WorkerVisualRenderResult = z.output<
  typeof WorkerVisualRenderResultSchema
>;

/** No operation-specific codes: a host without a render engine is `capability_unavailable`. */
export const WorkerVisualRenderErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.never().optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

/**
 * `worker.visual.render` measures or previews a prepared visual in the
 * host's render engine. It writes nothing. A host without a render engine
 * does not serve it, so a call there fails with `capability_unavailable`.
 */
export const WORKER_VISUAL_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.visual.render': defineCanopyQuery({
      plane: 'worker',
      domain: 'visual',
      version: 1,
      placement: 'worker-only',
      params: WorkerVisualRenderParamsSchema,
      result: WorkerVisualRenderResultSchema,
      error: WorkerVisualRenderErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_VISUAL_GRANTS.render],
    }),
  },
);

import type {
  CuratedPipelineOrigin,
  PipelineIndexEntry,
  PipelineInfo,
} from '@canopy/protocol/pipelines';
import type { AppError } from '@canopy/protocol/app-errors';
import type { ShareFailure } from '@canopy/protocol/sharing';
import type { Pipeline } from './document';

/*
 * The stored definition records the pipeline definitions store reads and
 * writes (CAN-5092): environment-neutral, so the store's portable home in
 * core-runtime and the desktop types share one definition.
 */

export interface PipelineIndex {
  pipelines: PipelineIndexEntry[];
}

export interface PipelineData {
  info: PipelineInfo;
  content: Pipeline;
  /** Exact stored document bytes, when the backing source exposes them. */
  rawContent?: string;
  /**
   * Saved local owner of a user pipeline (`personal` / `org:<uuid>`), set on
   * the single-pipeline read. Absent for unowned or non-local definitions.
   * Main-only metadata; never in YAML or shared publication payloads.
   */
  localRunOwner?: string;
  /**
   * Set instead of `localRunOwner` when saved owners can't be read, so the
   * pipeline never appears unowned; the Run dialog blocks a run with no
   * project, and main refuses one.
   */
  localRunOwnerUnreadable?: true;
}

export interface IPCResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
  /** Structured share failure, set by share handlers alongside `error`. */
  failure?: ShareFailure;
}

/**
 * The result of an install, add, update, remove or save that main reports a
 * caught failure for. `appError` is the failure main recorded for `error`, in
 * wire-safe form, so a caller links to that record instead of recording the
 * failure again. Kept off `IPCResult` so other channels keep their shape.
 */
export type IPCResultWithAppError<T = void> = IPCResult<T> & {
  appError?: AppError;
};

/**
 * The result of a pipeline definition write. `outcome` is `unknown` when the
 * write was sent but its answer never came, so it may have landed: a caller
 * shows that it couldn't be confirmed, never that it failed, and never sends
 * it again. Kept off `IPCResult` so other channels keep their shape.
 */
export type IPCResultWithOutcome<T = void> = IPCResult<T> & {
  outcome?: 'unknown';
  /**
   * CAN-5782: the save was refused because of the workflow's schedules:
   * `blocked` when it would break them, `needs_confirmation` when it would
   * stop schedules an agent created, which a person may confirm.
   */
  scheduleRefusal?: 'blocked' | 'needs_confirmation';
  /**
   * With `needs_confirmation`: the schedules that would stop, which the
   * person's confirmation names back.
   */
  stoppingScheduleIds?: string[];
};

/**
 * CAN-5782: a person's **Approve for schedules** of a user pipeline's saved
 * content. `contentDigest` is the digest of the content the page shows;
 * main refuses when the stored revision or content differs.
 */
export interface ApprovePipelineForSchedulesRequest {
  pipelineId: string;
  revision: number;
  contentDigest: string;
  /**
   * The installed package the page shows the workflow running with, or
   * `null` for none; main refuses when the workflow runs with another.
   */
  packageDigest: string | null;
}

/** Why main refused an approval, beside the result's `error`. */
export type ApprovePipelineForSchedulesRefusal =
  | 'not_found'
  | 'stale_revision'
  | 'content_mismatch'
  | 'package_mismatch'
  | 'agent_granted'
  | 'not_recorded';

/** The stamp an approval recorded: the digest and its revision. */
export interface PipelineScheduleApproval {
  contentHash: string;
  revision: number;
  /** The installed package the approval names; absent for none. */
  packageDigest?: string;
}

export type ApprovePipelineForSchedulesResult =
  IPCResult<PipelineScheduleApproval> & {
    refusal?: ApprovePipelineForSchedulesRefusal;
  };

export interface PipelineSaveInput {
  /** Shared source resolved again in main before a local install. */
  sourceRemoteId?: string;
  curatedOrigin?: CuratedPipelineOrigin;
  id?: string;
  name: string;
  description: string;
  icon: string;
  content: Pipeline;
  /**
   * Validated document bytes to persist verbatim. Used when an integrity pin
   * covers the serialization itself rather than only the parsed pipeline.
   */
  rawContent?: string;
  /**
   * Revision of the user pipeline the caller loaded. A save of an existing
   * pipeline whose stored revision differs is refused as a conflict.
   */
  expectedRevision?: number;
  /**
   * CAN-5782: the schedules an agent created that the person confirmed may
   * stop once this save removes the Manual trigger, as the refusal named
   * them. Main accepts it only for exactly that set.
   */
  confirmAgentSchedulesStop?: string[];
  /**
   * CAN-5782: the page's unsaved schedule inputs, by schedule ID, which it
   * writes right after this save. The schedule check reads them in place of
   * the stored ones; each schedule's own write is still checked.
   */
  pendingScheduleInputs?: Record<string, Record<string, string>>;
}

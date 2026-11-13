/**
 * Availability gates for the actions an execution view can offer.
 *
 * Every predicate here is structural on purpose: this package is shared with
 * the web app and must never import `@canopy/desktop-shared`, so the shapes
 * below describe only the fields each gate reads. Desktop's richer
 * desktop and portal execution projections satisfy them
 * structurally, and the desktop re-export
 * (`apps/desktop-app/src/renderer/src/lib/execution-actions.ts`) is a pure
 * pass-through — these are the real gates.
 */
export interface ExecutionActionSummary {
  readonly status: string;
  readonly parent_execution_id?: string;
}

export interface ExecutionRerunState {
  readonly event_name?: string;
  readonly inputs_persisted?: boolean;
  readonly rerun_context?: {
    readonly event_data?: {
      readonly task_ready?: { readonly task_text?: string };
      readonly plan_ready?: { readonly plan_text?: string };
    };
  };
}

function isRootExecution(entry: ExecutionActionSummary): boolean {
  return entry.parent_execution_id === undefined;
}

export function canRetryExecution(entry: ExecutionActionSummary): boolean {
  return (
    isRootExecution(entry) &&
    (entry.status === 'failure' || entry.status === 'cancelled')
  );
}

export function canRerunExecution(entry: ExecutionActionSummary): boolean {
  return (
    isRootExecution(entry) &&
    (entry.status === 'success' ||
      entry.status === 'failure' ||
      entry.status === 'cancelled')
  );
}

export function canResumeExecution(entry: ExecutionActionSummary): boolean {
  return isRootExecution(entry) && entry.status === 'paused';
}

// ---------------------------------------------------------------------------
// Matrix control gates
//
// A matrix variant is a physical job inside one execution, not a nested child
// execution (`parent_execution_id`).
// ---------------------------------------------------------------------------

/** The fields a gate reads from one physical matrix variant. */
export interface MatrixVariantActionSummary {
  readonly job_id?: string;
  readonly status: string;
}

/**
 * The fields a gate reads from one logical job group.
 */
export interface MatrixJobActionSummary {
  readonly status: string;
  readonly kind: 'single' | 'matrix';
  readonly expansion?: 'pending' | 'expanded' | 'failure';
  readonly variant_job_ids: readonly string[];
}

const TERMINAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  'success',
  'failure',
  'cancelled',
]);

const TERMINAL_MATRIX_VARIANT_STATUSES: ReadonlySet<string> = new Set([
  'success',
  'failure',
  'cancelled',
  'skipped',
]);

const CANCELLABLE_MATRIX_VARIANT_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'queued',
  'waiting_for_capacity',
  'running',
  'restarting',
  'paused',
]);

const RETRYABLE_MATRIX_VARIANT_STATUSES: ReadonlySet<string> = new Set([
  'failure',
  'cancelled',
]);

/** True for an execution status that will not change again. */
export function isTerminalExecutionStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_EXECUTION_STATUSES.has(status);
}

/** True for a matrix variant status that will not change again. */
export function isTerminalMatrixVariantStatus(status: string): boolean {
  return TERMINAL_MATRIX_VARIANT_STATUSES.has(status);
}

/**
 * `Retry all variants` / `Retry failed variants` availability.
 *
 * Retry stays **disabled until the parent execution is terminal** — mirroring
 * the `canRetryExecution` shape above — and the fan-out parent job itself must
 * also be terminal. An ordinary job is never retryable through this path.
 */
export function canRetryMatrixJob(
  executionStatus: string | undefined,
  group: MatrixJobActionSummary | undefined,
): boolean {
  if (!isTerminalExecutionStatus(executionStatus)) {
    return false;
  }
  if (group?.kind !== 'matrix') {
    return false;
  }
  return isTerminalMatrixVariantStatus(group.status);
}

export function canRetryMatrixExpansion(
  executionStatus: string | undefined,
  group: MatrixJobActionSummary | undefined,
  dynamic: boolean,
): boolean {
  return (
    dynamic &&
    group?.expansion === 'failure' &&
    canRetryMatrixJob(executionStatus, group)
  );
}

export function canRetryAllMatrixVariants(
  executionStatus: string | undefined,
  group: MatrixJobActionSummary | undefined,
): boolean {
  return (
    group?.expansion === 'expanded' &&
    group.variant_job_ids.length > 0 &&
    canRetryMatrixJob(executionStatus, group)
  );
}

/**
 * `Retry child` availability for one child, given the parent gate already
 * passed. Offered only for a `failure` or `cancelled` child.
 */
export function canRetryMatrixVariant(
  variant: MatrixVariantActionSummary | undefined,
): boolean {
  return (
    variant !== undefined &&
    RETRYABLE_MATRIX_VARIANT_STATUSES.has(variant.status)
  );
}

/**
 * `Cancel child` availability — deliberately the inverse of retry.
 *
 * Gated on the **child's status plus the execution being non-terminal**, never
 * on whether the execution is actively running. A paused execution has no
 * registered handle in the main process, yet its children are still
 * cancellable — and a paused execution is precisely when users reach for this.
 * A gate keyed to "running" would silently remove `Cancel child` from every
 * paused execution.
 */
export function canCancelMatrixVariant(
  executionStatus: string | undefined,
  variant: MatrixVariantActionSummary | undefined,
): boolean {
  if (executionStatus === undefined || variant === undefined) {
    return false;
  }
  if (isTerminalExecutionStatus(executionStatus)) {
    return false;
  }
  return CANCELLABLE_MATRIX_VARIANT_STATUSES.has(variant.status);
}

/**
 * Children eligible for a `Retry failed children` pass, in index order (the
 * order `children` already arrives in — never re-sorted).
 */
export function getRetryableMatrixVariantIds(
  group: MatrixJobActionSummary | undefined,
  variants: Readonly<Record<string, MatrixVariantActionSummary | undefined>>,
): string[] {
  return (group?.variant_job_ids ?? []).filter((id) =>
    canRetryMatrixVariant(variants[id]),
  );
}

export function canRetryFailedMatrixVariants(
  executionStatus: string | undefined,
  group: MatrixJobActionSummary | undefined,
  variants: Readonly<Record<string, MatrixVariantActionSummary | undefined>>,
): boolean {
  return (
    group?.expansion === 'expanded' &&
    canRetryMatrixJob(executionStatus, group) &&
    getRetryableMatrixVariantIds(group, variants).length > 0
  );
}

export function hasRerunReplayData(
  state: ExecutionRerunState | undefined,
): boolean {
  if (!state) {
    return false;
  }

  if (state.inputs_persisted === false) {
    return false;
  }

  if (state.event_name !== 'plan_ready') {
    if (state.event_name !== 'task_ready') {
      return true;
    }

    return Boolean(state.rerun_context?.event_data?.task_ready?.task_text);
  }

  return Boolean(state.rerun_context?.event_data?.plan_ready?.plan_text);
}

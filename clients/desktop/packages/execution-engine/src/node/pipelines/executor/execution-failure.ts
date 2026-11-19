import type {
  ExecutionErrnoCode,
  ExecutionFailureCode,
  ExecutionFailureOrigin,
} from '@canopy/execution-engine/types/pipeline';
import type { ExecutionRuntime, PipelineEngineErrorSite } from './types';

/*
 * Closed codes for errors the engine meets (CAN-7118). Only these values are
 * kept on a run or a step and sent to telemetry: never an error's message,
 * which can quote paths, tokens or user content. Imports types only, so the
 * spawned-process host can use it.
 */

/** The errno codes a closed failure code may carry; a run-state save's too. */
export const EXECUTION_ERRNO_CODES: readonly ExecutionErrnoCode[] = [
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EIO',
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EBUSY',
  'EAGAIN',
  'ETIMEDOUT',
];

const ERRNO_CODE_SET: ReadonlySet<string> = new Set(EXECUTION_ERRNO_CODES);

const ERROR_CLASS_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'AbortError',
]);

const FAILURE_CODE_SET: ReadonlySet<string> = new Set([
  ...EXECUTION_ERRNO_CODES,
  ...ERROR_CLASS_NAMES,
  'unknown',
]);

const FAILURE_ORIGIN_SET: ReadonlySet<string> = new Set<ExecutionFailureOrigin>(
  ['step', 'engine', 'host_port', 'spawn'],
);

export function isExecutionErrnoCode(
  value: unknown,
): value is ExecutionErrnoCode {
  return typeof value === 'string' && ERRNO_CODE_SET.has(value);
}

export function isExecutionFailureCode(
  value: unknown,
): value is ExecutionFailureCode {
  return typeof value === 'string' && FAILURE_CODE_SET.has(value);
}

export function isExecutionFailureOrigin(
  value: unknown,
): value is ExecutionFailureOrigin {
  return typeof value === 'string' && FAILURE_ORIGIN_SET.has(value);
}

/**
 * The closed code of a caught value: its allowlisted errno, else its
 * allowlisted class name, else `unknown`. Read by property, not
 * `instanceof`, so an error from another realm (Node's own spawn errors in
 * a VM context) keeps its code.
 */
export function executionFailureCode(error: unknown): ExecutionFailureCode {
  if (typeof error !== 'object' || error === null) return 'unknown';
  try {
    const code: unknown = Reflect.get(error, 'code');
    if (isExecutionErrnoCode(code)) return code;
    const name: unknown = Reflect.get(error, 'name');
    return typeof name === 'string' &&
      ERROR_CLASS_NAMES.has(name) &&
      isExecutionFailureCode(name)
      ? name
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Tells the run's host of an engine or host-port error, by its closed site
 * and code, and returns the code. Reporting never changes how the run goes.
 */
export function reportExecutionEngineError(
  runtime: Pick<ExecutionRuntime, 'reportEngineError'> | undefined,
  error: unknown,
  site: PipelineEngineErrorSite,
): ExecutionFailureCode {
  const code = executionFailureCode(error);
  try {
    runtime?.reportEngineError?.(error, { site, code });
  } catch {
    // A failing reporter must not fail the run or the step.
  }
  return code;
}

/** Errors a run-state save threw: the settle reports them (CAN-7118). */
const runStateSaveErrors = new WeakSet<object>();

/** Marks a thrown run-state save error, so no engine catch reports it again. */
export function markRunStateSaveError(error: unknown): void {
  if (typeof error === 'object' && error !== null)
    runStateSaveErrors.add(error);
}

export function isRunStateSaveError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && runStateSaveErrors.has(error)
  );
}

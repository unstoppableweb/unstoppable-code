import type {
  CanopyErrorKind,
  CanopyJsonValue,
  CanopyInstructionHandler,
  CanopyQueryHandler,
  CanopyRetryDirective,
  WORKER_CODE_GRAPH_READ_FAILURE_CODES,
  WorkerCodeGraphLanguagesValidateParams,
  WorkerCodeGraphLanguagesValidateResult,
  WorkerCodeGraphQueryParams,
  WorkerCodeGraphQueryResult,
  WorkerCodeGraphScope,
  WorkerCodeGraphSnapshotImportParams,
  WorkerCodeGraphStatusGetResult,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../runtime/errors';
import { KeyedOutcomes } from './worker-code-graph-builds';
import type { CanopyHandlerContext } from '../../runtime/types';

/*
 * The worker's code-graph reads (CAN-4150): status, queries (including a
 * repository's workspace base summary, CAN-5621), snapshot export and import,
 * and custom-language validation over one worker. The trusted host
 * resolves graphs to its own databases and read hosts and answers with closed
 * outcomes; this module turns each refusal into its typed operation error.
 */

/** A read host's refusal, as the read scheduler reports it. */
export type CodeGraphReadRefusal =
  | 'busy'
  | 'queue-timeout'
  | 'execution-timeout'
  | 'worker-exit'
  | 'canceled'
  | 'invalid-response'
  | 'database-error';

/** A request the worker refuses before any graph work starts. */
export type CodeGraphReadRequestRefusal =
  | 'invalid-argument'
  | 'not-found'
  | 'failed-precondition';

export type CodeGraphReadOutcome<Value> =
  | { ok: true; value: Value }
  | { ok: false; refusal: CodeGraphReadRefusal }
  | {
      ok: false;
      request: CodeGraphReadRequestRefusal;
      /** Fixed text naming what was wrong; never a path. */
      message: string;
    };

/** What a snapshot import wrote. */
export interface CodeGraphSnapshotImportCounts {
  filesImported: number;
  symbolsImported: number;
  edgesImported: number;
  warnings: string[];
}

/**
 * A query's answer before it crosses the boundary: the handler converts the
 * read host's value to JSON, as a transport would.
 */
export interface CodeGraphReadQueryAnswer extends Omit<
  WorkerCodeGraphQueryResult,
  'result'
> {
  result: {
    kind: WorkerCodeGraphQueryResult['result']['kind'];
    value: unknown;
  };
}

/** The trusted host side of the code-graph reads. */
export interface CodeGraphReadWorker {
  status(
    scope: WorkerCodeGraphScope,
  ): Promise<CodeGraphReadOutcome<WorkerCodeGraphStatusGetResult>>;
  query(
    params: WorkerCodeGraphQueryParams,
    signal: AbortSignal,
  ): Promise<CodeGraphReadOutcome<CodeGraphReadQueryAnswer>>;
  exportSnapshot(
    params: { scope: WorkerCodeGraphScope; repoId?: string },
    signal: AbortSignal,
  ): Promise<CodeGraphReadOutcome<{ snapshot: unknown }>>;
  importSnapshot(
    params: WorkerCodeGraphSnapshotImportParams,
    signal: AbortSignal,
  ): Promise<CodeGraphReadOutcome<CodeGraphSnapshotImportCounts>>;
  validateLanguages(
    params: WorkerCodeGraphLanguagesValidateParams,
    signal: AbortSignal,
  ): Promise<CodeGraphReadOutcome<WorkerCodeGraphLanguagesValidateResult>>;
}

type CodeGraphReadFailureCode =
  (typeof WORKER_CODE_GRAPH_READ_FAILURE_CODES)[number];

/** Each read host refusal and its operation code, kind and retry. */
export const CODE_GRAPH_READ_REFUSAL_ERRORS: Readonly<
  Record<
    CodeGraphReadRefusal,
    {
      code: CodeGraphReadFailureCode;
      kind: CanopyErrorKind;
      retry: CanopyRetryDirective;
    }
  >
> = {
  busy: {
    code: 'worker.codeGraph.read.busy',
    kind: 'resource_exhausted',
    retry: { kind: 'same_request' },
  },
  'queue-timeout': {
    code: 'worker.codeGraph.read.queueTimeout',
    kind: 'deadline_exceeded',
    retry: { kind: 'same_request' },
  },
  'execution-timeout': {
    code: 'worker.codeGraph.read.executionTimeout',
    kind: 'deadline_exceeded',
    retry: { kind: 'same_request' },
  },
  'worker-exit': {
    code: 'worker.codeGraph.read.hostExit',
    kind: 'unavailable',
    retry: { kind: 'same_request' },
  },
  canceled: {
    code: 'worker.codeGraph.read.canceled',
    kind: 'cancelled',
    retry: { kind: 'never' },
  },
  'invalid-response': {
    code: 'worker.codeGraph.read.invalidResponse',
    kind: 'internal',
    retry: { kind: 'never' },
  },
  'database-error': {
    code: 'worker.codeGraph.read.databaseError',
    kind: 'internal',
    retry: { kind: 'never' },
  },
};

const READ_REFUSALS: readonly CodeGraphReadRefusal[] = [
  'busy',
  'queue-timeout',
  'execution-timeout',
  'worker-exit',
  'canceled',
  'invalid-response',
  'database-error',
];

/** The read host refusal a code-graph operation error carries, if any. */
export function codeGraphReadRefusalOf(
  error: unknown,
): CodeGraphReadRefusal | null {
  if (!(error instanceof CanopyOperationError)) return null;
  const { code } = error.payload;
  return (
    READ_REFUSALS.find(
      (refusal) => CODE_GRAPH_READ_REFUSAL_ERRORS[refusal].code === code,
    ) ?? null
  );
}

const READ_FAILURE_MESSAGE =
  'The retained Code Graph could not be read. Try again.';

function refusalError(
  outcome: Exclude<CodeGraphReadOutcome<unknown>, { ok: true }>,
  writer: boolean,
): CanopyOperationError {
  if ('refusal' in outcome) {
    const mapped = CODE_GRAPH_READ_REFUSAL_ERRORS[outcome.refusal];
    return new CanopyOperationError({
      kind: mapped.kind,
      code: mapped.code,
      message: READ_FAILURE_MESSAGE,
      // A keyed import retries with its idempotency key, never as a new request.
      retry:
        writer && mapped.retry.kind === 'same_request'
          ? { kind: 'same_idempotency_key' }
          : mapped.retry,
    });
  }
  switch (outcome.request) {
    case 'invalid-argument':
      return new CanopyOperationError({
        kind: 'invalid_argument',
        code: 'worker.codeGraph.invalidScope',
        message: outcome.message,
        retry: { kind: 'never' },
      });
    case 'not-found':
      return new CanopyOperationError({
        kind: 'not_found',
        code: 'worker.codeGraph.notFound',
        message: outcome.message,
        retry: { kind: 'never' },
      });
    case 'failed-precondition':
      return new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'worker.codeGraph.invalidState',
        message: outcome.message,
        retry: { kind: 'after_refresh', resource: 'worker.codeGraph' },
      });
  }
}

function settle<Value>(
  outcome: CodeGraphReadOutcome<Value>,
  writer = false,
): Value {
  if (outcome.ok) return outcome.value;
  throw refusalError(outcome, writer);
}

export interface WorkerCodeGraphReadHandlers {
  queries: {
    'worker.codeGraph.status.get': CanopyQueryHandler<
      'worker.codeGraph.status.get',
      CanopyHandlerContext
    >;
    'worker.codeGraph.query': CanopyQueryHandler<
      'worker.codeGraph.query',
      CanopyHandlerContext
    >;
    'worker.codeGraph.snapshot.export': CanopyQueryHandler<
      'worker.codeGraph.snapshot.export',
      CanopyHandlerContext
    >;
    'worker.codeGraph.languages.validate': CanopyQueryHandler<
      'worker.codeGraph.languages.validate',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'worker.codeGraph.snapshot.import': CanopyInstructionHandler<
      'worker.codeGraph.snapshot.import',
      CanopyHandlerContext
    >;
  };
}

/** The code-graph reads over one worker (CAN-4150). */
export function createWorkerCodeGraphReadHandlers(
  worker: CodeGraphReadWorker,
): WorkerCodeGraphReadHandlers {
  const imports = new KeyedOutcomes<CodeGraphSnapshotImportCounts>();
  return {
    queries: {
      'worker.codeGraph.status.get': async ({ scope }) =>
        settle(await worker.status(scope)),
      'worker.codeGraph.query': async (params, context) => {
        const answer = settle(await worker.query(params, context.signal));
        return {
          presence: answer.presence,
          buildState: answer.buildState,
          result: {
            kind: answer.result.kind,
            value: toJsonValue(answer.result.value),
          },
        };
      },
      'worker.codeGraph.snapshot.export': async (params, context) => {
        const { snapshot } = settle(
          await worker.exportSnapshot(params, context.signal),
        );
        return { snapshot: toJsonValue(snapshot) };
      },
      'worker.codeGraph.languages.validate': async (params, context) =>
        settle(await worker.validateLanguages(params, context.signal)),
    },
    instructions: {
      'worker.codeGraph.snapshot.import': (params, context) =>
        imports.run(context, params, async () =>
          settle(await worker.importSnapshot(params, context.signal), true),
        ),
    },
  };
}

/**
 * Graph payloads cross the boundary as JSON, as they would over a transport:
 * what `JSON.stringify` keeps, with dates as ISO text and non-finite numbers
 * and unrepresentable array items as `null`.
 */
export function toJsonValue(value: unknown): CanopyJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value))
    return value.map((item: unknown) =>
      item === undefined ||
      typeof item === 'function' ||
      typeof item === 'symbol'
        ? null
        : toJsonValue(item),
    );
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const json: Record<string, CanopyJsonValue> = {};
    for (const [key, member] of Object.entries(value)) {
      if (
        member === undefined ||
        typeof member === 'function' ||
        typeof member === 'symbol'
      )
        continue;
      json[key] = toJsonValue(member);
    }
    return json;
  }
  return null;
}

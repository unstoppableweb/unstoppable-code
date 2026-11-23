import type {
  OfficeParseFailure,
  OfficeParseRequest,
  OfficeParseResponse,
  OfficeParseResult,
} from './office-parse';
import type { OfficePreviewRenderFailure } from './office-preview-copy';

export const OFFICE_PARSE_TIMEOUT_MS = 30_000;

export type OfficeParseFailureReason =
  | 'timeout'
  | 'worker-error'
  | 'parse-error'
  /** The parser threw a programming error, not a refusal of the file. */
  | 'worker-defect'
  | 'aborted';

/**
 * Classes the parsers throw when they refuse a file: a damaged, unsupported or
 * over-budget document, never a defect. Any other class is a defect.
 */
const FILE_REFUSAL_CLASSES: ReadonlySet<string> = new Set([
  'Error',
  'DocxElementBudgetError',
]);

export class OfficeParseError extends Error {
  constructor(
    readonly reason: OfficeParseFailureReason,
    message: string,
    /** A defect's class and code as the worker posted them, unvalidated. */
    readonly failure?: OfficeParseFailure,
  ) {
    super(message);
    this.name = 'OfficeParseError';
  }
}

/** The worker's failure as posted; anything malformed reads as no facts. */
function readParseFailure(value: unknown): OfficeParseFailure {
  if (typeof value !== 'object' || value === null) return {};
  const name: unknown = Reflect.get(value, 'name');
  const code: unknown = Reflect.get(value, 'code');
  return {
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

/**
 * How a preview reports a failed parse: a worker crash or parser defect is a
 * `worker-defect` its host records; a refused file, a timeout and anything
 * else keep the `parse-failed` outcome and are not recorded.
 */
export function officePreviewRenderFailure(
  error: unknown,
): OfficePreviewRenderFailure {
  return error instanceof OfficeParseError &&
    (error.reason === 'worker-defect' || error.reason === 'worker-error')
    ? 'worker-defect'
    : 'parse-failed';
}

export interface ParseOfficeDocumentOptions {
  readonly createWorker: () => Worker;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function parseOfficeDocument(
  request: OfficeParseRequest,
  options: ParseOfficeDocumentOptions,
): Promise<OfficeParseResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new OfficeParseError('aborted', 'Parse aborted.'));
  }
  let worker: Worker;
  try {
    worker = options.createWorker();
  } catch (error) {
    return Promise.reject(
      new OfficeParseError(
        'worker-error',
        error instanceof Error ? error.message : 'Worker creation failed.',
      ),
    );
  }
  return new Promise<OfficeParseResult>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void =>
      finish(() => reject(new OfficeParseError('aborted', 'Parse aborted.')));
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      outcome();
    };
    worker.onmessage = (event: MessageEvent<OfficeParseResponse>): void => {
      const response = event.data;
      if (
        !response ||
        typeof response.ok !== 'boolean' ||
        (response.ok &&
          (!response.result || response.result.kind !== request.kind))
      ) {
        finish(() =>
          reject(
            new OfficeParseError('worker-error', 'Unexpected worker result.'),
          ),
        );
      } else if (response.ok) {
        finish(() => resolve(response.result));
      } else {
        const failure = readParseFailure(response.error);
        finish(() =>
          reject(
            failure.name === undefined || FILE_REFUSAL_CLASSES.has(failure.name)
              ? new OfficeParseError('parse-error', 'Document refused.')
              : new OfficeParseError(
                  'worker-defect',
                  'Office parser failed.',
                  failure,
                ),
          ),
        );
      }
    };
    worker.onerror = (event: ErrorEvent): void =>
      finish(() =>
        reject(
          new OfficeParseError(
            'worker-error',
            event.message || 'Worker failed.',
          ),
        ),
      );
    worker.onmessageerror = (): void =>
      finish(() =>
        reject(new OfficeParseError('worker-error', 'Invalid worker message.')),
      );
    options.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new OfficeParseError(
              'timeout',
              `Parsing exceeded ${options.timeoutMs ?? OFFICE_PARSE_TIMEOUT_MS} ms.`,
            ),
          ),
        ),
      options.timeoutMs ?? OFFICE_PARSE_TIMEOUT_MS,
    );
    try {
      const bytes = request.bytes.slice(0);
      worker.postMessage({ kind: request.kind, bytes }, [bytes]);
    } catch (error) {
      finish(() =>
        reject(
          new OfficeParseError(
            'worker-error',
            error instanceof Error ? error.message : 'Worker transfer failed.',
          ),
        ),
      );
    }
  });
}

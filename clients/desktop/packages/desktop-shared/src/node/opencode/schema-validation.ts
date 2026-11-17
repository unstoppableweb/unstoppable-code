import { Worker } from 'node:worker_threads';
import type { McpSchemaInputClassification } from './schema-classification';

const MAX_BYTES = 1024 * 1024;
const MAX_NODES = 10_000;
const DEADLINE_MS = 2_000;
const MAX_PENDING = 32;

export type OpenCodeSchemaValidator = (
  schema: unknown,
  input: unknown,
  signal: AbortSignal,
) => Promise<boolean>;

/**
 * `unavailable`: cancelled, over its deadline or queue, input past the host
 * bound, or the worker failed. Callers must refuse.
 */
export type McpSchemaInputCheck = McpSchemaInputClassification | 'unavailable';

export type McpSchemaInputClassifier = (
  schema: unknown,
  input: unknown,
  signal: AbortSignal,
) => Promise<McpSchemaInputCheck>;

/** Bound the host's serialization work before transferring untrusted JSON. */
function boundedJson(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > 64 || bytes > MAX_BYTES)
      throw new Error('Schema validation input exceeds its limit.');
    if (typeof item === 'string') {
      if (item.length > MAX_BYTES) throw new Error('String exceeds its limit.');
      bytes += Buffer.byteLength(item);
      return;
    }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item))
      throw new Error('Expected JSON input.');
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error('Expected a JSON object.');
    if (
      (Array.isArray(item) && item.length > MAX_NODES) ||
      Object.prototype.hasOwnProperty.call(item, 'toJSON')
    )
      throw new Error('Expected bounded JSON data.');
    ancestors.add(item);
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !('value' in property))
        throw new Error('Expected JSON data.');
      bytes += Buffer.byteLength(key);
      visit(property.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  if (bytes > MAX_BYTES || Buffer.byteLength(text) > MAX_BYTES)
    throw new Error('Schema validation input exceeds its limit.');
  return text;
}

/** One owned worker at a time; the host supplies a bundled, trusted entry path. */
export function createOpenCodeSchemaValidator(
  workerPath: string,
  execution: { eval?: boolean; execArgv?: string[] } = {},
): OpenCodeSchemaValidator {
  const classify = createMcpSchemaInputClassifier(workerPath, {}, execution);
  return async (schema, input, signal) =>
    (await classify(schema, input, signal)) === 'valid';
}

/**
 * Same bounded worker, reporting why an input did not validate so a caller can
 * tell an unenforceable schema from an invalid input. Each instance owns its
 * own queue.
 */
export function createMcpSchemaInputClassifier(
  workerPath: string,
  options: {
    /** Read PCRE-style identity escapes (`\_`, `\@`) as their literal character. */
    readonly lenientPatterns?: boolean;
  } = {},
  execution: { eval?: boolean; execArgv?: string[] } = {},
): McpSchemaInputClassifier {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return async (schema, input, signal) => {
    if (signal.aborted || pending >= MAX_PENDING) return 'unavailable';
    let boundedSchema: string;
    let boundedInput: string;
    try {
      boundedSchema = boundedJson(schema);
    } catch {
      // A schema past the host bound cannot be enforced here.
      return 'unsupported';
    }
    try {
      boundedInput = boundedJson(input);
    } catch {
      // Input past the bound is refused rather than left unchecked.
      return 'unavailable';
    }
    const payload = {
      schema: boundedSchema,
      input: boundedInput,
      ...(options.lenientPatterns ? { lenientPatterns: true } : {}),
    };
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    pending++;
    let started = false;
    const scheduled = tail.then(async (): Promise<McpSchemaInputCheck> => {
      try {
        if (deadline.aborted) return 'unavailable';
        started = true;
        return await validateInWorker(workerPath, payload, deadline, execution);
      } finally {
        pending--;
      }
    });
    tail = scheduled.catch(() => 'unavailable');
    let cancel = (): void => {};
    const stopped = new Promise<'unavailable'>((resolve) => {
      cancel = (): void => resolve('unavailable');
      deadline.addEventListener('abort', cancel, { once: true });
      if (deadline.aborted) cancel();
    });
    try {
      const result = await Promise.race([scheduled, stopped]);
      // A running worker must exit before its slot or request is released.
      if (started) await scheduled;
      return deadline.aborted ? 'unavailable' : result;
    } catch {
      return 'unavailable';
    } finally {
      deadline.removeEventListener('abort', cancel);
    }
  };
}

function isClassification(
  value: unknown,
): value is McpSchemaInputClassification {
  return (
    value === 'valid' ||
    value === 'invalid' ||
    value === 'unsupported' ||
    value === 'error'
  );
}

async function validateInWorker(
  entry: string,
  payload: { schema: string; input: string; lenientPatterns?: boolean },
  signal: AbortSignal,
  execution: { eval?: boolean; execArgv?: string[] },
): Promise<McpSchemaInputCheck> {
  const worker = new Worker(entry, {
    workerData: payload,
    execArgv: execution.execArgv ?? [],
    eval: execution.eval ?? false,
    resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
  });
  let cancel = (): void => {};
  try {
    return await new Promise<McpSchemaInputCheck>((resolve) => {
      cancel = (): void => resolve('unavailable');
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      worker.once('message', (message: unknown) =>
        resolve(isClassification(message) ? message : 'unavailable'),
      );
      worker.once('error', () => resolve('unavailable'));
      worker.once('exit', () => resolve('unavailable'));
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    await worker.terminate();
  }
}

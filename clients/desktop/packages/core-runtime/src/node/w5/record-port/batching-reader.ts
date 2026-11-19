import {
  W5_CAPTURE_LIMITS,
  type W5CaptureFile,
  type W5CaptureResult,
  type W5CaptureRequest,
} from '../commit-log/capture-contract';
import { W5CommitRefusedError } from '../commit-log/errors';
import {
  W5RecordOverloadedError,
  W5RecordUnservedError,
  type W5FileRead,
  type W5RecordUnservedReason,
} from '../file-store';
import {
  w5RecordPathFor,
  w5RecordTargetFor,
  w5UnnameableRecordFor,
} from './contract';

export const W5_RECORD_READ_CONCURRENCY = 4;
const OVERLOAD_RETRIES = 2;

export function isW5CaptureLimitRefusal(error: unknown): boolean {
  return (
    error instanceof W5CommitRefusedError &&
    error.reason === 'invalid-state' &&
    error.details.capture === 'limit-exceeded'
  );
}

/** Retry only explicit, safe same-request overloads; no authority-loss retry. */
export async function retryW5RecordCapture(
  capture: () => Promise<W5CaptureResult>,
): Promise<W5CaptureResult> {
  for (let retries = 0; ; retries += 1) {
    try {
      return await capture();
    } catch (error) {
      if (
        !(error instanceof W5RecordOverloadedError) ||
        error.kind !== 'resource_exhausted' ||
        error.retry.kind !== 'same_request' ||
        retries >= OVERLOAD_RETRIES
      )
        throw error;
      const delayMs = error.retry.delayMs ?? 0;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

interface PendingRead {
  readonly target: W5CaptureFile;
  readonly resolve: (result: W5CaptureResult) => void;
  readonly reject: (error: unknown) => void;
}

export interface W5RecordBatchingReader {
  readFile(path: string, forCommit?: boolean): Promise<W5FileRead>;
  captureForPreparation?(request: W5CaptureRequest): Promise<W5CaptureResult>;
  captureFile(
    target: W5CaptureFile,
    forCommit?: boolean,
  ): Promise<W5CaptureResult>;
}

/** Per-store fresh captures. Only requests not yet sent may share an image. */
export function createW5RecordBatchingReader(options: {
  readonly root: string;
  readonly capture: (
    files: readonly W5CaptureFile[],
  ) => Promise<W5CaptureResult>;
  readonly capturePreparation?: (
    request: W5CaptureRequest,
  ) => Promise<W5CaptureResult>;
  readonly onUnserved?: (reason: W5RecordUnservedReason) => void;
  /** Bytes each served record read decoded from its captured image. */
  readonly onRecordDecoded?: (bytes: number) => void;
}): W5RecordBatchingReader {
  interface Cohort {
    kind: 'ordinary';
    pending: Map<string, PendingRead[]>;
    splits: PendingRead[][][];
    active: number;
  }
  type Preparation = {
    kind: 'preparation';
    request: W5CaptureRequest;
    resolve: (result: W5CaptureResult) => void;
    reject: (error: unknown) => void;
  };
  const cohort = (): Cohort => ({
    kind: 'ordinary',
    pending: new Map(),
    splits: [],
    active: 0,
  });
  let pending = cohort();
  const queue: (Cohort | Preparation)[] = [pending];
  let active = 0;
  let scheduled = false;

  function requestFlush(): void {
    if (scheduled || active >= W5_RECORD_READ_CONCURRENCY) return;
    scheduled = true;
    setImmediate((): void => {
      scheduled = false;
      drain();
    });
  }

  async function send(unit: Cohort, batch: PendingRead[][]): Promise<void> {
    active += 1;
    unit.active += 1;
    try {
      const targets = batch.flatMap((reads) =>
        reads[0] ? [reads[0].target] : [],
      );
      const result = await options.capture(targets);
      for (const reads of batch) for (const read of reads) read.resolve(result);
    } catch (error) {
      if (isW5CaptureLimitRefusal(error) && batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        unit.splits.push(batch.slice(0, middle), batch.slice(middle));
      } else {
        for (const reads of batch) for (const read of reads) read.reject(error);
      }
    } finally {
      active -= 1;
      unit.active -= 1;
      // Preserve writer continuation headroom and ordinary setImmediate flushing.
      requestFlush();
    }
  }

  async function sendPreparation(unit: Preparation): Promise<void> {
    active += 1;
    let result: W5CaptureResult;
    try {
      const capture = options.capturePreparation;
      if (!capture) throw new Error('Preparation capture is unavailable');
      result = await capture(unit.request);
    } catch (error) {
      unit.reject(error);
      return;
    } finally {
      active -= 1;
      requestFlush();
    }
    unit.resolve(result);
  }

  function drain(): void {
    while (active < W5_RECORD_READ_CONCURRENCY) {
      const unit = queue[0];
      if (!unit) return;
      if (unit.kind === 'preparation') {
        queue.shift();
        void sendPreparation(unit);
        continue;
      }
      let batch = unit.splits.shift();
      if (!batch && unit.pending.size) {
        batch = [];
        for (const [key, reads] of unit.pending) {
          unit.pending.delete(key);
          batch.push(reads);
          if (batch.length === W5_CAPTURE_LIMITS.files) break;
        }
      }
      if (batch) {
        void send(unit, batch);
        continue;
      }
      // A sealed cohort keeps its position until all possible split descendants settle.
      if (unit === pending || unit.active) return;
      queue.shift();
    }
  }

  function captureFile(
    target: W5CaptureFile,
    forCommit = false,
  ): Promise<W5CaptureResult> {
    if (forCommit) return options.capture([target]);
    return new Promise((resolve, reject) => {
      const key = w5RecordPathFor(options.root, target);
      const reads = pending.pending.get(key) ?? [];
      reads.push({ target, resolve, reject });
      pending.pending.set(key, reads);
      requestFlush();
    });
  }

  function captureForPreparation(
    request: W5CaptureRequest,
  ): Promise<W5CaptureResult> {
    return new Promise((resolve, reject) => {
      queue.push({ kind: 'preparation', request, resolve, reject });
      pending = cohort();
      queue.push(pending);
      requestFlush();
    });
  }

  async function readFile(
    path: string,
    forCommit = false,
  ): Promise<W5FileRead> {
    const target = w5RecordTargetFor(options.root, path);
    if (!target) {
      const unnameable = w5UnnameableRecordFor(options.root, path);
      if (unnameable) {
        options.onUnserved?.('unsupported-id');
        return {
          state: 'unreadable',
          error: new W5RecordUnservedError('unsupported-id', unnameable.kind),
        };
      }
      return {
        state: 'unreadable',
        error: new Error(
          'This file is not a W5 record under the trusted root.',
        ),
      };
    }
    try {
      const result = await captureFile(target, forCommit);
      const key = w5RecordPathFor(options.root, target);
      const image = result.files.find(
        (file) => w5RecordPathFor(options.root, file) === key,
      );
      if (image?.state === 'present') {
        const bytes = Buffer.from(image.base64, 'base64');
        try {
          options.onRecordDecoded?.(bytes.byteLength);
        } catch {
          // Counting must never change the read.
        }
        return { state: 'present', raw: bytes.toString('utf8') };
      }
      if (image?.state === 'absent') return { state: 'absent' };
      return { state: 'unreadable' };
    } catch (error) {
      if (isW5CaptureLimitRefusal(error)) {
        options.onUnserved?.('limit-exceeded');
        return {
          state: 'unreadable',
          error: new W5RecordUnservedError(
            'limit-exceeded',
            target.kind,
            error,
          ),
        };
      }
      return {
        state: 'unreadable',
        ...(error instanceof Error ? { error } : {}),
      };
    }
  }
  return {
    readFile,
    captureFile,
    ...(options.capturePreparation ? { captureForPreparation } : {}),
  };
}

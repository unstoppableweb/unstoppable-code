import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  PipelineDefinitionReplayEntry,
  PipelineDefinitionReplayLedger,
  PipelineDefinitionReplayReceipt,
  PipelineDefinitionReplayStore,
  PipelineDefinitionWriteOperation,
} from './core-pipeline-definitions';

/** The replay receipts file under a data root. */
export function pipelineDefinitionReplaysPath(dataRoot: string): string {
  return join(dataRoot, 'pipeline-definition-replays.json');
}

/** Installs `contents` at `file` atomically and durably. */
export type PipelineDefinitionReplayFileWriter = (
  file: string,
  contents: string,
) => Promise<void>;

const RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200, 250] as const;
const RETRIED_RENAME_CODES: readonly string[] = ['EPERM', 'EACCES', 'EBUSY'];

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object'
    ? Reflect.get(error, 'code')
    : undefined;
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const wait = RENAME_RETRY_DELAYS_MS[attempt];
      if (
        wait === undefined ||
        !RETRIED_RENAME_CODES.includes(String(errorCode(error)))
      )
        throw error;
      await delay(wait);
    }
  }
}

/**
 * A portable atomic durable write: a synced sibling file renamed over the
 * target, then its folder flushed through the host's platform flush.
 */
export function createDurableReplayFileWriter(
  flushDirectory: (directoryPath: string) => Promise<unknown>,
): PipelineDefinitionReplayFileWriter {
  return async (file, contents) => {
    const tempPath = join(
      dirname(file),
      `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let installed = false;
    try {
      const handle = await open(tempPath, 'wx');
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(tempPath, file);
      installed = true;
    } finally {
      if (!installed) await unlink(tempPath).catch(() => undefined);
    }
    await flushDirectory(dirname(file));
  };
}

const DIGEST = /^[a-f0-9]{64}$/;

class UnreadableLedger extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new UnreadableLedger();
  return Object.fromEntries(Object.entries(value));
}

function operationOf(value: unknown): PipelineDefinitionWriteOperation {
  switch (value) {
    case 'core.pipeline.definition.upsert':
    case 'core.pipeline.definition.delete':
    case 'core.pipeline.definition.duplicate':
    case 'core.pipeline.definition.setEnabled':
    case 'core.pipeline.definition.import':
      return value;
    default:
      throw new UnreadableLedger();
  }
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value))
    throw new UnreadableLedger();
  return value;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512)
    throw new UnreadableLedger();
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new UnreadableLedger();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new UnreadableLedger();
  return value;
}

function optional<T>(
  value: unknown,
  parse: (value: unknown) => T,
): T | undefined {
  return value === undefined ? undefined : parse(value);
}

function receiptOf(value: unknown): PipelineDefinitionReplayReceipt {
  const receipt = record(value);
  switch (receipt.kind) {
    case 'definition': {
      const enabled = optional(receipt.enabled, boolean);
      const sourceDefinitionId = optional(receipt.sourceDefinitionId, id);
      const remoteVersion = optional(receipt.remoteVersion, (version) => {
        if (typeof version !== 'string' || version.length > 256)
          throw new UnreadableLedger();
        return version;
      });
      return {
        kind: 'definition',
        definitionId: id(receipt.definitionId),
        revision: revision(receipt.revision),
        ...(enabled === undefined ? {} : { enabled }),
        ...(sourceDefinitionId === undefined ? {} : { sourceDefinitionId }),
        ...(remoteVersion === undefined ? {} : { remoteVersion }),
      };
    }
    case 'enablement':
      return {
        kind: 'enablement',
        definitionId: id(receipt.definitionId),
        revision: revision(receipt.revision),
        enabled: boolean(receipt.enabled),
      };
    case 'result':
      return { kind: 'result', result: record(receipt.result) };
    default:
      throw new UnreadableLedger();
  }
}

function entriesOf(value: unknown): PipelineDefinitionReplayEntry[] {
  if (!Array.isArray(value)) throw new UnreadableLedger();
  return value.map((item: unknown) => {
    const entry = record(item);
    return {
      operation: operationOf(entry.operation),
      key: digest(entry.key),
      fingerprint: digest(entry.fingerprint),
      receipt: receiptOf(entry.receipt),
    };
  });
}

function expiredOf(value: unknown): PipelineDefinitionReplayLedger['expired'] {
  if (!Array.isArray(value)) throw new UnreadableLedger();
  return value.map((item: unknown) => {
    const entry = record(item);
    return { operation: operationOf(entry.operation), key: digest(entry.key) };
  });
}

/** Version 1 of the receipts file; anything else is unreadable. */
function parseLedger(text: string): PipelineDefinitionReplayLedger {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UnreadableLedger();
  }
  const ledger = record(value);
  if (ledger.version !== 1) throw new UnreadableLedger();
  return {
    entries: entriesOf(ledger.entries),
    expired: expiredOf(ledger.expired),
  };
}

export interface PipelineDefinitionReplayStoreOptions {
  /** The receipts file, read at each load and save. */
  readonly filePath: () => string;
  /** The host's atomic durable write. */
  readonly write: PipelineDefinitionReplayFileWriter;
}

/**
 * The definition write receipts a host keeps so an idempotency key replays
 * after a restart (CAN-5368). A missing file is an empty ledger. One that
 * does not parse as version 1 is kept beside it as `.unreadable` and the
 * ledger starts empty, so saving never stops working; only keys sent before
 * then lose their replay. A read that fails for another reason, such as
 * EACCES, EISDIR or EMFILE, rejects the load and leaves the file in place.
 * It takes no lock: only one host may write the file at a time.
 */
export function createPipelineDefinitionReplayStore(
  options: PipelineDefinitionReplayStoreOptions,
): PipelineDefinitionReplayStore {
  return {
    load: (): Promise<PipelineDefinitionReplayLedger> => {
      try {
        const file = options.filePath();
        if (!existsSync(file))
          return Promise.resolve({ entries: [], expired: [] });
        try {
          return Promise.resolve(parseLedger(readFileSync(file, 'utf8')));
        } catch (error) {
          if (!(error instanceof UnreadableLedger)) throw error;
          renameSync(file, `${file}.unreadable`);
          return Promise.resolve({ entries: [], expired: [] });
        }
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    save: async (ledger): Promise<void> => {
      const file = options.filePath();
      const directory = dirname(file);
      try {
        mkdirSync(directory, { recursive: true });
      } catch (error) {
        // Logged as the desktop's ensureDir did; the write then fails.
        // eslint-disable-next-line no-console
        console.error(
          `[pipelines] Failed to create directory ${directory}:`,
          error,
        );
      }
      await options.write(
        file,
        `${JSON.stringify({ version: 1, ...ledger })}\n`,
      );
    },
  };
}

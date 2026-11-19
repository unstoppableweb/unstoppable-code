import { copyFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  isDismissibleInvocationToken,
  PIPELINE_PACKAGE_MAX_INVOCATION_DISMISSALS,
} from '@canopy/protocol/pipelines';
import {
  damagedCopyPath,
  pruneDamagedCopies,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import { writeStoreFileDurably } from '../lib/durable-store-write';
import { logMainProcessWarn } from '../lib/main-process-logging';

export interface PipelinePackageDismissalRecord {
  scopeKey: string;
  provider: 'claude' | 'codex';
  token: string;
  dismissedAt: string;
}

/**
 * `damaged`: not JSON or not the v1 envelope; the next replacement copies it
 * aside first. `newer` (a later version) and `unreadable` (the read itself
 * failed) read as no dismissals and are never written over.
 */
type DismissalStoreStatus =
  | 'ok'
  | 'missing'
  | 'damaged'
  | 'newer'
  | 'unreadable';

interface DismissalStoreRead {
  status: DismissalStoreStatus;
  records: PipelinePackageDismissalRecord[];
  /** Rows this build cannot read, carried verbatim through replacements. */
  unknown: unknown[];
}

const mutationQueues = new Map<string, Promise<void>>();
const refusalsWarned = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDismissalRecord(
  value: unknown,
): value is PipelinePackageDismissalRecord {
  return (
    isRecord(value) &&
    typeof value.scopeKey === 'string' &&
    value.scopeKey.length > 0 &&
    (value.provider === 'claude' || value.provider === 'codex') &&
    typeof value.token === 'string' &&
    value.token.length <= 128 &&
    /^[/$][A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*$/.test(value.token) &&
    typeof value.dismissedAt === 'string' &&
    !Number.isNaN(Date.parse(value.dismissedAt))
  );
}

async function readStore(storePath: string): Promise<DismissalStoreRead> {
  let raw: string;
  try {
    raw = await readFile(storePath, 'utf8');
  } catch (error) {
    const missing =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT';
    return {
      status: missing ? 'missing' : 'unreadable',
      records: [],
      unknown: [],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'damaged', records: [], unknown: [] };
  }
  if (
    isRecord(value) &&
    typeof value.version === 'number' &&
    value.version > 1
  ) {
    return { status: 'newer', records: [], unknown: [] };
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records))
    return { status: 'damaged', records: [], unknown: [] };
  const records: PipelinePackageDismissalRecord[] = [];
  const unknown: unknown[] = [];
  for (const record of value.records) {
    if (isDismissalRecord(record)) records.push(record);
    else unknown.push(record);
  }
  return { status: 'ok', records, unknown };
}

function warnRefusedOnce(
  storePath: string,
  status: DismissalStoreStatus,
): void {
  if (refusalsWarned.has(storePath)) return;
  refusalsWarned.add(storePath);
  logMainProcessWarn(
    `[pipelines] Package dismissals are not saved: the store is ${
      status === 'newer' ? 'from a newer version' : 'unreadable'
    }`,
  );
}

async function writeStore(
  storePath: string,
  current: DismissalStoreRead,
  records: PipelinePackageDismissalRecord[],
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  // Copied, not moved: if the replacement fails, the damaged file stays put.
  if (current.status === 'damaged') {
    await copyFile(storePath, damagedCopyPath(storePath));
    await pruneDamagedCopies(storePath);
  }
  await writeStoreFileDurably(
    storePath,
    `${JSON.stringify({ version: 1, records: [...records, ...current.unknown] }, null, 2)}\n`,
    { encoding: 'utf8' },
  );
}

async function mutateStore<T>(
  storePath: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = mutationQueues.get(storePath) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(mutation);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(storePath, settled);
  try {
    return await operation;
  } finally {
    if (mutationQueues.get(storePath) === settled)
      mutationQueues.delete(storePath);
  }
}

export async function listPipelinePackageDismissals(
  storePath: string,
  scopeKey: string,
): Promise<PipelinePackageDismissalRecord[]> {
  return (await readStore(storePath)).records.filter(
    (record) => record.scopeKey === scopeKey,
  );
}

export async function replacePipelinePackageDismissals(
  storePath: string,
  scopeKey: string,
  dismissals: Array<{ provider: 'claude' | 'codex'; token: string }>,
): Promise<'replaced' | 'refused'> {
  if (!scopeKey) throw new Error('Invalid pipeline package dismissal scope');
  const unique = new Map(
    dismissals.map((dismissal) => [
      `${dismissal.provider}\0${dismissal.token}`,
      dismissal,
    ]),
  );
  if (unique.size > PIPELINE_PACKAGE_MAX_INVOCATION_DISMISSALS) {
    throw new Error('Too many pipeline package dismissal records');
  }
  if (
    Array.from(unique.values()).some(
      ({ provider, token }) =>
        (provider !== 'claude' && provider !== 'codex') ||
        !isDismissibleInvocationToken(token),
    )
  ) {
    throw new Error('Invalid pipeline package dismissal record');
  }
  return mutateStore(storePath, async () => {
    const store = await readStore(storePath);
    if (store.status === 'newer' || store.status === 'unreadable') {
      warnRefusedOnce(storePath, store.status);
      return 'refused';
    }
    const existing = new Map(
      store.records
        .filter((record) => record.scopeKey === scopeKey)
        .map((record) => [`${record.provider}\0${record.token}`, record]),
    );
    const dismissedAt = new Date().toISOString();
    const scopedRecords = Array.from(unique.entries()).map(
      ([key, dismissal]): PipelinePackageDismissalRecord =>
        existing.get(key) ?? { scopeKey, ...dismissal, dismissedAt },
    );
    await writeStore(storePath, store, [
      ...store.records.filter((record) => record.scopeKey !== scopeKey),
      ...scopedRecords,
    ]);
    return 'replaced';
  });
}

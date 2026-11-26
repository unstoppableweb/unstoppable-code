import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pruneDamagedCopies } from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  createDirectoryDurably,
  writeFileAtomically,
  type AdmittedWriterTarget,
} from './atomic-file';
import {
  COWORK_MIGRATION_MAP_DAMAGED_PREFIX,
  createCoworkMigrationMapDamagedPath,
  createCoworkMigrationMapLastGoodPath,
  isCoworkMigrationMapDamagedFileName,
} from './cowork-migration-map-file-paths';
import { logMainProcessWarn } from './main-process-logging';
import { getCoworkMigrationMapFilePath } from './paths';
import { reportStartupStepFailure } from './startup-step';
import { isErrnoException, isRecord } from './type-guards';

export interface CoworkMigrationMapFile {
  version: 1;
  idMap: Record<string, string>;
}

const MAP_VERSION = 1;

const MAP_WRITER: AdmittedWriterTarget = {
  namespace: 'cowork_migration_map',
  writer: 'electron_main',
  module: 'main/lib/cowork-migration-map',
};

/**
 * In-memory cache of the persisted id-map so
 * {@link getCoworkWorkspaceIdForLegacyChatProject} can offer a synchronous
 * lookup (mirrors the `workspace-registry.ts` pattern: an async writer
 * populates a module-level cache that a sync accessor reads). The cache is
 * primed by {@link loadCoworkMigrationMapCache} and kept current by
 * {@link writeCoworkMigrationMap}.
 */
let cachedIdMap: Record<string, string> = {};

function normalizeIdMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const idMap: Record<string, string> = {};
  for (const [legacyId, workspaceId] of Object.entries(value)) {
    if (typeof workspaceId === 'string') {
      idMap[legacyId] = workspaceId;
    }
  }
  return idMap;
}

type MapFile =
  | { kind: 'missing' }
  | { kind: 'ready'; idMap: Record<string, string>; bytes: Buffer }
  | { kind: 'damaged'; bytes: Buffer }
  | { kind: 'newer'; bytes: Buffer };

type ReadyMapFile = Extract<MapFile, { kind: 'ready' }>;

function parseMap(bytes: Buffer): MapFile {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { kind: 'damaged', bytes };
  }
  if (!isRecord(value)) return { kind: 'damaged', bytes };
  if (value.version !== MAP_VERSION) {
    const newer =
      typeof value.version === 'number' &&
      Number.isInteger(value.version) &&
      value.version > MAP_VERSION;
    return newer ? { kind: 'newer', bytes } : { kind: 'damaged', bytes };
  }
  if (!isRecord(value.idMap)) return { kind: 'damaged', bytes };
  // Non-string values are dropped, as before; the file still reads as ready.
  return { kind: 'ready', idMap: normalizeIdMap(value.idMap), bytes };
}

async function readMapFile(filePath: string): Promise<MapFile> {
  try {
    return parseMap(await readFile(filePath));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }
}

function writeMapFile(filePath: string, content: Buffer): Promise<void> {
  return writeFileAtomically(filePath, content, {
    durable: true,
    admittedWriter: MAP_WRITER,
  });
}

// Every load and write runs in turn, so a refresh never lands over a newer
// write from this process. Electron's single-instance lock keeps other
// desktop processes out.
let mapQueue: Promise<void> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = mapQueue.then(task);
  mapQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Last-good content this process has confirmed, per map path. */
const confirmedLastGood = new Map<string, Buffer>();

// Recovery never blocks startup or the migration: a failed evidence copy,
// last-good read, install or refresh is logged and reported, and the load
// serves what it would have served without that step.
function bestEffortFailed(action: string, error: unknown): void {
  logMainProcessWarn(`[cowork-migration-map] Failed to ${action}`, {
    error: error instanceof Error ? error.message : String(error),
  });
  reportStartupStepFailure('migration.cowork_map_recovery', error);
}

async function readLastGood(
  filePath: string,
): Promise<ReadyMapFile | undefined> {
  try {
    const lastGood = await readMapFile(
      createCoworkMigrationMapLastGoodPath(filePath),
    );
    return lastGood.kind === 'ready' ? lastGood : undefined;
  } catch (error) {
    bestEffortFailed('read the last-good copy', error);
    return undefined;
  }
}

async function refreshLastGood(filePath: string, bytes: Buffer): Promise<void> {
  if (confirmedLastGood.get(filePath)?.equals(bytes)) return;
  try {
    const lastGoodPath = createCoworkMigrationMapLastGoodPath(filePath);
    const lastGood = await readMapFile(lastGoodPath).catch(
      (): MapFile => ({ kind: 'missing' }),
    );
    if (lastGood.kind !== 'ready' || !lastGood.bytes.equals(bytes)) {
      await writeMapFile(lastGoodPath, bytes);
    }
    confirmedLastGood.set(filePath, bytes);
  } catch (error) {
    bestEffortFailed('refresh the last-good copy', error);
  }
}

/** Keeps `bytes` once as a damaged copy, with at most the newest five. */
async function keepDamagedCopy(filePath: string, bytes: Buffer): Promise<void> {
  try {
    const folder = dirname(filePath);
    for (const name of await readdir(folder)) {
      if (!isCoworkMigrationMapDamagedFileName(name)) continue;
      const existing = await readFile(join(folder, name)).catch(() => null);
      if (existing?.equals(bytes)) return;
    }
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    await writeFileAtomically(
      createCoworkMigrationMapDamagedPath(filePath, stamp),
      bytes,
      { durable: true, overwrite: false, admittedWriter: MAP_WRITER },
    );
    await pruneDamagedCopies({
      directory: folder,
      prefix: COWORK_MIGRATION_MAP_DAMAGED_PREFIX,
      suffix: '.json',
      uniqueTail: true,
    });
  } catch (error) {
    bestEffortFailed('keep a copy of the unreadable id-map', error);
  }
}

async function installLastGood(filePath: string, bytes: Buffer): Promise<void> {
  try {
    await writeMapFile(filePath, bytes);
    confirmedLastGood.set(filePath, bytes);
  } catch (error) {
    bestEffortFailed('restore the id-map from its last-good copy', error);
  }
}

/**
 * The id-map to serve. Leaks, never blocks: a missing or unreadable map with
 * no last-good copy reads as empty, as it always has, so untranslated legacy
 * ids fall back to themselves. An unreadable map's bytes are kept aside
 * first, so a pending migration that then rewrites the map keeps the
 * evidence.
 */
async function loadMap(): Promise<Record<string, string>> {
  const filePath = getCoworkMigrationMapFilePath();
  let primary: MapFile;
  try {
    primary = await readMapFile(filePath);
  } catch (error) {
    // Unreadable for a reason other than absence, which always threw.
    const lastGood = await readLastGood(filePath);
    if (!lastGood) throw error;
    logMainProcessWarn(
      '[cowork-migration-map] Serving the last-good id-map; the map is unreadable',
    );
    return lastGood.idMap;
  }
  if (primary.kind === 'ready') {
    await refreshLastGood(filePath, primary.bytes);
    return primary.idMap;
  }
  if (primary.kind !== 'missing') {
    reportStartupStepFailure(
      'migration.cowork_map_recovery',
      new Error(`The cowork migration map is ${primary.kind}`),
    );
    await keepDamagedCopy(filePath, primary.bytes);
  }
  const lastGood = await readLastGood(filePath);
  if (!lastGood) return {};
  // A newer map is never written over by a restore; serve last-good in memory.
  if (primary.kind !== 'newer') await installLastGood(filePath, lastGood.bytes);
  logMainProcessWarn(
    '[cowork-migration-map] Serving the id-map from its last-good copy',
    { primary: primary.kind },
  );
  return lastGood.idMap;
}

export async function readCoworkMigrationMap(): Promise<CoworkMigrationMapFile> {
  return serialized(
    async (): Promise<CoworkMigrationMapFile> => ({
      version: MAP_VERSION,
      idMap: await loadMap(),
    }),
  );
}

/**
 * Writes the id-map durably and atomically: last-good first, so it never
 * lacks an entry the map has, then the map. Only a failed folder or map
 * write rejects, as before; a failed last-good write is logged and reported.
 */
export async function writeCoworkMigrationMap(
  idMap: Record<string, string>,
): Promise<void> {
  const filePath = getCoworkMigrationMapFilePath();
  const normalized = normalizeIdMap(idMap);
  const content = Buffer.from(
    `${JSON.stringify({ version: MAP_VERSION, idMap: normalized }, null, 2)}\n`,
    'utf8',
  );
  await serialized(async (): Promise<void> => {
    const folder = dirname(filePath);
    await createDirectoryDurably(folder, { dataRoot: folder });
    try {
      await writeMapFile(
        createCoworkMigrationMapLastGoodPath(filePath),
        content,
      );
      confirmedLastGood.set(filePath, content);
    } catch (error) {
      confirmedLastGood.delete(filePath);
      bestEffortFailed('write the last-good copy', error);
    }
    await writeMapFile(filePath, content);
  });
  cachedIdMap = normalized;
}

/**
 * Loads the persisted id-map from disk into the in-memory cache. Safe to call
 * on every startup regardless of whether the migration itself has already
 * run, so translation lookups keep working across app restarts.
 */
export async function loadCoworkMigrationMapCache(): Promise<void> {
  const { idMap } = await readCoworkMigrationMap();
  cachedIdMap = idMap;
}

/**
 * Synchronous lookup of the cowork workspace id that a legacy standalone-chat
 * project id was migrated to. Returns `null` when the cache has not been
 * primed yet or the legacy id has no recorded mapping (e.g. it was never a
 * real chat project). Intended to back a future read-time translation shim
 * for persisted `linkTarget`s and other old-id references.
 */
export function getCoworkWorkspaceIdForLegacyChatProject(
  legacyId: string,
): string | null {
  return cachedIdMap[legacyId] ?? null;
}

/**
 * Resolves a legacy standalone-chat project id (or an already-current cowork
 * workspace id) to the cowork workspace id that main-process persistence
 * helpers should address. Falls back to the input id unchanged when there is
 * no recorded legacy mapping, so this is correct both before Plan 5 (renderer
 * still sends legacy chat-project ids) and after Plan 5 (renderer sends real
 * workspace ids directly, making the lookup a no-op).
 */
export function resolveCoworkWorkspaceId(legacyOrWorkspaceId: string): string {
  return (
    getCoworkWorkspaceIdForLegacyChatProject(legacyOrWorkspaceId) ??
    legacyOrWorkspaceId
  );
}

/** @internal - exposed for testing only */
export const coworkMigrationMapTestExports: {
  resetCache: () => void;
} = {
  resetCache: (): void => {
    cachedIdMap = {};
  },
};

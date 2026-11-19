import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, renameSync, rmSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
} from './types/code-graph';
import {
  CODE_GRAPH_BUSY_TIMEOUT_MS,
  deleteMetadataValue,
  getMetadataValue,
  isSqliteBusy,
  requireRow,
  requireString,
  setMetadataValue,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from './store/database';
import { runCodeGraphMigrations } from './store/migrations';
import { rebuildSymbolFts } from './store/fts';
import { clearCopiedTimeToFirstGraph } from './build-timings';
import { parseGraphDiagnostics } from './diagnostics';
import {
  clearCodeGraphSummaryProjection,
  publishCodeGraphSummaryProjection,
  parseCodeGraphImportedTimestamp,
  readCodeGraphSummaryProjectionFromDatabase,
  readCodeGraphSummaryProjectionDatabase,
  readCodeGraphSummaryProjectionAssemblyDatabase,
  type ReadCodeGraphSummaryProjectionResult,
} from './summary-projection';
import { resolutionInputsTransferable } from './resolve/ts-module-resolver';
import type { CodeGraphRepositoryDiagnostics } from './types/code-graph';
import {
  CodeGraphIoError,
  codeGraphFailureClass,
  codeGraphIoError,
  errnoOf,
  isMissingPathError,
  type CodeGraphFailureClass,
} from './io-failure';

export interface CodeGraphBaseIdentity {
  repoId: string;
  canonicalRepoRoot: string;
  customLanguagesFingerprint: string;
}

export interface PublishedCodeGraphBase {
  manifestVersion: 1;
  repoId: string;
  canonicalRepoRoot: string;
  gitHead: string | null;
  schemaVersion: number;
  extractorVersion: number;
  customLanguagesFingerprint: string;
  generationId: string;
  graphRelativePath: string;
  publishedAt: string;
}

export interface CodeGraphSeedSource {
  dbPath: string;
  repoId: string;
  canonicalRepoRoot: string;
  destinationRootPath: string;
  generationId?: string;
  gitHead?: string | null;
  /** Source generation timestamp, used when an eager seed is promoted to a
   * readable completed graph before the normal worktree refresh runs. */
  completedBuildAt?: number;
}

export interface ValidatedCodeGraphBase {
  manifest: PublishedCodeGraphBase;
  dbPath: string;
  recovered: boolean;
}

/** Why a repository built cold instead of from a seed: a closed set. */
export type CodeGraphColdFallbackReason =
  | 'no-seed-source'
  | 'no-canonical-source'
  | 'no-compatible-base'
  | 'seed-copy-failed'
  | 'seed-preparation-failed'
  | 'duplicate-repository'
  | 'invalid-seed-source'
  | 'seed-import-failed'
  | 'worktree-graph-busy'
  | 'seed-flush-failed';

export interface CodeGraphColdFallback {
  repoId: string;
  reason: CodeGraphColdFallbackReason;
  /** Present when an I/O or database failure caused the fallback. */
  failureClass?: CodeGraphFailureClass;
}

export type CodeGraphSeedOutcome =
  | {
      repoId: string;
      status: 'seeded';
      generationId?: string;
      gitHead?: string | null;
    }
  | ({ status: 'cold-fallback' } & CodeGraphColdFallback)
  | { repoId: string; status: 'existing-graph-reused' };

export interface SeedCodeGraphResult {
  installed: boolean;
  outcomes: CodeGraphSeedOutcome[];
  durationMs: number;
}

export interface CloneCodeGraphResult {
  installed: boolean;
  /** Another connection was writing the worktree graph, so it was kept. */
  busy?: true;
  durationMs: number;
}

const BASE_MANIFEST_VERSION = 1;
const GRAPH_RELATIVE_PATH_PATTERN = /^generations\/([^/]+)\/graph\.db$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePublishedBase(value: unknown): PublishedCodeGraphBase | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.manifestVersion !== BASE_MANIFEST_VERSION ||
    typeof value.repoId !== 'string' ||
    typeof value.canonicalRepoRoot !== 'string' ||
    (value.gitHead !== null && typeof value.gitHead !== 'string') ||
    typeof value.schemaVersion !== 'number' ||
    typeof value.extractorVersion !== 'number' ||
    typeof value.customLanguagesFingerprint !== 'string' ||
    typeof value.generationId !== 'string' ||
    typeof value.graphRelativePath !== 'string' ||
    typeof value.publishedAt !== 'string'
  ) {
    return null;
  }
  const match = GRAPH_RELATIVE_PATH_PATTERN.exec(value.graphRelativePath);
  if (match?.[1] !== value.generationId) {
    return null;
  }
  const manifest: PublishedCodeGraphBase = {
    manifestVersion: BASE_MANIFEST_VERSION,
    repoId: value.repoId,
    canonicalRepoRoot: value.canonicalRepoRoot,
    gitHead: value.gitHead,
    schemaVersion: value.schemaVersion,
    extractorVersion: value.extractorVersion,
    customLanguagesFingerprint: value.customLanguagesFingerprint,
    generationId: value.generationId,
    graphRelativePath: value.graphRelativePath,
    publishedAt: value.publishedAt,
  };
  return manifest;
}

export function codeGraphBaseVariantHash(
  identity: Pick<
    CodeGraphBaseIdentity,
    'repoId' | 'customLanguagesFingerprint'
  >,
): string {
  return createHash('sha256')
    .update('code-graph-base-variant-v1\0')
    .update(identity.repoId)
    .update('\0')
    .update(identity.customLanguagesFingerprint)
    .digest('hex')
    .slice(0, 32);
}

export function getCodeGraphBaseVariantDir(
  shadowDir: string,
  identity: Pick<
    CodeGraphBaseIdentity,
    'repoId' | 'customLanguagesFingerprint'
  >,
): string {
  return path.join(shadowDir, 'code-graph', codeGraphBaseVariantHash(identity));
}

export function getCodeGraphBaseStagingDbPath(
  variantDir: string,
  buildId: string,
): string {
  return path.join(variantDir, 'staging', buildId, 'graph.db');
}

export function openReadonlyDatabase(dbPath: string): CodeGraphDatabase {
  return new DatabaseSync(dbPath, {
    readOnly: true,
    timeout: CODE_GRAPH_BUSY_TIMEOUT_MS,
  });
}

export interface ReadonlyCodeGraphRepositorySummary {
  repoId: string;
  gitHead: string | null;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  unresolvedEdgeCount: number;
  filesWithErrors: number;
  communityCount: number;
  flowCount: number;
}

export interface ReadonlyCodeGraphSummary {
  repositories: ReadonlyCodeGraphRepositorySummary[];
  lastBuildAt: number | null;
  completed: boolean;
  schemaVersion: number | null;
  extractorVersion: number | null;
  canonicalRepoRoot: string | null;
  customLanguagesFingerprint: string | null;
}

function numericCount(value: unknown): number {
  const row = requireRow(value);
  const count = row.n;
  if (typeof count === 'bigint') {
    return Number(count);
  }
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

/** Reads counts/metadata from an existing graph without running migrations. */
export function readReadonlyCodeGraphSummary(
  dbPath: string,
): ReadonlyCodeGraphSummary | null {
  let db: CodeGraphDatabase | undefined;
  try {
    db = openReadonlyDatabase(dbPath);
    if (!quickCheck(db)) {
      return null;
    }
    const database = db;
    const completedAt =
      getMetadataValue(db, 'completed_build_at') ??
      getMetadataValue(db, 'last_build_at');
    const derivedTableNames = new Set(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('communities', 'flows')",
        )
        .all()
        .map((value) => requireString(requireRow(value), 'name')),
    );
    const hasCommunities = derivedTableNames.has('communities');
    const hasFlows = derivedTableNames.has('flows');
    const repositories = database
      .prepare(
        'SELECT id, repo_id, git_head FROM repositories ORDER BY repo_id',
      )
      .all()
      .map((value): ReadonlyCodeGraphRepositorySummary => {
        const row = requireRow(value);
        const repositoryId = requireString(row, 'id');
        const gitHead = row.git_head;
        return {
          repoId: requireString(row, 'repo_id'),
          gitHead: typeof gitHead === 'string' ? gitHead : null,
          fileCount: numericCount(
            database
              .prepare(
                'SELECT COUNT(*) AS n FROM files WHERE repository_id = ?',
              )
              .get(repositoryId),
          ),
          symbolCount: numericCount(
            database
              .prepare(
                'SELECT COUNT(*) AS n FROM symbols WHERE repository_id = ?',
              )
              .get(repositoryId),
          ),
          edgeCount: numericCount(
            database
              .prepare(
                'SELECT COUNT(*) AS n FROM edges WHERE repository_id = ?',
              )
              .get(repositoryId),
          ),
          unresolvedEdgeCount: numericCount(
            database
              .prepare(
                'SELECT COUNT(*) AS n FROM edges WHERE repository_id = ? AND target_symbol_id IS NULL',
              )
              .get(repositoryId),
          ),
          filesWithErrors: numericCount(
            database
              .prepare(
                'SELECT COUNT(*) AS n FROM files WHERE repository_id = ? AND has_errors != 0',
              )
              .get(repositoryId),
          ),
          communityCount: hasCommunities
            ? numericCount(
                database
                  .prepare(
                    'SELECT COUNT(*) AS n FROM communities WHERE repository_id = ?',
                  )
                  .get(repositoryId),
              )
            : 0,
          flowCount: hasFlows
            ? numericCount(
                database
                  .prepare(
                    'SELECT COUNT(*) AS n FROM flows WHERE repository_id = ?',
                  )
                  .get(repositoryId),
              )
            : 0,
        };
      });
    const numberMetadata = (key: string): number | null => {
      const raw = getMetadataValue(database, key);
      if (raw === null) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const parsedLastBuildAt = completedAt === null ? null : Number(completedAt);
    return {
      repositories,
      lastBuildAt: Number.isFinite(parsedLastBuildAt)
        ? parsedLastBuildAt
        : null,
      completed: completedAt !== null,
      schemaVersion: numberMetadata('schema_version'),
      extractorVersion: numberMetadata('extractor_version'),
      canonicalRepoRoot: getMetadataValue(database, 'base_canonical_repo_root'),
      customLanguagesFingerprint: getMetadataValue(
        database,
        'custom_languages_fingerprint',
      ),
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only summary failures are represented by null.
    }
  }
}

/** Reads the validated portable summary without fact scans or legacy validation. */
export function readCodeGraphSummaryProjection(
  dbPath: string,
): ReadCodeGraphSummaryProjectionResult {
  return readCodeGraphSummaryProjectionDatabase(dbPath);
}

/** Explicit CLI-only readonly count exception, never an interactive host fallback. */
export function readReadonlyCodeGraphSummaryProjectionAssembly(
  dbPath: string,
  options: { worktreeRootPath?: string } = {},
): ReadCodeGraphSummaryProjectionResult {
  return readCodeGraphSummaryProjectionAssemblyDatabase(dbPath, options);
}

function quickCheck(db: CodeGraphDatabase): boolean {
  const row = requireRow(db.prepare('PRAGMA quick_check').get());
  return Object.values(row).some((value) => value === 'ok');
}

function readSoleRepository(db: CodeGraphDatabase): {
  repoId: string;
  gitHead: string | null;
} | null {
  const rows = db
    .prepare('SELECT repo_id, git_head FROM repositories ORDER BY repo_id')
    .all();
  if (rows.length !== 1) {
    return null;
  }
  const row = requireRow(rows[0]);
  const gitHead = row.git_head;
  if (gitHead !== null && typeof gitHead !== 'string') {
    return null;
  }
  return { repoId: requireString(row, 'repo_id'), gitHead };
}

function validateBaseDatabase(
  dbPath: string,
  expected: {
    repoId: string;
    canonicalRepoRoot: string;
    customLanguagesFingerprint: string;
    gitHead?: string | null;
  },
  options: { integrityCheck?: boolean } = {},
): { gitHead: string | null } | null {
  let db: CodeGraphDatabase | undefined;
  try {
    db = openReadonlyDatabase(dbPath);
    if (options.integrityCheck !== false && !quickCheck(db)) {
      return null;
    }
    if (
      getMetadataValue(db, 'base_canonical_repo_root') !==
      expected.canonicalRepoRoot
    ) {
      return null;
    }
    if (
      getMetadataValue(db, 'schema_version') !==
        String(CODE_GRAPH_SCHEMA_VERSION) ||
      getMetadataValue(db, 'extractor_version') !==
        String(CODE_GRAPH_EXTRACTOR_VERSION) ||
      getMetadataValue(db, 'custom_languages_fingerprint') !==
        expected.customLanguagesFingerprint ||
      getMetadataValue(db, 'completed_build_at') === null
    ) {
      return null;
    }
    const repository = readSoleRepository(db);
    if (
      repository === null ||
      repository.repoId !== expected.repoId ||
      (Object.prototype.hasOwnProperty.call(expected, 'gitHead') &&
        repository.gitHead !== expected.gitHead)
    ) {
      return null;
    }
    return { gitHead: repository.gitHead };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Validation failure is represented by null; close is best-effort.
    }
  }
}

async function recoveredManifest(
  variantDir: string,
  generationId: string,
  identity: Pick<
    CodeGraphBaseIdentity,
    'repoId' | 'canonicalRepoRoot' | 'customLanguagesFingerprint'
  >,
  /**
   * Mirrors `readPublishedCodeGraphBase`'s option. Recovery runs on the
   * Electron main thread for every candidate generation, so a caller that
   * already declined the page rescan must be able to decline it here too —
   * otherwise the degraded path reintroduces exactly the full-file
   * `quick_check` the fast path avoids.
   */
  validationMode: 'full' | 'metadata-only' = 'full',
): Promise<ValidatedCodeGraphBase | null> {
  const graphRelativePath = `generations/${generationId}/graph.db`;
  const dbPath = path.join(variantDir, ...graphRelativePath.split('/'));
  const validation = validateBaseDatabase(dbPath, identity, {
    integrityCheck: validationMode !== 'metadata-only',
  });
  if (validation === null) {
    return null;
  }
  const fileStat = await stat(dbPath).catch(() => null);
  return {
    manifest: {
      manifestVersion: 1,
      repoId: identity.repoId,
      canonicalRepoRoot: identity.canonicalRepoRoot,
      gitHead: validation.gitHead,
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION,
      customLanguagesFingerprint: identity.customLanguagesFingerprint,
      generationId,
      graphRelativePath,
      publishedAt: (fileStat?.mtime ?? new Date(0)).toISOString(),
    },
    dbPath,
    recovered: true,
  };
}

/** Reads a `current.json` manifest that matches the requested identity. */
async function readCurrentBaseManifest(
  variantDir: string,
  identity: Pick<
    CodeGraphBaseIdentity,
    'repoId' | 'canonicalRepoRoot' | 'customLanguagesFingerprint'
  >,
): Promise<PublishedCodeGraphBase | null> {
  try {
    const raw = await readFile(path.join(variantDir, 'current.json'), 'utf8');
    const manifest = parsePublishedBase(JSON.parse(raw));
    return manifest !== null &&
      manifest.repoId === identity.repoId &&
      manifest.canonicalRepoRoot === identity.canonicalRepoRoot &&
      manifest.schemaVersion === CODE_GRAPH_SCHEMA_VERSION &&
      manifest.extractorVersion === CODE_GRAPH_EXTRACTOR_VERSION &&
      manifest.customLanguagesFingerprint ===
        identity.customLanguagesFingerprint
      ? manifest
      : null;
  } catch {
    return null;
  }
}

/** Reads the current immutable generation, recovering from valid generations. */
export async function readPublishedCodeGraphBase(input: {
  variantDir: string;
  identity: Pick<
    CodeGraphBaseIdentity,
    'repoId' | 'canonicalRepoRoot' | 'customLanguagesFingerprint'
  >;
  /**
   * Published generations are immutable and were integrity-checked before
   * their pointer was installed. Latency-sensitive consumers that hold the
   * variant lease may validate just the manifest and identifying database
   * rows instead of rescanning every page with SQLite quick_check.
   *
   * `manifest-only` never opens SQLite: it trusts the atomically installed
   * manifest and only requires the referenced database file to exist. It
   * does not scan older generations, because recovery must open candidate
   * databases. Electron main uses this mode; the utility process that
   * consumes the database validates it before use.
   */
  validation?: 'full' | 'metadata-only' | 'manifest-only';
}): Promise<ValidatedCodeGraphBase | null> {
  const manifest = await readCurrentBaseManifest(
    input.variantDir,
    input.identity,
  );
  if (input.validation === 'manifest-only') {
    if (manifest === null) {
      return null;
    }
    const dbPath = path.join(
      input.variantDir,
      ...manifest.graphRelativePath.split('/'),
    );
    const dbStat = await stat(dbPath).catch(() => null);
    return dbStat?.isFile() === true
      ? { manifest, dbPath, recovered: false }
      : null;
  }
  if (manifest !== null) {
    const dbPath = path.join(
      input.variantDir,
      ...manifest.graphRelativePath.split('/'),
    );
    if (
      validateBaseDatabase(
        dbPath,
        {
          ...input.identity,
          gitHead: manifest.gitHead,
        },
        {
          integrityCheck: input.validation !== 'metadata-only',
        },
      ) !== null
    ) {
      return { manifest, dbPath, recovered: false };
    }
  }
  // A missing, corrupt, or unknown current pointer falls through to recovery.

  const generationsDir = path.join(input.variantDir, 'generations');
  const entries = await readdir(generationsDir, { withFileTypes: true }).catch(
    () => [],
  );
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        entry,
        modified:
          (await stat(path.join(generationsDir, entry.name)).catch(() => null))
            ?.mtimeMs ?? 0,
      })),
  );
  candidates.sort(
    (a, b) =>
      b.modified - a.modified || b.entry.name.localeCompare(a.entry.name),
  );
  for (const candidate of candidates) {
    const recovered = await recoveredManifest(
      input.variantDir,
      candidate.entry.name,
      input.identity,
      input.validation ?? 'full',
    );
    if (recovered !== null) {
      return recovered;
    }
  }
  return null;
}

/** Finds the newest valid immutable generation for one canonical repository. */
export async function readLatestPublishedCodeGraphBaseForRepository(input: {
  shadowDir: string;
  repoId: string;
  canonicalRepoRoot: string;
}): Promise<ValidatedCodeGraphBase | null> {
  const variantsRoot = path.join(input.shadowDir, 'code-graph');
  const variants = await readdir(variantsRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const candidates: Array<ValidatedCodeGraphBase & { modified: number }> = [];
  for (const variant of variants) {
    if (!variant.isDirectory()) continue;
    const variantDir = path.join(variantsRoot, variant.name);
    const generationsDir = path.join(variantDir, 'generations');
    const generations = await readdir(generationsDir, {
      withFileTypes: true,
    }).catch(() => []);
    for (const generation of generations) {
      if (!generation.isDirectory()) continue;
      const dbPath = path.join(generationsDir, generation.name, 'graph.db');
      const summary = readReadonlyCodeGraphSummary(dbPath);
      const repository = summary?.repositories[0];
      if (
        summary === null ||
        !summary.completed ||
        summary.repositories.length !== 1 ||
        repository?.repoId !== input.repoId ||
        summary.canonicalRepoRoot !== input.canonicalRepoRoot ||
        summary.schemaVersion !== CODE_GRAPH_SCHEMA_VERSION ||
        summary.extractorVersion !== CODE_GRAPH_EXTRACTOR_VERSION ||
        summary.customLanguagesFingerprint === null
      ) {
        continue;
      }
      const dbStat = await stat(dbPath).catch(() => null);
      const publishedAt = (dbStat?.mtime ?? new Date(0)).toISOString();
      candidates.push({
        manifest: {
          manifestVersion: 1,
          repoId: input.repoId,
          canonicalRepoRoot: input.canonicalRepoRoot,
          gitHead: repository.gitHead,
          schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
          extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION,
          customLanguagesFingerprint: summary.customLanguagesFingerprint,
          generationId: generation.name,
          graphRelativePath: `generations/${generation.name}/graph.db`,
          publishedAt,
        },
        dbPath,
        recovered: true,
        modified: dbStat?.mtimeMs ?? 0,
      });
    }
  }
  candidates.sort(
    (left, right) =>
      right.modified - left.modified ||
      right.manifest.generationId.localeCompare(left.manifest.generationId),
  );
  const latest = candidates[0];
  if (latest === undefined) return null;
  return {
    manifest: latest.manifest,
    dbPath: latest.dbPath,
    recovered: latest.recovered,
  };
}

/**
 * Returns whether the shadow contains any published generation for the exact
 * repository identity, even when that generation is too old or corrupt to be
 * opened by {@link readLatestPublishedCodeGraphBaseForRepository}.
 *
 * Callers use this to distinguish a broken matching graph from an unrelated
 * repository variant that happens to share the same shadow directory.
 */
export async function hasPublishedCodeGraphBaseForRepository(input: {
  shadowDir: string;
  repoId: string;
  canonicalRepoRoot: string;
  customLanguagesFingerprint?: string;
  /**
   * Reads one generation's summary when neither a manifest nor the
   * deterministic variant name identifies the repository. Defaults to the
   * synchronous in-process reader; Electron main injects a utility-process
   * reader because the summary scans the whole database.
   */
  readSummary?: (dbPath: string) => Promise<ReadonlyCodeGraphSummary | null>;
}): Promise<boolean> {
  const readSummary =
    input.readSummary ??
    ((dbPath: string): Promise<ReadonlyCodeGraphSummary | null> =>
      Promise.resolve(readReadonlyCodeGraphSummary(dbPath)));
  const variantsRoot = path.join(input.shadowDir, 'code-graph');
  const variants = await readdir(variantsRoot, { withFileTypes: true }).catch(
    () => [],
  );
  for (const variant of variants) {
    if (!variant.isDirectory()) continue;
    const variantDir = path.join(variantsRoot, variant.name);
    const currentRaw = await readFile(
      path.join(variantDir, 'current.json'),
      'utf8',
    ).catch(() => null);
    let currentManifest: PublishedCodeGraphBase | null = null;
    if (currentRaw !== null) {
      try {
        currentManifest = parsePublishedBase(JSON.parse(currentRaw));
      } catch {
        currentManifest = null;
      }
    }
    const matchesDeterministicVariant =
      input.customLanguagesFingerprint !== undefined &&
      variant.name ===
        codeGraphBaseVariantHash({
          repoId: input.repoId,
          customLanguagesFingerprint: input.customLanguagesFingerprint,
        });
    if (
      currentManifest?.repoId === input.repoId &&
      currentManifest.canonicalRepoRoot === input.canonicalRepoRoot &&
      (input.customLanguagesFingerprint === undefined ||
        currentManifest.customLanguagesFingerprint ===
          input.customLanguagesFingerprint)
    ) {
      return true;
    }
    if (matchesDeterministicVariant && currentRaw !== null) {
      return true;
    }
    const generationsDir = path.join(variantDir, 'generations');
    const generations = await readdir(generationsDir, {
      withFileTypes: true,
    }).catch(() => []);
    if (
      matchesDeterministicVariant &&
      generations.some((generation) => generation.isDirectory())
    ) {
      return true;
    }
    for (const generation of generations) {
      if (!generation.isDirectory()) continue;
      const summary = await readSummary(
        path.join(generationsDir, generation.name, 'graph.db'),
      );
      if (
        summary?.repositories.some(
          (repository) => repository.repoId === input.repoId,
        ) === true &&
        summary.canonicalRepoRoot === input.canonicalRepoRoot &&
        (input.customLanguagesFingerprint === undefined ||
          summary.customLanguagesFingerprint ===
            input.customLanguagesFingerprint)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Flushes a file or directory. Every open, sync or close error rejects with a
 * typed `flush` failure; a flush is never a silent no-op. `writeHandle` is the
 * host fact that flushing needs a handle opened for writing (Windows
 * `FlushFileBuffers` refuses a read-only one).
 */
async function fsyncPath(
  targetPath: string,
  writeHandle: boolean,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(targetPath, writeHandle ? 'r+' : 'r');
  } catch (error) {
    throw codeGraphIoError('flush', error);
  }
  try {
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw codeGraphIoError('flush', error);
  }
  try {
    await handle.close();
  } catch (error) {
    throw codeGraphIoError('flush', error);
  }
}

/**
 * Keeps the current generation plus the newest earlier one as a recovery
 * fallback. Every installed generation passed
 * {@link finalizeCodeGraphBaseStaging} before its rename, so retention is a
 * filesystem-only decision and never reopens a database.
 */
async function pruneGenerations(
  variantDir: string,
  currentGenerationId: string,
): Promise<void> {
  const generationsDir = path.join(variantDir, 'generations');
  const entries = await readdir(generationsDir, { withFileTypes: true }).catch(
    () => [],
  );
  const ranked = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        name: entry.name,
        modified:
          (await stat(path.join(generationsDir, entry.name)).catch(() => null))
            ?.mtimeMs ?? 0,
      })),
  );
  ranked.sort((a, b) => b.modified - a.modified);
  const keep = new Set([currentGenerationId]);
  const fallback = ranked.find(
    (candidate) => candidate.name !== currentGenerationId,
  );
  if (fallback !== undefined) {
    keep.add(fallback.name);
  }
  await Promise.all(
    ranked
      .filter((entry) => !keep.has(entry.name))
      .map((entry) =>
        rm(path.join(generationsDir, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  );
}

interface CodeGraphBasePublicationInput {
  variantDir: string;
  stagingDir: string;
  identity: Pick<
    CodeGraphBaseIdentity,
    'repoId' | 'canonicalRepoRoot' | 'customLanguagesFingerprint'
  >;
  gitHead: string | null;
  generationId?: string;
  /** Host fact: flushing needs a write handle, as on Windows. */
  flushRequiresWriteHandle?: boolean;
}

/**
 * Prepares a closed staging database for publication: records the canonical
 * root, truncates the WAL, syncs the file, and runs the full SQLite integrity
 * check. This opens SQLite and scans every page of a database that can exceed
 * a gigabyte, so the desktop app runs it in the code-graph build worker and
 * never on the Electron main thread.
 */
export async function finalizeCodeGraphBaseStaging(input: {
  dbPath: string;
  identity: CodeGraphBasePublicationInput['identity'];
  gitHead: string | null;
  /** Host fact: flushing needs a write handle, as on Windows. */
  flushRequiresWriteHandle?: boolean;
}): Promise<void> {
  const writer = new DatabaseSync(input.dbPath, {
    timeout: CODE_GRAPH_BUSY_TIMEOUT_MS,
  });
  try {
    setMetadataValue(
      writer,
      'base_canonical_repo_root',
      input.identity.canonicalRepoRoot,
    );
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    writer.close();
  }
  await fsyncPath(input.dbPath, input.flushRequiresWriteHandle === true);
  if (
    validateBaseDatabase(input.dbPath, {
      ...input.identity,
      gitHead: input.gitHead,
    }) === null
  ) {
    throw new Error('Code-graph base publication validation failed.');
  }
}

/** Finalizes and installs a staging database in one in-process step. */
export async function publishCodeGraphBase(
  input: CodeGraphBasePublicationInput,
): Promise<ValidatedCodeGraphBase> {
  await finalizeCodeGraphBaseStaging({
    dbPath: path.join(input.stagingDir, 'graph.db'),
    identity: input.identity,
    gitHead: input.gitHead,
    flushRequiresWriteHandle: input.flushRequiresWriteHandle,
  });
  return installCodeGraphBaseGeneration(input);
}

/**
 * Installs staging that {@link finalizeCodeGraphBaseStaging} accepted as the
 * variant's current immutable generation. Only filesystem work happens here
 * (rename, manifest switch, directory syncs, and retention), so Electron main
 * may call it without opening SQLite.
 */
export async function installCodeGraphBaseGeneration(
  input: CodeGraphBasePublicationInput,
): Promise<ValidatedCodeGraphBase> {
  const generationId = input.generationId ?? randomUUID();
  const generationsDir = path.join(input.variantDir, 'generations');
  const generationDir = path.join(generationsDir, generationId);
  const writeHandle = input.flushRequiresWriteHandle === true;
  await mkdir(generationsDir, { recursive: true });
  await rename(input.stagingDir, generationDir);
  const manifest: PublishedCodeGraphBase = {
    manifestVersion: 1,
    repoId: input.identity.repoId,
    canonicalRepoRoot: input.identity.canonicalRepoRoot,
    gitHead: input.gitHead,
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION,
    customLanguagesFingerprint: input.identity.customLanguagesFingerprint,
    generationId,
    graphRelativePath: `generations/${generationId}/graph.db`,
    publishedAt: new Date().toISOString(),
  };
  const currentPath = path.join(input.variantDir, 'current.json');
  const temporaryManifestPath = path.join(
    input.variantDir,
    `.current-${randomUUID()}.json`,
  );
  try {
    await fsyncPath(generationDir, writeHandle);
    await fsyncPath(generationsDir, writeHandle);
    await writeFile(
      temporaryManifestPath,
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    await fsyncPath(temporaryManifestPath, writeHandle);
  } catch (error) {
    // Nothing was switched: `current.json` still names the prior generation.
    // Recovery scans `generations/`, so move this unreferenced one back out
    // (a rename needs no read access) before a removal that may itself fail.
    await rm(temporaryManifestPath, { force: true }).catch(() => undefined);
    const removable = await rename(generationDir, input.stagingDir).then(
      () => input.stagingDir,
      () => generationDir,
    );
    await rm(removable, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
  await rename(temporaryManifestPath, currentPath);
  try {
    await fsyncPath(input.variantDir, writeHandle);
  } catch (error) {
    // The switch already happened; it is published but not known durable.
    throw codeGraphIoError('durability-unverified', error);
  }
  await pruneGenerations(input.variantDir, generationId);
  return {
    manifest,
    dbPath: path.join(generationDir, 'graph.db'),
    recovered: false,
  };
}

/** Removes abandoned private builds without touching immutable generations. */
export async function cleanupCodeGraphBaseStaging(
  variantDir: string,
): Promise<void> {
  await rm(path.join(variantDir, 'staging'), { recursive: true, force: true });
}

/** Creates private staging, optionally cloning a published generation. */
export async function prepareCodeGraphBaseStaging(input: {
  variantDir: string;
  buildId?: string;
  sourceDbPath?: string;
}): Promise<{ buildId: string; stagingDir: string; dbPath: string }> {
  const buildId = input.buildId ?? randomUUID();
  const stagingDir = path.join(input.variantDir, 'staging', buildId);
  const dbPath = path.join(stagingDir, 'graph.db');
  await mkdir(stagingDir, { recursive: true });
  if (input.sourceDbPath !== undefined) {
    // Generations reach 1–1.6 GB. Clone on copy-on-write filesystems; the
    // flag falls back to a regular copy elsewhere.
    await copyFile(input.sourceDbPath, dbPath, fsConstants.COPYFILE_FICLONE);
  }
  return { buildId, stagingDir, dbPath };
}

/**
 * Whether a published generation's database still carries the identity its
 * manifest claims: schema and extractor versions, completion marker, canonical
 * root, and a sole repository row at `gitHead`. It skips the full-page scan
 * {@link finalizeCodeGraphBaseStaging} ran before installation. This opens
 * SQLite, so the desktop app runs it in the code-graph read worker.
 */
export function isPublishedCodeGraphBaseDatabaseValid(
  dbPath: string,
  expected: CodeGraphBaseIdentity & { gitHead: string | null },
): boolean {
  return (
    validateBaseDatabase(dbPath, expected, { integrityCheck: false }) !== null
  );
}

export type CodeGraphCompletion =
  | { state: 'completed' }
  | { state: 'not-completed' }
  | {
      state: 'unreadable';
      failureClass: CodeGraphFailureClass;
      errno?: string;
    };

function unreadableCompletion(error: unknown): CodeGraphCompletion {
  const errno = errnoOf(error);
  return {
    state: 'unreadable',
    failureClass: codeGraphFailureClass(error),
    ...(errno === undefined ? {} : { errno }),
  };
}

/**
 * The completion a stat of `dbPath` decides: `not-completed` when the path is
 * missing, `unreadable` for any other stat error, null when it can be stat'ed.
 */
async function statCompletion(
  dbPath: string,
): Promise<CodeGraphCompletion | null> {
  try {
    await stat(dbPath);
    return null;
  } catch (error) {
    return isMissingPathError(error)
      ? { state: 'not-completed' }
      : unreadableCompletion(error);
  }
}

/**
 * Whether a graph completed: `not-completed` when the file is absent or has no
 * completion marker, `unreadable` (with its class) when it exists but cannot
 * be read. SQLite reports a missing and an unreadable file alike, so the file
 * is stat'ed to tell them apart.
 */
export async function readCodeGraphCompletion(
  dbPath: string,
): Promise<CodeGraphCompletion> {
  const statted = await statCompletion(dbPath);
  if (statted !== null) return statted;
  let db: CodeGraphDatabase | undefined;
  try {
    db = openReadonlyDatabase(dbPath);
    return getMetadataValue(db, 'completed_build_at') !== null ||
      getMetadataValue(db, 'last_build_at') !== null
      ? { state: 'completed' }
      : { state: 'not-completed' };
  } catch (error) {
    // Removed after the stat: absent, not unreadable.
    return (await statCompletion(dbPath)) ?? unreadableCompletion(error);
  } finally {
    try {
      db?.close();
    } catch {
      // The completion state is already decided.
    }
  }
}

/**
 * Failures of the machine, not of the graph (permissions, I/O, space): a
 * graph that fails this way is kept, never replaced, and the failure
 * propagates. A corrupt, foreign or busy graph stays replaceable, as before.
 */
function isEnvironmentalFailure(failureClass: CodeGraphFailureClass): boolean {
  return (
    failureClass === 'permission-denied' ||
    failureClass === 'io' ||
    failureClass === 'no-space'
  );
}

/**
 * Whether a seed target already holds a completed graph. A target that exists
 * but cannot be read for an environmental reason is kept: this rejects with
 * its typed `unreadable-graph` failure instead of seeding over it.
 */
export async function hasCompletedSeedTarget(dbPath: string): Promise<boolean> {
  const completion = await readCodeGraphCompletion(dbPath);
  if (
    completion.state === 'unreadable' &&
    isEnvironmentalFailure(completion.failureClass)
  )
    throw new CodeGraphIoError(
      'unreadable-graph',
      completion.failureClass,
      completion.errno,
    );
  return completion.state === 'completed';
}

type WorktreeGraphInstallOutcome = 'installed' | 'existing-graph' | 'busy';

function isSharingViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const code: unknown = Reflect.get(error, 'code');
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

function hasCompletionMarker(db: CodeGraphDatabase): boolean {
  try {
    return (
      getMetadataValue(db, 'completed_build_at') !== null ||
      getMetadataValue(db, 'last_build_at') !== null
    );
  } catch (error) {
    // A corrupt or foreign database is replaced; an unreadable one is kept.
    if (!isEnvironmentalFailure(codeGraphFailureClass(error))) return false;
    throw codeGraphIoError('unreadable-graph', error);
  }
}

function releaseInstallGuard(guard: DatabaseSync): void {
  try {
    guard.exec('ROLLBACK');
  } catch {
    // Nothing was written under the guard.
  }
  try {
    guard.close();
  } catch {
    // The guard only held a lock.
  }
}

const GRAPH_FILE_SUFFIXES = ['', '-wal', '-shm'] as const;

/**
 * Replacement without the guard, where open files block it (Windows): the
 * graph and its sidecars are renamed aside before the new graph is renamed
 * in, and renamed back if any step fails, so a sharing violation leaves the
 * prior graph where it was.
 * Returns false for a sharing violation.
 */
function replaceGraphFilesKeepingTarget(
  temporaryDbPath: string,
  targetDbPath: string,
): boolean {
  const asidePath = `${targetDbPath}.replacing-${randomUUID()}`;
  const moved: string[] = [];
  try {
    for (const suffix of GRAPH_FILE_SUFFIXES) {
      try {
        renameSync(`${targetDbPath}${suffix}`, `${asidePath}${suffix}`);
        moved.push(suffix);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    renameSync(temporaryDbPath, targetDbPath);
  } catch (error) {
    for (const suffix of moved.reverse()) {
      try {
        renameSync(`${asidePath}${suffix}`, `${targetDbPath}${suffix}`);
      } catch {
        // The aside copy stays for recovery; the install still reports failure.
      }
    }
    if (isSharingViolation(error)) return false;
    throw error;
  }
  for (const suffix of moved) {
    rmSync(`${asidePath}${suffix}`, { force: true });
  }
  return true;
}

/**
 * Renames a complete private database over a worktree graph. The target is
 * held with an immediate transaction first, with no earlier existence check,
 * so a graph another connection has just created is held too. A connection
 * writing it (a build, possibly in another process) keeps it, and completion
 * is re-checked under that lock. Where open files block replacement (Windows),
 * the lock is released just before the replacement. SQLite opens its
 * files without delete sharing, so a connection that opens the target in that
 * gap makes renaming it aside fail, and the target is kept as busy; a build
 * holds its connection open for its whole run, so none can finish unseen.
 */
async function installWorktreeGraphDatabase(
  temporaryDbPath: string,
  targetDbPath: string,
  facts: {
    openFilesBlockReplacement: boolean;
    flushRequiresWriteHandle: boolean;
  },
): Promise<WorktreeGraphInstallOutcome> {
  const { openFilesBlockReplacement } = facts;
  let guard: DatabaseSync | undefined;
  try {
    guard = new DatabaseSync(targetDbPath, { timeout: 0 });
    guard.exec('BEGIN IMMEDIATE');
  } catch (error) {
    if (guard !== undefined) releaseInstallGuard(guard);
    guard = undefined;
    // A writer keeps the target. A corrupt or foreign target is replaced, as
    // before; one that cannot be opened for another reason is kept.
    if (isSqliteBusy(error)) return 'busy';
    if (isEnvironmentalFailure(codeGraphFailureClass(error)))
      throw codeGraphIoError('unreadable-graph', error);
  }
  try {
    if (guard !== undefined && hasCompletionMarker(guard)) {
      return 'existing-graph';
    }
    if (guard !== undefined && openFilesBlockReplacement) {
      releaseInstallGuard(guard);
      guard = undefined;
    }
    if (openFilesBlockReplacement) {
      if (!replaceGraphFilesKeepingTarget(temporaryDbPath, targetDbPath)) {
        return 'busy';
      }
    } else {
      rmSync(targetDbPath, { force: true });
      rmSync(`${targetDbPath}-wal`, { force: true });
      rmSync(`${targetDbPath}-shm`, { force: true });
      renameSync(temporaryDbPath, targetDbPath);
    }
  } finally {
    if (guard !== undefined) releaseInstallGuard(guard);
  }
  try {
    await fsyncPath(path.dirname(targetDbPath), facts.flushRequiresWriteHandle);
  } catch (error) {
    // The graph is already in place; it is installed but not known durable.
    throw codeGraphIoError('durability-unverified', error);
  }
  return 'installed';
}

function uninstalledSeedOutcome(
  repoId: string,
  install: Exclude<WorktreeGraphInstallOutcome, 'installed'>,
): CodeGraphSeedOutcome {
  return install === 'busy'
    ? { repoId, status: 'cold-fallback', reason: 'worktree-graph-busy' }
    : { repoId, status: 'existing-graph-reused' };
}

function seedFlushFailedOutcome(
  repoId: string,
  error: unknown,
): CodeGraphSeedOutcome {
  return {
    repoId,
    status: 'cold-fallback',
    reason: 'seed-flush-failed',
    failureClass: codeGraphFailureClass(error),
  };
}

function installFacts(input: {
  openFilesBlockReplacement?: boolean;
  flushRequiresWriteHandle?: boolean;
}): { openFilesBlockReplacement: boolean; flushRequiresWriteHandle: boolean } {
  return {
    openFilesBlockReplacement: input.openFilesBlockReplacement === true,
    flushRequiresWriteHandle: input.flushRequiresWriteHandle === true,
  };
}

function validateSeedSource(
  source: CodeGraphSeedSource,
  customLanguagesFingerprint: string,
): 'invalid-seed-source' | null {
  return validateBaseDatabase(source.dbPath, {
    repoId: source.repoId,
    canonicalRepoRoot: source.canonicalRepoRoot,
    customLanguagesFingerprint,
    ...(Object.prototype.hasOwnProperty.call(source, 'gitHead')
      ? { gitHead: source.gitHead }
      : {}),
  }) === null
    ? 'invalid-seed-source'
    : null;
}

/**
 * What a source base computed for its repository beyond its rows, carried
 * into the fused graph so the worktree refresh can reuse it.
 */
interface ImportedSeedMarkers {
  derivedAt: string | null;
  completedBuildAt: number | null;
  sourceCompletionAt: number | null;
  diagnostics: CodeGraphRepositoryDiagnostics | null;
}

function attachedMetadataValue(
  db: CodeGraphDatabase,
  alias: string,
  key: string,
): string | null {
  const row = db
    .prepare(`SELECT value FROM ${alias}.graph_metadata WHERE key = ?`)
    .get(key);
  return row === undefined ? null : requireString(requireRow(row), 'value');
}

/**
 * Carries a repository's recorded resolution inputs from the graph it was
 * built in (`recordedRootPath`) to a copy at `rootPath`, when every input
 * the resolver could probe there was recorded; otherwise the marker is
 * dropped and the next build resolves the repository again.
 */
function carryResolutionInputs(
  db: CodeGraphDatabase,
  repoId: string,
  saved: string | null,
  recordedRootPath: string,
  rootPath: string,
): void {
  const key = `resolution_inputs:${repoId}`;
  if (
    saved !== null &&
    resolutionInputsTransferable(saved, recordedRootPath, rootPath)
  ) {
    setMetadataValue(db, key, saved);
  } else {
    db.prepare('DELETE FROM graph_metadata WHERE key = ?').run(key);
  }
}

function importSeedSource(
  db: CodeGraphDatabase,
  source: CodeGraphSeedSource,
  alias: string,
): ImportedSeedMarkers {
  db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(
    `${pathToFileURL(source.dbPath).href}?mode=ro`,
  );
  try {
    return withImmediateTransaction(db, (): ImportedSeedMarkers => {
      db.prepare(
        `INSERT INTO repositories (id, repo_id, root_path, git_head, updated_at)
         SELECT id, repo_id, ?, git_head, updated_at FROM ${alias}.repositories WHERE repo_id = ?`,
      ).run(source.destinationRootPath, source.repoId);
      for (const table of [
        'files',
        'symbols',
        'edges',
        'communities',
        'flows',
      ] as const) {
        const collision = requireRow(
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM ${table} d JOIN ${alias}.${table} s ON s.id = d.id`,
            )
            .get(),
        ).n;
        if (
          (typeof collision === 'bigint' && collision !== BigInt(0)) ||
          (typeof collision === 'number' && collision !== 0)
        ) {
          throw new Error(`row-id collision while importing ${table}`);
        }
      }
      db.exec(
        `INSERT INTO files SELECT * FROM ${alias}.files;
         INSERT INTO symbols SELECT * FROM ${alias}.symbols;
         INSERT INTO edges SELECT * FROM ${alias}.edges;
         INSERT INTO communities SELECT * FROM ${alias}.communities;
         INSERT INTO community_memberships SELECT * FROM ${alias}.community_memberships;
         INSERT INTO flows SELECT * FROM ${alias}.flows;
         INSERT INTO flow_memberships SELECT * FROM ${alias}.flow_memberships;`,
      );
      const rows = db
        .prepare(
          `SELECT f.id, f.relative_path FROM files f JOIN repositories r ON r.id = f.repository_id WHERE r.repo_id = ?`,
        )
        .all(source.repoId);
      // The recorded mtimes describe the base's checkout, not this one, so
      // they are cleared: the refresh reads and hashes every file rather than
      // trusting a size and mtime that merely match.
      const updatePath = db.prepare(
        "UPDATE files SET absolute_path = ?, mtime_ns = '' WHERE id = ?",
      );
      for (const value of rows) {
        const row = requireRow(value);
        updatePath.run(
          path.join(
            source.destinationRootPath,
            requireString(row, 'relative_path'),
          ),
          requireString(row, 'id'),
        );
      }
      // The base resolved, indexed and analysed this repository on its own;
      // resolution, full-text rows and derived analysis are per repository,
      // so they hold in the fused graph too. Carrying the markers lets an
      // unchanged worktree reuse that work instead of redoing it graph-wide.
      const recordedRoot = db
        .prepare(
          `SELECT root_path FROM ${alias}.repositories WHERE repo_id = ?`,
        )
        .get(source.repoId);
      carryResolutionInputs(
        db,
        source.repoId,
        attachedMetadataValue(db, alias, `resolution_inputs:${source.repoId}`),
        recordedRoot === undefined
          ? source.destinationRootPath
          : requireString(requireRow(recordedRoot), 'root_path'),
        source.destinationRootPath,
      );
      const completedRaw = attachedMetadataValue(
        db,
        alias,
        'completed_build_at',
      );
      const lastBuildRaw = attachedMetadataValue(db, alias, 'last_build_at');
      // Legacy last-only completion is supported only before snapshot imports
      // and absent a pending derived/build publication. An explicit caller
      // timestamp is not evidence that an incomplete attached source completed.
      const legacyCompletionSupported =
        completedRaw === null &&
        attachedMetadataValue(db, alias, 'imported_from_snapshot') === null &&
        attachedMetadataValue(db, alias, 'derived_pending') === null;
      const parseRetainedTimestamp = (raw: string | null): number | null => {
        if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
        const value = Number(raw);
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
      };
      const importedRaw = attachedMetadataValue(
        db,
        alias,
        'imported_from_snapshot',
      );
      const importedAt =
        importedRaw === null
          ? null
          : parseCodeGraphImportedTimestamp(importedRaw);
      const completedValue = parseRetainedTimestamp(completedRaw);
      const completionSupported =
        completedValue !== null &&
        (importedRaw === null ||
          (importedAt !== null && completedValue >= importedAt));
      const lastBuildValue = parseRetainedTimestamp(lastBuildRaw);
      return {
        derivedAt: attachedMetadataValue(db, alias, 'derived_at'),
        completedBuildAt: completionSupported ? completedValue : null,
        sourceCompletionAt: completionSupported
          ? completedValue
          : legacyCompletionSupported
            ? lastBuildValue
            : null,
        diagnostics:
          parseGraphDiagnostics(
            attachedMetadataValue(db, alias, 'graph_diagnostics'),
          )?.repositories.find(
            (repository) => repository.repoId === source.repoId,
          ) ?? null,
      };
    });
  } finally {
    db.exec(`DETACH DATABASE ${alias}`);
  }
}

/**
 * Records the markers carried from every seeded source. Derived analysis is
 * fresh for the fused graph only when every requested repository was seeded
 * from a base whose analysis was fresh; diagnostics are per repository.
 */
function recordFusedSeedMarkers(
  db: CodeGraphDatabase,
  requestedSources: number,
  markers: readonly ImportedSeedMarkers[],
): void {
  const derivedTimes = markers.map((marker) =>
    marker.derivedAt === null ? Number.NaN : Number(marker.derivedAt),
  );
  if (
    requestedSources > 0 &&
    markers.length === requestedSources &&
    derivedTimes.every((value) => Number.isFinite(value))
  ) {
    setMetadataValue(db, 'derived_at', String(Math.min(...derivedTimes)));
  }
  const repositories = markers.flatMap((marker) =>
    marker.diagnostics === null ? [] : [marker.diagnostics],
  );
  if (repositories.length > 0) {
    // The worktree refresh rewrites freshness and the recording time; until
    // then the fused graph claims only stat-level freshness.
    setMetadataValue(
      db,
      'graph_diagnostics',
      JSON.stringify({
        freshness: 'stat',
        recordedAt: Date.now(),
        repositories,
      }),
    );
  }
}

/**
 * Fuses compatible per-repo bases into a private database and atomically
 * installs it only when no completed worktree graph already exists.
 */
export async function seedCodeGraphDatabase(input: {
  targetDbPath: string;
  sources: readonly CodeGraphSeedSource[];
  customLanguagesFingerprint: string;
  /** Marks a fully seeded snapshot as immediately readable. The normal build
   * path leaves this false and writes its own completion marker after refresh. */
  markCompletedFromSources?: boolean;
  /** Host fact: the filesystem refuses to rename or delete an open file, as
   * on Windows. Replacing the worktree graph then releases its write lock
   * first and keeps the prior graph if another connection opens it. */
  openFilesBlockReplacement?: boolean;
  /** Host fact: flushing needs a write handle, as on Windows. */
  flushRequiresWriteHandle?: boolean;
}): Promise<SeedCodeGraphResult> {
  const startedAt = Date.now();
  if (await hasCompletedSeedTarget(input.targetDbPath)) {
    return {
      installed: false,
      outcomes: input.sources.map((source) => ({
        repoId: source.repoId,
        status: 'existing-graph-reused' as const,
      })),
      durationMs: Date.now() - startedAt,
    };
  }

  const temporaryDbPath = `${input.targetDbPath}.seed-${randomUUID()}`;
  await mkdir(path.dirname(input.targetDbPath), { recursive: true });
  let db: CodeGraphDatabase | undefined;
  const outcomes: CodeGraphSeedOutcome[] = [];
  try {
    db = new DatabaseSync(temporaryDbPath, {
      timeout: CODE_GRAPH_BUSY_TIMEOUT_MS,
    });
    db.exec('PRAGMA journal_mode = WAL;');
    runCodeGraphMigrations(db);
    const seenRepoIds = new Set<string>();
    const importedMarkers: ImportedSeedMarkers[] = [];
    for (let index = 0; index < input.sources.length; index += 1) {
      const source = input.sources[index];
      if (source === undefined) {
        continue;
      }
      if (seenRepoIds.has(source.repoId)) {
        outcomes.push({
          repoId: source.repoId,
          status: 'cold-fallback',
          reason: 'duplicate-repository',
        });
        continue;
      }
      seenRepoIds.add(source.repoId);
      const invalidReason = validateSeedSource(
        source,
        input.customLanguagesFingerprint,
      );
      if (invalidReason !== null) {
        outcomes.push({
          repoId: source.repoId,
          status: 'cold-fallback',
          reason: invalidReason,
        });
        continue;
      }
      try {
        importedMarkers.push(importSeedSource(db, source, `seed_${index}`));
        outcomes.push({
          repoId: source.repoId,
          status: 'seeded',
          generationId: source.generationId,
          gitHead: source.gitHead,
        });
      } catch (error) {
        outcomes.push({
          repoId: source.repoId,
          status: 'cold-fallback',
          reason: 'seed-import-failed',
          failureClass: codeGraphFailureClass(error),
        });
      }
    }
    const seededSources = input.sources.filter((_source, index) => {
      return outcomes[index]?.status === 'seeded';
    });
    const seedDb = db;
    withImmediateTransaction(seedDb, () => {
      setMetadataValue(
        seedDb,
        'extractor_version',
        String(CODE_GRAPH_EXTRACTOR_VERSION),
      );
      setMetadataValue(
        seedDb,
        'custom_languages_fingerprint',
        input.customLanguagesFingerprint,
      );
      recordFusedSeedMarkers(seedDb, input.sources.length, importedMarkers);
      // Source FTS rowids can collide. Rebuild once in the private staging
      // writer before the same transaction publishes its measured summary.
      rebuildSymbolFts(seedDb);
      setMetadataValue(
        seedDb,
        'seed_provenance',
        JSON.stringify(
          outcomes
            .filter((outcome) => outcome.status === 'seeded')
            .map((outcome) => ({
              repoId: outcome.repoId,
              generationId: outcome.generationId,
              gitHead: outcome.gitHead,
            })),
        ),
      );
      // Retained source evidence is authoritative. completedBuildAt supplied by
      // a caller may describe a generation, but cannot promote an incomplete DB.
      const completionTimes = seededSources.map(
        (_source, index) => importedMarkers[index]?.sourceCompletionAt ?? null,
      );
      const completionTimesAreValid =
        completionTimes.length === input.sources.length &&
        completionTimes.every((value) => value !== null);
      if (
        input.markCompletedFromSources === true &&
        input.sources.length > 0 &&
        seededSources.length === input.sources.length &&
        completionTimesAreValid
      ) {
        const completedBuildAt = Math.max(
          ...completionTimes.filter((value): value is number => value !== null),
        );
        setMetadataValue(seedDb, 'last_build_at', String(completedBuildAt));
        if (
          importedMarkers.every((marker) => marker.completedBuildAt !== null)
        ) {
          setMetadataValue(
            seedDb,
            'completed_build_at',
            String(completedBuildAt),
          );
        } else {
          // Preserve legacy last-only completion without inventing a missing
          // completed_build_at marker for any source generation.
          deleteMetadataValue(seedDb, 'completed_build_at');
        }
        publishCodeGraphSummaryProjection(seedDb);
      } else {
        // A partial seed has no source-completion claim. Do not invent one or
        // retain a projection that could make the aggregate look complete.
        deleteMetadataValue(seedDb, 'last_build_at');
        deleteMetadataValue(seedDb, 'completed_build_at');
        clearCodeGraphSummaryProjection(seedDb);
      }
    });
    if (!quickCheck(db)) {
      throw new Error('Fused code-graph database failed SQLite quick_check.');
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    db = undefined;
    const facts = installFacts(input);
    try {
      await fsyncPath(temporaryDbPath, facts.flushRequiresWriteHandle);
    } catch (error) {
      // An unflushed seed is never installed; every repository builds cold,
      // and one that already fell back keeps its own reason.
      return {
        installed: false,
        outcomes: outcomes.map((outcome) =>
          outcome.status === 'seeded'
            ? seedFlushFailedOutcome(outcome.repoId, error)
            : outcome,
        ),
        durationMs: Date.now() - startedAt,
      };
    }

    const install = await installWorktreeGraphDatabase(
      temporaryDbPath,
      input.targetDbPath,
      facts,
    );
    if (install !== 'installed') {
      return {
        installed: false,
        outcomes: input.sources.map((source) =>
          uninstalledSeedOutcome(source.repoId, install),
        ),
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      installed: true,
      outcomes,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Preserve the original fusion failure.
    }
    await rm(temporaryDbPath, { force: true }).catch(() => undefined);
    await rm(`${temporaryDbPath}-wal`, { force: true }).catch(() => undefined);
    await rm(`${temporaryDbPath}-shm`, { force: true }).catch(() => undefined);
  }
}

/**
 * Seeds a single-repository worktree from its one published base by cloning
 * the base database (copy-on-write where the filesystem supports it) instead
 * of fusing it row by row. The clone keeps everything the base computed:
 * resolution inputs (when transferable to the new root), full-text rows,
 * derived analysis and diagnostics, so an unchanged checkout's refresh skips
 * graph-wide work. Completion markers are cleared, as after fusion, so the
 * worktree's own refresh completes the graph and records its first graph.
 *
 * The source is validated exactly as fusion validates it. Returns null when
 * it is invalid or the clone fails; the caller then fuses, which reports the
 * same cold fallback for an invalid source.
 */
export async function seedCodeGraphDatabaseByClone(input: {
  targetDbPath: string;
  source: CodeGraphSeedSource;
  customLanguagesFingerprint: string;
  /** Host fact: the filesystem refuses to rename or delete an open file, as
   * on Windows. Replacing the worktree graph then releases its write lock
   * first and keeps the prior graph if another connection opens it. */
  openFilesBlockReplacement?: boolean;
  /** Host fact: flushing needs a write handle, as on Windows. */
  flushRequiresWriteHandle?: boolean;
}): Promise<SeedCodeGraphResult | null> {
  const startedAt = Date.now();
  if (await hasCompletedSeedTarget(input.targetDbPath)) {
    return {
      installed: false,
      outcomes: [
        { repoId: input.source.repoId, status: 'existing-graph-reused' },
      ],
      durationMs: Date.now() - startedAt,
    };
  }
  if (
    validateSeedSource(input.source, input.customLanguagesFingerprint) !== null
  ) {
    return null;
  }
  try {
    const cloned = await cloneCompletedCodeGraphDatabase({
      sourceDbPath: input.source.dbPath,
      targetDbPath: input.targetDbPath,
      repositories: [
        {
          repoId: input.source.repoId,
          rootPath: input.source.destinationRootPath,
        },
      ],
      copyMode: 'immutable-file-copy',
      sourceAlreadyValidated: true,
      targetValidation: 'metadata-only',
      completion: 'clear',
      ...installFacts(input),
      seedProvenance: [
        {
          repoId: input.source.repoId,
          generationId: input.source.generationId,
          gitHead: input.source.gitHead,
        },
      ],
    });
    return {
      installed: cloned.installed,
      outcomes: [
        cloned.installed
          ? {
              repoId: input.source.repoId,
              status: 'seeded',
              generationId: input.source.generationId,
              gitHead: input.source.gitHead,
            }
          : uninstalledSeedOutcome(
              input.source.repoId,
              cloned.busy === true ? 'busy' : 'existing-graph',
            ),
      ],
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof CodeGraphIoError && error.kind === 'flush') {
      // The clone was not flushed, so it was not installed.
      return {
        installed: false,
        outcomes: [seedFlushFailedOutcome(input.source.repoId, error)],
        durationMs: Date.now() - startedAt,
      };
    }
    // A kept unreadable graph or an unverified install fails the build, and
    // so does an environmental failure (permissions, I/O, space) while the
    // source is still in place. A missing, corrupt or foreign source, or the
    // clone's own identity checks, fall back to fusion. SQLite reports a
    // vanished source as a generic open failure, so the source is stat'ed.
    if (error instanceof CodeGraphIoError) throw error;
    if (
      isMissingPathError(error) ||
      !isEnvironmentalFailure(codeGraphFailureClass(error)) ||
      (await stat(input.source.dbPath).then(() => false, isMissingPathError))
    )
      return null;
    throw error;
  }
}

/**
 * Takes a transactionally consistent SQLite snapshot of a completed worktree
 * graph, rewrites its repository/file roots for a new checkout, and installs
 * it atomically. This is the cheapest seed path when a worktree is explicitly
 * created from another worktree: no graph rows are serialized or reparsed.
 */
export async function cloneCompletedCodeGraphDatabase(input: {
  sourceDbPath: string;
  targetDbPath: string;
  repositories: readonly { repoId: string; rootPath: string }[];
  /** Immutable published bases can use a plain file copy. Live worktree
   * databases must retain the default SQLite backup for WAL consistency. */
  copyMode?: 'sqlite-backup' | 'immutable-file-copy';
  /**
   * Valid only for a published base whose identity was just checked by
   * `readPublishedCodeGraphBase` while its variant lock remains held.
   *
   * Note this asserts *identity*, not page-level integrity: main-process
   * callers pass `validation: 'metadata-only'`, so no `quick_check` has
   * necessarily run. That is deliberate — published generations are
   * immutable and are integrity-checked plus fsynced before their pointer is
   * installed, so rescanning every page on a latency-sensitive path buys
   * nothing.
   */
  sourceAlreadyValidated?: boolean;
  /**
   * SQLite backup already supplies a transactionally consistent copy of a
   * live worktree database. A completed source can use metadata-only
   * validation on this latency-sensitive path and leave full integrity scans
   * to publication/build boundaries.
   */
  sourceValidation?: 'full' | 'metadata-only';
  /**
   * A copy of an immutable published generation can reuse the integrity proof
   * from publication. The clone transaction still validates schema,
   * completion metadata, and repository identity after rebinding paths.
   */
  targetValidation?: 'full' | 'metadata-only';
  /**
   * `keep` (the default) installs a readable completed graph. `clear` removes
   * the completion markers (`completed_build_at`, `last_build_at`) so the
   * worktree's own refresh completes it, like a fused seed: that refresh is
   * then the worktree's first graph. Every other marker is kept.
   */
  completion?: 'keep' | 'clear';
  /** Recorded as `seed_provenance`, as fusion does, when provided. */
  seedProvenance?: readonly {
    repoId: string;
    generationId?: string;
    gitHead?: string | null;
  }[];
  /** Host fact: the filesystem refuses to rename or delete an open file, as
   * on Windows. Replacing the worktree graph then releases its write lock
   * first and keeps the prior graph if another connection opens it. */
  openFilesBlockReplacement?: boolean;
  /** Host fact: flushing needs a write handle, as on Windows. */
  flushRequiresWriteHandle?: boolean;
}): Promise<CloneCodeGraphResult> {
  const startedAt = Date.now();
  if (await hasCompletedSeedTarget(input.targetDbPath)) {
    return { installed: false, durationMs: Date.now() - startedAt };
  }

  const temporaryDbPath = `${input.targetDbPath}.clone-${randomUUID()}`;
  await mkdir(path.dirname(input.targetDbPath), { recursive: true });
  let sourceDb: DatabaseSync | undefined;
  let clonedDb: DatabaseSync | undefined;
  try {
    sourceDb = new DatabaseSync(input.sourceDbPath, {
      readOnly: true,
      timeout: CODE_GRAPH_BUSY_TIMEOUT_MS,
    });
    if (
      getMetadataValue(sourceDb, 'schema_version') !==
        String(CODE_GRAPH_SCHEMA_VERSION) ||
      (getMetadataValue(sourceDb, 'completed_build_at') === null &&
        getMetadataValue(sourceDb, 'last_build_at') === null) ||
      (input.sourceAlreadyValidated !== true &&
        input.sourceValidation !== 'metadata-only' &&
        !quickCheck(sourceDb))
    ) {
      return { installed: false, durationMs: Date.now() - startedAt };
    }
    const sourceRepoIds = sourceDb
      .prepare('SELECT repo_id FROM repositories ORDER BY repo_id')
      .all()
      .map((value) => requireString(requireRow(value), 'repo_id'));
    const targetRepoIds = input.repositories
      .map((repository) => repository.repoId)
      .sort((left, right) => left.localeCompare(right));
    if (
      sourceRepoIds.length !== targetRepoIds.length ||
      sourceRepoIds.some((repoId, index) => repoId !== targetRepoIds[index])
    ) {
      return { installed: false, durationMs: Date.now() - startedAt };
    }

    if (input.copyMode === 'immutable-file-copy') {
      sourceDb.close();
      sourceDb = undefined;
      // APFS and other clone-capable filesystems make this copy-on-write and
      // near-constant-time. COPYFILE_FICLONE falls back to a regular copy when
      // cloning is unavailable, preserving cross-platform behavior.
      await copyFile(
        input.sourceDbPath,
        temporaryDbPath,
        fsConstants.COPYFILE_FICLONE,
      );
    } else {
      await backup(sourceDb, temporaryDbPath);
      sourceDb.close();
      sourceDb = undefined;
    }

    clonedDb = new DatabaseSync(temporaryDbPath, {
      timeout: CODE_GRAPH_BUSY_TIMEOUT_MS,
    });
    clonedDb.exec('PRAGMA journal_mode = WAL;');
    clonedDb.function(
      'canopy_join_clone_path',
      { deterministic: true },
      (rootPath, relativePath): string => {
        if (typeof rootPath !== 'string' || typeof relativePath !== 'string') {
          throw new TypeError('Code-graph clone paths must be strings.');
        }
        return path.join(rootPath, relativePath);
      },
    );
    withImmediateTransaction(clonedDb, () => {
      const recordedRoot = clonedDb?.prepare(
        'SELECT root_path FROM repositories WHERE repo_id = ?',
      );
      const updateRepository = clonedDb?.prepare(
        'UPDATE repositories SET root_path = ? WHERE repo_id = ?',
      );
      // As after fusion, the copied mtimes describe another checkout: clear
      // them so the next refresh reads and hashes every file.
      const updateFiles = clonedDb?.prepare(
        `UPDATE files
         SET absolute_path = canopy_join_clone_path(?, relative_path),
             mtime_ns = ''
         WHERE repository_id = (
           SELECT id FROM repositories WHERE repo_id = ?
         )`,
      );
      if (!clonedDb || !recordedRoot || !updateRepository || !updateFiles) {
        throw new Error('Failed to prepare cloned code-graph path updates.');
      }
      for (const repository of input.repositories) {
        const previousRoot = recordedRoot.get(repository.repoId);
        // Recorded resolution inputs move with the repository only when the
        // new root's every possible probe was recorded (see
        // `resolutionInputsTransferable`).
        carryResolutionInputs(
          clonedDb,
          repository.repoId,
          getMetadataValue(clonedDb, `resolution_inputs:${repository.repoId}`),
          previousRoot === undefined
            ? repository.rootPath
            : requireString(requireRow(previousRoot), 'root_path'),
          repository.rootPath,
        );
        updateRepository.run(repository.rootPath, repository.repoId);
        updateFiles.run(repository.rootPath, repository.repoId);
      }
      // Time to first graph belongs to the source's worktree, not this one.
      clearCopiedTimeToFirstGraph(clonedDb);
      if (input.completion === 'clear') {
        clonedDb
          .prepare(
            "DELETE FROM graph_metadata WHERE key IN ('completed_build_at', 'last_build_at')",
          )
          .run();
      }
      if (input.seedProvenance !== undefined) {
        setMetadataValue(
          clonedDb,
          'seed_provenance',
          JSON.stringify(input.seedProvenance),
        );
      }
      if (input.completion === 'clear') {
        // The next worktree build owns the first completion. Keep the
        // publication counter but discard the source's measured projection.
        clearCodeGraphSummaryProjection(clonedDb);
      } else {
        // Root rebinding changes no graph facts or derived membership. Reuse
        // only a projection that still validates in the destination identity,
        // and publish a strictly newer destination revision.
        const priorProjection =
          readCodeGraphSummaryProjectionFromDatabase(clonedDb);
        if (priorProjection.state === 'ready') {
          publishCodeGraphSummaryProjection(clonedDb, {
            reuseProjection: priorProjection.projection,
          });
        } else if (
          priorProjection.state === 'pending' &&
          priorProjection.reason === 'projection-mismatch'
        ) {
          // A retained clone with a changed identity cannot reuse the copied
          // payload; remeasure it and advance the destination revision.
          publishCodeGraphSummaryProjection(clonedDb);
        } else {
          clearCodeGraphSummaryProjection(clonedDb);
        }
      }
    });
    if (input.targetValidation !== 'metadata-only' && !quickCheck(clonedDb)) {
      throw new Error('Cloned code-graph database failed SQLite quick_check.');
    }
    if (
      getMetadataValue(clonedDb, 'schema_version') !==
        String(CODE_GRAPH_SCHEMA_VERSION) ||
      (input.completion !== 'clear' &&
        getMetadataValue(clonedDb, 'completed_build_at') === null &&
        getMetadataValue(clonedDb, 'last_build_at') === null)
    ) {
      throw new Error('Cloned code-graph database metadata is incomplete.');
    }
    const reboundRepoIds = clonedDb
      .prepare('SELECT repo_id FROM repositories ORDER BY repo_id')
      .all()
      .map((value) => requireString(requireRow(value), 'repo_id'));
    if (
      reboundRepoIds.length !== targetRepoIds.length ||
      reboundRepoIds.some((repoId, index) => repoId !== targetRepoIds[index])
    ) {
      throw new Error('Cloned code-graph repository identity changed.');
    }
    clonedDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    clonedDb.close();
    clonedDb = undefined;
    const facts = installFacts(input);
    await fsyncPath(temporaryDbPath, facts.flushRequiresWriteHandle);

    const install = await installWorktreeGraphDatabase(
      temporaryDbPath,
      input.targetDbPath,
      facts,
    );
    if (install === 'busy') {
      return {
        installed: false,
        busy: true,
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      installed: install === 'installed',
      durationMs: Date.now() - startedAt,
    };
  } finally {
    try {
      sourceDb?.close();
    } catch {
      // Preserve the original clone failure.
    }
    try {
      clonedDb?.close();
    } catch {
      // Preserve the original clone failure.
    }
    await rm(temporaryDbPath, { force: true }).catch(() => undefined);
    await rm(`${temporaryDbPath}-wal`, { force: true }).catch(() => undefined);
    await rm(`${temporaryDbPath}-shm`, { force: true }).catch(() => undefined);
  }
}

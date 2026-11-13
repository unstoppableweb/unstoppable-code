import { createHash, randomUUID } from 'node:crypto';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { PipelineDefinitionRemote } from '@canopy/core-runtime/node/pipeline';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  isCuratedPipelineListResponse,
  readCuratedPipelineDetail,
  readCuratedPipelineListResponse,
  type CuratedPipelineDetail,
  type CuratedPipelineListResponse,
  type CuratedPipelineSummary,
} from '@canopy/protocol/pipeline-catalog';
import { isCuratedCatalogKey } from '@canopy/protocol/plugin-catalog';
import {
  API_PIPELINE_TRIGGER_TYPES,
  isPipelinePackageDigest,
  PIPELINE_EXECUTION_SCOPES,
  type PipelinePackageManifestV1,
  type PipelinePackageRef,
} from '@canopy/protocol/pipelines';
import {
  hashPipelinePackageYaml,
  installPipelinePackageAtomically,
  leasePipelinePackage,
  verifyCachedPipelinePackage,
} from '@canopy/desktop-shared/node';
import type {
  PipelineData,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import type { ExecutionOptions } from '@canopy/execution-engine/node/pipelines/executor';
import type {
  ImportCuratedPipelineRequest,
  ListCuratedPipelinesRequest,
  ListCuratedPipelinesResult,
} from '@canopy/desktop-shared/types/curated-pipelines';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { validateCuratedPipeline } from '@canopy/pipeline-interop';
import {
  requestCanopyCloudBinary,
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import {
  assertCurrentCuratedCatalogCredentials as assertCurrentCredentials,
  curatedCatalogCredentialIdentity as credentialIdentity,
  CuratedCatalogPageCache,
} from '../canopy-cloud/curated-catalog-cache';
import {
  getCuratedPipelinesCatalogFilePath,
  getPipelinePackageInstallStorePath,
  getPipelinePackagesDir,
} from '../lib/paths';
import { deletePipeline, savePipeline } from './pipeline-service';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { recordUserPipelineOwner } from './pipeline-local-metadata-store';
import { selectedOwnerContext } from './pipeline-owner-policy';
import { upsertPipelinePackageInstall } from './pipeline-package-install-store';
import { beginPipelineInstallIntent } from './pipeline-install-intents';
import {
  withPackageVersionNegotiation,
  type PipelinePackageDownload,
} from './canopy-server-client';

const PREFIX = `/api/v1/${BRAND.web.apiNamespace}/pipelines/curated`;
const PACKAGE_PREFIX = '/api/v1/curated-pipelines';
export const CURATED_PIPELINE_CACHE_TTL_MS = 5 * 60_000;
class InvalidCatalogResponseError extends Error {}

/** The catalog no longer advertises the requested curated workflow. */
export class CuratedPipelineMissingError extends InvalidCatalogResponseError {}
let manifestQueue: Promise<unknown> = Promise.resolve();
const imports = new Map<string, Promise<PipelineInfo>>();

interface ManagedCuratedPipelineData extends PipelineData {
  pipelinePackage?: NonNullable<ExecutionOptions['pipelinePackage']>;
}

interface RememberedCuratedPipelineSummary extends CuratedPipelineSummary {
  packageRef?: PipelinePackageRef;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Explicit projection also strips unexpected content fields from older/malformed servers. */
function summary(row: CuratedPipelineSummary): CuratedPipelineSummary {
  return {
    key: row.key,
    name: row.name,
    shortDescription: row.shortDescription,
    icon: row.icon,
    version: row.version,
    triggerTypes: [...row.triggerTypes],
    scopes: [...row.scopes],
    jobCount: row.jobCount,
    stepCount: row.stepCount,
    contentHash: row.contentHash,
    contentSizeBytes: row.contentSizeBytes,
    categories: [...row.categories],
    popular: row.popular,
    sortOrder: row.sortOrder,
    revision: row.revision,
    authorName: row.authorName,
    authorUrl: row.authorUrl,
    docsUrl: row.docsUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function queryString(input: ListCuratedPipelinesRequest): string {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid curated pipeline query.');
  const query = new URLSearchParams();
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid page size.');
  query.set('limit', String(limit));
  for (const [key, max] of [
    ['q', 256],
    ['category', 64],
    ['cursor', 2048],
  ] as const) {
    const value = input[key];
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.length > max)
    )
      throw new Error(`Invalid ${key}.`);
    if (value) query.set(key, value);
  }
  if (input.triggerType !== undefined) {
    if (
      !API_PIPELINE_TRIGGER_TYPES.some((value) => value === input.triggerType)
    )
      throw new Error('Invalid trigger.');
    query.set('triggerType', input.triggerType);
  }
  if (input.scope !== undefined) {
    if (!PIPELINE_EXECUTION_SCOPES.some((value) => value === input.scope))
      throw new Error('Invalid execution scope.');
    query.set('scope', input.scope);
  }
  if (
    input.forceRefresh !== undefined &&
    typeof input.forceRefresh !== 'boolean'
  )
    throw new Error('Invalid refresh request.');
  return query.toString();
}

const catalogCache = new CuratedCatalogPageCache<CuratedPipelineListResponse>({
  filePath: getCuratedPipelinesCatalogFilePath,
  isResponse: isCuratedPipelineListResponse,
  projectResponse: (response): CuratedPipelineListResponse => ({
    version: 1,
    data: response.data.map(summary),
    nextCursor: response.nextCursor,
  }),
});

export async function listCuratedPipelines(
  input: ListCuratedPipelinesRequest = {},
): Promise<ListCuratedPipelinesResult> {
  const query = queryString(input);
  const context = await resolveCanopyCloudCredentialContext();
  const cacheKey = `${credentialIdentity(context)}:${query}`;
  const cached = (await catalogCache.read()).find(
    (page) => page.query === cacheKey,
  );
  if (
    !input.forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < CURATED_PIPELINE_CACHE_TTL_MS
  ) {
    await assertCurrentCredentials(context);
    return { ...cached.response, stale: false };
  }
  try {
    const raw: unknown = await requestCanopyCloudJson(`${PREFIX}?${query}`, {
      credentialContext: context,
    });
    const list = readCuratedPipelineListResponse(raw);
    if (!list)
      throw new InvalidCatalogResponseError(
        'Invalid curated workflow catalog response.',
      );
    const response: CuratedPipelineListResponse = {
      version: 1,
      data: list.data.map(summary),
      nextCursor: list.nextCursor,
    };
    await assertCurrentCredentials(context);
    await catalogCache
      .write({ query: cacheKey, fetchedAt: Date.now(), response })
      .catch(() => undefined);
    return { ...response, stale: false };
  } catch (error) {
    await assertCurrentCredentials(context);
    if (
      error instanceof InvalidCatalogResponseError ||
      (record(error) &&
        typeof error.status === 'number' &&
        error.status >= 400 &&
        error.status < 500)
    )
      throw error;
    if (cached) return { ...cached.response, stale: true };
    throw error;
  }
}

function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length > 64 || !isCuratedCatalogKey(key))
    throw new Error('Invalid curated pipeline key.');
}

/** Detail is deliberately never served from the summary cache. */
async function fetchDetailUncached(
  key: string,
  context: CanopyCloudCredentialContext,
): Promise<CuratedPipelineDetail> {
  validateKey(key);
  const response: unknown = await requestCanopyCloudJson(
    `${PREFIX}/${encodeURIComponent(key)}/content`,
    { credentialContext: context },
  );
  await assertCurrentCredentials(context);
  const raw = readCuratedPipelineDetail(response);
  if (!raw || raw.key !== key)
    throw new Error('Invalid curated workflow content.');
  const bytes = Buffer.from(raw.rawPipeline, 'utf8');
  if (
    bytes.length !== raw.contentSizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== raw.contentHash
  ) {
    throw new Error(
      'Curated workflow content failed verification. Refresh the catalog and try again.',
    );
  }
  return {
    ...summary(raw),
    rawPipeline: raw.rawPipeline,
    ...(raw.package ? { package: raw.package } : {}),
  };
}

const detailReads = new Map<string, Promise<CuratedPipelineDetail>>();
async function fetchDetail(
  key: string,
  context: CanopyCloudCredentialContext,
): Promise<CuratedPipelineDetail> {
  validateKey(key);
  const identity = `${credentialIdentity(context)}:${key}`;
  const pending = detailReads.get(identity);
  if (pending) return pending;
  const operation = fetchDetailUncached(key, context);
  detailReads.set(identity, operation);
  void operation
    .finally(() => {
      if (detailReads.get(identity) === operation) detailReads.delete(identity);
    })
    .catch(() => undefined);
  return operation;
}

function cachedCuratedPackagePath(packageRef: PipelinePackageRef): string {
  return join(
    getPipelinePackagesDir(),
    'packages',
    packageRef.digest.slice('pp:v1:'.length),
  );
}

/** The verified manifest of an already-installed package, or undefined. */
async function cachedCuratedPackageManifest(
  packageRef: PipelinePackageRef | undefined,
): Promise<PipelinePackageManifestV1 | undefined> {
  if (!packageRef) return undefined;
  return (
    (await verifyCachedPipelinePackage(
      cachedCuratedPackagePath(packageRef),
      packageRef.digest,
    )) ?? undefined
  );
}

async function installCuratedPipelinePackage(
  key: string,
  rawPipeline: string,
  packageRef: PipelinePackageRef | undefined,
): Promise<ManagedCuratedPipelineData['pipelinePackage']> {
  if (!packageRef) return undefined;
  const cachedPackagePath = cachedCuratedPackagePath(packageRef);
  const cachedManifest = await cachedCuratedPackageManifest(packageRef);
  if (cachedManifest) {
    if (
      cachedManifest.pipelineContentHash !==
      hashPipelinePackageYaml(rawPipeline)
    ) {
      throw new Error(
        'Curated workflow package does not match its managed revision.',
      );
    }
    return {
      digest: packageRef.digest,
      rawPipeline,
      manifest: cachedManifest,
      cachedPackagePath,
    };
  }
  const query = new URLSearchParams({
    expectedPackageDigest: packageRef.digest,
  });
  const packageUrl = `${PACKAGE_PREFIX}/${encodeURIComponent(key)}/package?${query.toString()}`;
  const download = await withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<PipelinePackageDownload>(packageUrl, { headers }),
  );
  if (
    download.digest !== packageRef.digest ||
    download.manifest.pipelineContentHash !==
      hashPipelinePackageYaml(rawPipeline)
  ) {
    throw new Error(
      'Curated workflow package does not match its managed revision.',
    );
  }
  const installedPackagePath = await installPipelinePackageAtomically({
    packagesRoot: getPipelinePackagesDir(),
    digest: download.digest,
    manifest: download.manifest,
    fetchBlob: async (sha256) =>
      new Uint8Array(
        await withPackageVersionNegotiation((headers) =>
          requestCanopyCloudBinary(
            `${PACKAGE_PREFIX}/${encodeURIComponent(key)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
            { headers },
          ),
        ),
      ),
  });
  return {
    digest: download.digest,
    rawPipeline,
    manifest: download.manifest,
    cachedPackagePath: installedPackagePath,
  };
}

export async function getCuratedPipeline(
  key: string,
): Promise<CuratedPipelineDetail> {
  const context = await resolveCanopyCloudCredentialContext();
  const detail = await fetchDetail(key, context);
  // A packaged revision is validated against its package manifest, which the
  // managed read installs; publishing it here without one would re-reject the
  // `project/` actions and child pipelines the server accepted.
  if (!detail.package) await publishManagedRevision(detail, context);
  await rememberManagedSummary(key, detail, context, true);
  startManagedCuratedPipelineSync();
  return detail;
}

/**
 * A reviewed curated revision to install as an editable copy, read live from
 * the catalog rather than its managed cache. Core pins its content hash and
 * validates it; the package downloads only once the pin has passed.
 */
export async function readCuratedPipelineRemote(
  id: string,
): Promise<PipelineDefinitionRemote> {
  if (!id.startsWith('curated:'))
    throw new Error('Invalid curated pipeline id.');
  const key = id.slice('curated:'.length);
  validateKey(key);
  const context = await resolveCanopyCloudCredentialContext();
  const detail = await fetchDetail(key, context);
  const packageRef = detail.package
    ? { version: detail.package.version, digest: detail.package.digest }
    : undefined;
  let pipelinePackage: ManagedCuratedPipelineData['pipelinePackage'];
  return {
    document: {
      source: 'curated',
      definitionId: id,
      name: detail.name,
      description: detail.shortDescription,
      icon: detail.icon,
      readonly: true,
      revision: 0,
      owner: null,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      format: 'yaml',
      text: detail.rawPipeline,
    },
    remoteVersion: detail.contentHash,
    packageManifest: async () => {
      pipelinePackage = await installCuratedPipelinePackage(
        detail.key,
        detail.rawPipeline,
        packageRef,
      );
      return pipelinePackage?.manifest;
    },
    install: async (write) => {
      await assertCurrentCredentials(context);
      const intent = await beginPipelineInstallIntent('curated');
      // Held until the install record names the package, so another
      // install's rollback cannot remove it in between.
      const lease = packageRef
        ? leasePipelinePackage(getPipelinePackagesDir(), packageRef.digest)
        : undefined;
      let saved: PipelineInfo;
      try {
        if (pipelinePackage)
          pipelinePackage = await installCuratedPipelinePackage(
            detail.key,
            detail.rawPipeline,
            packageRef,
          );
        await intent.noteDefinition({
          definitionId: write.definitionId,
          change: 'created',
          contentHash: hashPipelinePackageYaml(write.text),
        });
        const result = savePipeline(
          {
            name: write.name,
            description: write.description,
            icon: write.icon,
            content: write.pipeline,
            rawContent: write.text,
            curatedOrigin: {
              key: detail.key,
              contentHash: detail.contentHash,
              revision: detail.revision,
              importedAt: new Date().toISOString(),
            },
          },
          { id: write.definitionId },
        );
        if (!result.success || !result.data)
          throw new Error(result.error ?? 'Failed to add curated workflow.');
        saved = result.data;
        if (pipelinePackage) {
          const record = {
            localPipelineId: saved.id,
            originExternalId: `curated:${detail.key}`,
            pipelineContentHash: pipelinePackage.manifest.pipelineContentHash,
            packageDigest: pipelinePackage.digest,
            installedAt: new Date().toISOString(),
          };
          await intent.noteInstallRecord(saved.id, record);
          try {
            await upsertPipelinePackageInstall(
              getPipelinePackageInstallStorePath(),
              record,
            );
          } catch (error) {
            deletePipeline(saved.id);
            throw error;
          }
        }
        await intent.finish();
      } catch (error) {
        await intent.rollBack().catch((rollbackError: unknown) => {
          logMainProcessWarn(
            '[curated-pipelines] Could not roll back a curated install',
            rollbackError,
          );
        });
        throw error;
      } finally {
        lease?.release();
      }
      return {
        source: 'user',
        definitionId: saved.id,
        name: saved.name,
        description: saved.description,
        icon: saved.icon,
        readonly: false,
        revision: saved.revision ?? 0,
        owner: null,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        format: 'yaml',
        text: write.text,
      };
    },
  };
}

/**
 * Adds a new editable copy through core. No existing pipeline, preferences
 * or execution are changed.
 */
export async function importCuratedPipeline(
  input: ImportCuratedPipelineRequest,
): Promise<PipelineInfo> {
  if (
    !record(input) ||
    typeof input.expectedContentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.expectedContentHash)
  ) {
    throw new Error('Invalid curated pipeline import request.');
  }
  validateKey(input.key);
  const context = await resolveCanopyCloudCredentialContext();
  const identity = `${credentialIdentity(context)}:${input.key}:${input.expectedContentHash}`;
  const pending = imports.get(identity);
  if (pending) return pending;
  const { expectedContentHash, key } = input;
  const operation = (async (): Promise<PipelineInfo> => {
    const { importRemotePipeline } =
      await import('../canopy-runtime/pipeline-definition-dispatch');
    let imported: PipelineInfo;
    try {
      imported = await importRemotePipeline({
        remoteDefinitionId: `curated:${key}`,
        expectedRemoteVersion: expectedContentHash,
        nameOverride: null,
      });
    } catch (error) {
      throw curatedImportError(error);
    }
    // A curated import keeps the owner it was added in. The import has
    // already been saved, so a missing owner is backfilled on first use
    // rather than failing it.
    try {
      recordUserPipelineOwner(imported.id, await selectedOwnerContext());
    } catch (error) {
      logMainProcessWarn(
        '[curated-pipelines] could not record the owner of an imported pipeline',
        error,
      );
    }
    return imported;
  })();
  imports.set(identity, operation);
  void operation
    .finally(() => {
      if (imports.get(identity) === operation) imports.delete(identity);
    })
    .catch(() => undefined);
  return operation;
}

/** Core's refusal in the words the catalog's callers have always shown. */
function curatedImportError(error: unknown): Error {
  if (!(error instanceof CanopyOperationError))
    return error instanceof Error ? error : new Error(String(error));
  if (error.payload.code === 'core.pipeline.remoteVersionConflict')
    return new Error(
      'This curated workflow changed. Refresh its preview before adding it.',
    );
  return new Error(error.payload.message);
}

/** Catalog identity is independent of downloads and cannot collide with local UUIDs. */
export function curatedPipelineInfo(row: CuratedPipelineSummary): PipelineInfo {
  return {
    id: `curated:${row.key}`,
    name: row.name,
    description: row.shortDescription,
    icon: row.icon,
    filename: `${row.key}.yaml`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    triggerTypes: row.triggerTypes,
    scopes: row.scopes,
    source: 'curated',
    readonly: true,
    curatedKey: row.key,
    curatedContentHash: row.contentHash,
    curatedRevision: row.revision,
  };
}

/** A managed read with the reviewed revision's exact bytes. */
export interface ManagedCuratedPipelineRead {
  data: ManagedCuratedPipelineData;
  rawPipeline: string;
}

const managedReads = new Map<string, Promise<ManagedCuratedPipelineRead>>();
let syncTimer: ReturnType<typeof setInterval> | undefined;
let syncing: Promise<void> | undefined;

function managedRoot(context: CanopyCloudCredentialContext): string {
  return join(
    dirname(getCuratedPipelinesCatalogFilePath()),
    'managed',
    credentialIdentity(context),
  );
}

function managedPath(
  row: CuratedPipelineSummary,
  context: CanopyCloudCredentialContext,
): string {
  return join(managedRoot(context), row.key, row.contentHash, 'pipeline.yaml');
}

function verifyManagedContent(
  rawPipeline: string,
  row: CuratedPipelineSummary,
  packageManifest?: PipelinePackageManifestV1,
): void {
  const bytes = Buffer.from(rawPipeline, 'utf8');
  if (
    bytes.length !== row.contentSizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== row.contentHash
  ) {
    throw new Error(
      'Curated workflow content failed verification. Refresh the catalog and try again.',
    );
  }
  // Same rule the server applied at publication: packaged `project/` actions
  // and child pipelines are accepted only when this manifest binds them.
  validateCuratedPipeline(rawPipeline, { packageManifest });
}

async function readManagedRevision(
  row: CuratedPipelineSummary,
  context: CanopyCloudCredentialContext,
  packageManifest?: PipelinePackageManifestV1,
): Promise<string | undefined> {
  try {
    const file = managedPath(row, context);
    if ((await stat(file)).size !== row.contentSizeBytes) return undefined;
    const raw = await readFile(file, 'utf8');
    verifyManagedContent(raw, row, packageManifest);
    return raw;
  } catch {
    return undefined;
  }
}

/** Never overwrite a valid revision: running jobs and resumed executions keep their exact files. */
async function publishManagedRevision(
  detail: CuratedPipelineDetail,
  context: CanopyCloudCredentialContext,
  packageManifest?: PipelinePackageManifestV1,
): Promise<string> {
  verifyManagedContent(detail.rawPipeline, detail, packageManifest);
  const file = managedPath(detail, context);
  if (await readManagedRevision(detail, context, packageManifest)) return file;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, detail.rawPipeline, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await assertCurrentCredentials(context);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return file;
}

/** Discovery only reads server-extracted metadata, including every page for trigger pickers. */
export async function listManagedCuratedPipelines(): Promise<PipelineInfo[]> {
  const context = await resolveCanopyCloudCredentialContext();
  const rows = new Map<string, PipelineInfo>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const page = await listCuratedPipelines({ limit: 100, cursor });
      await assertCurrentCredentials(context);
      for (const row of page.data) {
        if (
          !page.stale ||
          (await rememberedManagedSummary(row.key, context)) !== null
        )
          rows.set(row.key, curatedPipelineInfo(row));
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor))
        throw new InvalidCatalogResponseError(
          'Invalid repeated curated workflow page.',
        );
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return Array.from(rows.values());
  } catch (error) {
    await assertCurrentCredentials(context);
    if (catalogRequiresOnlineAuthorization(error)) throw error;
    // Downloaded entries remain discoverable after bounded browse caches expire.
    let keys: string[];
    try {
      keys = await readdir(managedRoot(context));
    } catch {
      throw error;
    }
    for (const key of keys) {
      if (!isCuratedCatalogKey(key)) continue;
      const row = await rememberedManagedSummary(key, context);
      if (row) rows.set(key, curatedPipelineInfo(row));
    }
    await assertCurrentCredentials(context);
    return Array.from(rows.values());
  }
}

async function rememberManagedSummary(
  key: string,
  row: CuratedPipelineSummary | CuratedPipelineDetail | null,
  context: CanopyCloudCredentialContext,
  preserveNewerObservation = false,
): Promise<void> {
  const operation = manifestQueue
    .catch(() => undefined)
    .then(async () => {
      // A legacy preview request can finish after a newer selected lookup or
      // denial. Persist its metadata immediately without rolling that state back.
      if (preserveNewerObservation && row) {
        const previous = await rememberedManagedSummary(key, context);
        if (previous === null || (previous && previous.revision > row.revision))
          return;
      }
      const previous = row
        ? await rememberedManagedSummary(key, context)
        : null;
      const packageRef =
        row && 'package' in row && row.package
          ? { version: row.package.version, digest: row.package.digest }
          : previous?.contentHash === row?.contentHash
            ? previous?.packageRef
            : undefined;
      const file = join(managedRoot(context), key, 'metadata.json');
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            version: 1,
            available: row !== null,
            summary: row ? summary(row) : null,
            ...(packageRef ? { packageRef } : {}),
          }),
          'utf8',
        );
        await assertCurrentCredentials(context);
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  manifestQueue = operation;
  await operation;
}

async function rememberedManagedSummary(
  key: string,
  context: CanopyCloudCredentialContext,
): Promise<RememberedCuratedPipelineSummary | null | undefined> {
  try {
    const file = join(managedRoot(context), key, 'metadata.json');
    if ((await stat(file)).size > 64 * 1024) return undefined;
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!record(value) || value.version !== 1) return undefined;
    if (value.available === false) return null;
    const response = { version: 1, data: [value.summary], nextCursor: null };
    if (
      value.available === true &&
      isCuratedPipelineListResponse(response) &&
      response.data[0].key === key
    ) {
      const packageRef = value.packageRef;
      return {
        ...response.data[0],
        ...(record(packageRef) &&
        packageRef.version === 1 &&
        isPipelinePackageDigest(packageRef.digest)
          ? {
              packageRef: {
                version: 1,
                digest: packageRef.digest,
              },
            }
          : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function catalogRequiresOnlineAuthorization(error: unknown): boolean {
  return (
    error instanceof InvalidCatalogResponseError ||
    (record(error) &&
      typeof error.status === 'number' &&
      error.status >= 400 &&
      error.status < 500)
  );
}

async function currentSummary(
  key: string,
  context: CanopyCloudCredentialContext,
): Promise<CuratedPipelineSummary> {
  let receivedMetadata = false;
  try {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await listCuratedPipelines({
        q: key,
        limit: 100,
        cursor,
        forceRefresh: true,
      });
      receivedMetadata = true;
      await assertCurrentCredentials(context);
      if (
        page.stale &&
        (await rememberedManagedSummary(key, context)) === null
      ) {
        throw new CuratedPipelineMissingError(
          'This curated workflow is no longer available. Refresh the workflow list.',
        );
      }
      const row = page.data.find((entry) => entry.key === key);
      if (row) {
        await rememberManagedSummary(key, row, context);
        return row;
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor))
        throw new InvalidCatalogResponseError(
          'Invalid repeated curated workflow page.',
        );
      if (cursor) cursors.add(cursor);
    } while (cursor);
    await rememberManagedSummary(key, null, context);
    throw new CuratedPipelineMissingError(
      'This curated workflow is no longer available. Refresh the workflow list.',
    );
  } catch (error) {
    await assertCurrentCredentials(context);
    if (catalogRequiresOnlineAuthorization(error)) {
      if (
        record(error) &&
        (error.status === 401 || error.status === 403 || error.status === 404)
      )
        await rememberManagedSummary(key, null, context);
      throw error;
    }
    // A persistence/pagination failure after observing metadata must not select
    // an older revision from disk. Only unavailable metadata permits fallback.
    if (receivedMetadata) throw error;
    // Downloaded metadata is durable independently of bounded browse-page caches.
    // It tracks the latest advertised hash, including a failed newer download.
    const remembered = await rememberedManagedSummary(key, context);
    if (remembered) return remembered;
    if (remembered === null)
      throw new Error(
        'This curated workflow is no longer available. Refresh the workflow list.',
      );
    throw error;
  }
}

/** Refresh metadata before use; content downloads occur only for a missing/changed selected revision. */
export async function getManagedCuratedPipeline(
  id: string,
): Promise<ManagedCuratedPipelineData> {
  return (await readManagedCuratedPipeline(id)).data;
}

/** {@link getManagedCuratedPipeline}, with the bytes its content hash covers. */
export async function readManagedCuratedPipeline(
  id: string,
): Promise<ManagedCuratedPipelineRead> {
  if (!id.startsWith('curated:'))
    throw new Error('Invalid curated pipeline id.');
  const key = id.slice('curated:'.length);
  validateKey(key);
  const context = await resolveCanopyCloudCredentialContext();
  const identity = `${credentialIdentity(context)}:${key}`;
  const pending = managedReads.get(identity);
  if (pending) return pending;
  const operation = (async (): Promise<ManagedCuratedPipelineRead> => {
    let row = await currentSummary(key, context);
    await assertCurrentCredentials(context);
    const remembered = await rememberedManagedSummary(key, context);
    let packageRef =
      remembered?.contentHash === row.contentHash
        ? remembered.packageRef
        : undefined;
    let rawPipeline = await readManagedRevision(
      row,
      context,
      await cachedCuratedPackageManifest(packageRef),
    );
    let pipelinePackage: ManagedCuratedPipelineData['pipelinePackage'];
    if (!rawPipeline) {
      // Detail is a coherent revision. If publication raced the metadata request,
      // accept it only after confirming it is still the advertised revision.
      const detail = await fetchDetail(key, context);
      if (
        detail.contentHash !== row.contentHash ||
        detail.contentSizeBytes !== row.contentSizeBytes
      ) {
        row = await currentSummary(key, context);
        if (
          row.contentHash !== detail.contentHash ||
          row.contentSizeBytes !== detail.contentSizeBytes
        ) {
          throw new Error(
            'This curated workflow changed while downloading. Try again.',
          );
        }
      }
      packageRef = detail.package
        ? { version: detail.package.version, digest: detail.package.digest }
        : undefined;
      // Install first so the revision is validated against its manifest
      // before it is published; invalid content is still never published.
      pipelinePackage = await installCuratedPipelinePackage(
        key,
        detail.rawPipeline,
        packageRef,
      );
      await publishManagedRevision(detail, context, pipelinePackage?.manifest);
      await rememberManagedSummary(key, detail, context, true);
      rawPipeline = detail.rawPipeline;
    } else {
      pipelinePackage = await installCuratedPipelinePackage(
        key,
        rawPipeline,
        packageRef,
      );
    }
    await assertCurrentCredentials(context);
    startManagedCuratedPipelineSync();
    return {
      data: {
        info: {
          ...curatedPipelineInfo(row),
          filePath: managedPath(row, context),
        },
        content: parsePipelineText(rawPipeline),
        ...(pipelinePackage ? { pipelinePackage } : {}),
      },
      rawPipeline,
    };
  })();
  managedReads.set(identity, operation);
  void operation
    .finally(() => {
      if (managedReads.get(identity) === operation)
        managedReads.delete(identity);
    })
    .catch(() => undefined);
  return operation;
}

/**
 * Only previously downloaded keys are synchronized; undiscovered bodies stay
 * remote. Each refresh is a core read of the curated definition, so core's
 * curated source decides what is downloaded and validates the revision.
 */
export function syncManagedCuratedPipelines(): Promise<void> {
  if (syncing) return syncing;
  const operation = (async (): Promise<void> => {
    const context = await resolveCanopyCloudCredentialContext();
    let keys: string[];
    try {
      keys = await readdir(managedRoot(context));
    } catch {
      return;
    }
    const { getPipelineDefinition, PIPELINE_DEFINITION_DESKTOP_CALLER } =
      await import('../canopy-runtime/pipeline-definition-dispatch');
    for (const key of keys) {
      await assertCurrentCredentials(context);
      if (isCuratedCatalogKey(key))
        await getPipelineDefinition(
          `curated:${key}`,
          {},
          PIPELINE_DEFINITION_DESKTOP_CALLER,
        ).catch(() => undefined);
    }
  })();
  syncing = operation;
  void operation
    .finally(() => {
      if (syncing === operation) syncing = undefined;
    })
    .catch(() => undefined);
  return operation;
}

/** Owned by the desktop catalog lifecycle; no startup network work or eager content fetches. */
export function startManagedCuratedPipelineSync(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    void syncManagedCuratedPipelines().catch(() => undefined);
  }, 5 * 60_000);
  syncTimer.unref();
}

export function stopManagedCuratedPipelineSync(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = undefined;
}

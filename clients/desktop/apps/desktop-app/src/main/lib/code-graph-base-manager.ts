import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import {
  cleanupCodeGraphBaseStaging,
  installCodeGraphBaseGeneration,
  prepareCodeGraphBaseStaging,
  readPublishedCodeGraphBase,
  type CodeGraphBaseIdentity,
  type ValidatedCodeGraphBase,
} from '@canopy/code-graph/base-graph';
import {
  CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_MAX_BYTES,
  CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_RELATIVE_PATH,
  CODE_GRAPH_CUSTOM_TAGS_MAX_BYTES,
  CODE_GRAPH_CUSTOM_WASM_MAX_BYTES,
  CODE_GRAPH_NO_CUSTOM_LANGUAGES_FINGERPRINT,
  customLanguagesConfigPath,
  fingerprintCustomLanguageInputs,
  parseCustomLanguagesConfig,
  readBoundedCodeGraphCustomLanguageFile,
  validateCustomLanguageEntries,
} from '@canopy/code-graph/languages/custom-config';
import { CodeGraphIoError } from '@canopy/code-graph/io-failure';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { getBundledCodeGraphDir } from '@canopy/execution-engine/pipelines/config-paths';
import { writeFileAtomically } from './atomic-file';
import {
  cancelCodeGraphBaseMaintenance,
  runCodeGraphBaseMaintenance,
} from '../code-graph/base-maintenance-runs';
import {
  cancelBuild,
  beginCodeGraphWorkerBuild,
  CodeGraphWorkerBuildError,
  type CodeGraphWorkerBuildResponse,
  updateCodeGraphBuildOwners,
} from '../code-graph/build-runner';
import {
  runCodeGraphWorkerRead,
  type CodeGraphBaseIdentityReadResult,
} from '../code-graph/read-runner';
import { getHeadCommitSha } from './git';
import { getDataDir } from './paths';
import {
  RepoShadowEnsureCanceledError,
  setRepoShadowRetirementHandler,
  withEnsuredRepoShadow,
} from './repo-shadow';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import {
  CODE_GRAPH_UNAVAILABLE_MESSAGE,
  isCodeGraphAvailableForWorkspace,
} from './code-graph-availability';
import { recordRealisticStartupPerformanceEvent } from './realistic-startup-performance';
import {
  codeGraphBuildResultDetail,
  recordCodeGraphBuildDiagnostic,
} from './code-graph-build-diagnostics';
import type { CodeGraphBuildDiagnosticDetail } from '../observability/service';
import {
  codeGraphBaseRunnerKey,
  codeGraphBaseVariantDir,
  allowCodeGraphBaseVariants,
  retireCodeGraphBaseVariants,
  withCodeGraphBaseVariantLock,
} from './code-graph-base-store';

export interface DesiredBaseRepository {
  repoId: string;
  repoPath: string;
}

export interface DesiredBaseWorkspace {
  workspaceId: string;
  customLanguageRepoPath: string | null;
  repositories: DesiredBaseRepository[];
}

export interface CodeGraphBaseMaintenanceOutcome {
  repoId: string;
  ok: boolean;
  message?: string;
}

const SNAPSHOT_COMPLETE_FILE = '.complete';
const desiredWorkspaces = new Map<string, DesiredBaseWorkspace>();
const preparedCustomLanguageFingerprints = new Map<string, string>();
const activeCustomLanguageSnapshotMaterializations = new Map<
  string,
  Promise<string>
>();
const activeBaseKeysByRepo = new Map<string, Set<string>>();
const activeMaintenance = new Map<
  string,
  Promise<CodeGraphBaseMaintenanceOutcome>
>();
const activeMaintenanceOwners = new Map<string, Set<string>>();
const baseSummaryRepairAttempts = new Map<
  string,
  Promise<CodeGraphBaseMaintenanceOutcome>
>();
const baseSummaryRepairVariants = new Map<
  string,
  Promise<CodeGraphBaseMaintenanceOutcome>
>();
const baseSummaryRepairVariantOwners = new Map<string, Set<string>>();
const baseSummaryRepairCooldownUntil = new Map<string, number>();
const BASE_SUMMARY_REPAIR_COOLDOWN_MS = 5 * 60 * 1_000;
interface ActiveShadowPreparation {
  ownerWorkspaceIds: Set<string>;
  controller: AbortController;
}

function codeGraphBaseBuildPriority(
  forceRefresh: boolean,
): 'agent' | 'maintenance' {
  return forceRefresh ? 'agent' : 'maintenance';
}
const activeShadowPreparationControllers = new Map<
  string,
  ActiveShadowPreparation
>();
const retiringRepoRoots = new Set<string>();
let started = false;
let stopped = false;
let dirty = false;
let cyclePromise: Promise<void> | null = null;
let cycleTimer: NodeJS.Timeout | null = null;
let periodicTimer: NodeJS.Timeout | null = null;
const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
// Base maintenance is opportunistic background work. Give latency-sensitive
// startup, project hydration, and worktree creation a chance to settle before
// cloning shadows or starting parser workers for the first time.
const MAINTENANCE_START_DELAY_MS = 10_000;

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function snapshotRoot(fingerprint: string): string {
  return path.join(getDataDir(), 'code-graph-language-snapshots', fingerprint);
}

function workspaceFingerprintPath(workspaceId: string): string {
  const workspaceKey = createHash('sha256').update(workspaceId).digest('hex');
  return path.join(
    getDataDir(),
    'code-graph-workspace-fingerprints',
    workspaceKey,
  );
}

async function persistPreparedCustomLanguageFingerprint(
  workspaceId: string,
  fingerprint: string,
): Promise<void> {
  const fingerprintPath = workspaceFingerprintPath(workspaceId);
  await mkdir(path.dirname(fingerprintPath), { recursive: true });
  await writeFileAtomically(fingerprintPath, fingerprint);
  preparedCustomLanguageFingerprints.set(workspaceId, fingerprint);
}

function removePersistedCustomLanguageFingerprint(workspaceId: string): void {
  void Promise.resolve()
    .then(() => rm(workspaceFingerprintPath(workspaceId), { force: true }))
    .catch(() => undefined);
}

async function readPersistedCustomLanguageFingerprint(
  workspaceId: string,
): Promise<string | null> {
  const fingerprint = await readFile(
    workspaceFingerprintPath(workspaceId),
    'utf8',
  )
    .then((value) => value.trim())
    .catch(() => null);
  if (fingerprint === null || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    return null;
  }
  preparedCustomLanguageFingerprints.set(workspaceId, fingerprint);
  return fingerprint;
}

async function snapshotExists(root: string): Promise<boolean> {
  try {
    await access(path.join(root, SNAPSHOT_COMPLETE_FILE));
    return true;
  } catch {
    return false;
  }
}

function materializeCustomLanguageSnapshot(
  sourceRoot: string | null,
  fingerprint: string,
): Promise<string> {
  const active = activeCustomLanguageSnapshotMaterializations.get(fingerprint);
  if (active !== undefined) {
    return active;
  }
  const materialization = performCustomLanguageSnapshotMaterialization(
    sourceRoot,
    fingerprint,
  );
  activeCustomLanguageSnapshotMaterializations.set(
    fingerprint,
    materialization,
  );
  const clearActiveMaterialization = (): void => {
    if (
      activeCustomLanguageSnapshotMaterializations.get(fingerprint) ===
      materialization
    ) {
      activeCustomLanguageSnapshotMaterializations.delete(fingerprint);
    }
  };
  void materialization.then(
    clearActiveMaterialization,
    clearActiveMaterialization,
  );
  return materialization;
}

async function performCustomLanguageSnapshotMaterialization(
  sourceRoot: string | null,
  fingerprint: string,
): Promise<string> {
  const destination = snapshotRoot(fingerprint);
  if (await snapshotExists(destination)) {
    return destination;
  }
  const staging = `${destination}.staging-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    if (sourceRoot !== null) {
      const sourceConfigPath = customLanguagesConfigPath(sourceRoot);
      const realSourceRoot = await realpath(sourceRoot).catch(() =>
        path.resolve(sourceRoot),
      );
      const expectedConfigPath = path.join(
        realSourceRoot,
        ...CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_RELATIVE_PATH.split('/'),
      );
      const configRead = await readBoundedCodeGraphCustomLanguageFile(
        sourceConfigPath,
        expectedConfigPath,
        CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_MAX_BYTES,
      );
      if (configRead.kind === 'present') {
        const configBytes = configRead.bytes;
        const destinationConfigPath = customLanguagesConfigPath(staging);
        await mkdir(path.dirname(destinationConfigPath), { recursive: true });
        await writeFile(destinationConfigPath, configBytes);
        const parsed = parseCustomLanguagesConfig(configBytes.toString('utf8'));
        if (parsed.ok) {
          const configDir = path.dirname(sourceConfigPath);
          const realConfigDir = path.dirname(expectedConfigPath);
          const destinationConfigDir = path.dirname(destinationConfigPath);
          const { entries } = validateCustomLanguageEntries(parsed.rawEntries);
          const referencedPaths = new Map<string, number>();
          for (const entry of entries) {
            referencedPaths.set(
              entry.wasmFile,
              Math.max(
                referencedPaths.get(entry.wasmFile) ?? 0,
                CODE_GRAPH_CUSTOM_WASM_MAX_BYTES,
              ),
            );
            for (const tagsFile of entry.tagsFiles) {
              referencedPaths.set(
                tagsFile,
                Math.max(
                  referencedPaths.get(tagsFile) ?? 0,
                  CODE_GRAPH_CUSTOM_TAGS_MAX_BYTES,
                ),
              );
            }
          }
          const orderedPaths = Array.from(referencedPaths.entries()).sort(
            ([a], [b]) => a.localeCompare(b),
          );
          for (const [relativePath, maxBytes] of orderedPaths) {
            const fileRead = await readBoundedCodeGraphCustomLanguageFile(
              path.resolve(configDir, relativePath),
              path.resolve(realConfigDir, relativePath),
              maxBytes,
            );
            if (fileRead.kind !== 'present') {
              continue;
            }
            const destinationPath = path.resolve(
              destinationConfigDir,
              relativePath,
            );
            await mkdir(path.dirname(destinationPath), { recursive: true });
            await writeFile(destinationPath, fileRead.bytes);
          }
        }
      }
    }
    const capturedFingerprint = await fingerprintCustomLanguageInputs(staging);
    if (capturedFingerprint.value !== fingerprint) {
      throw new Error(
        'Custom-language snapshot fingerprint changed while copying.',
      );
    }
    await writeFile(path.join(staging, SNAPSHOT_COMPLETE_FILE), fingerprint);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(staging, destination).catch(async (error: unknown) => {
      if (await snapshotExists(destination)) {
        return;
      }
      // A process can be interrupted after creating an older snapshot but
      // before writing its completion marker. Such a directory is never a
      // valid destination and prevents the atomic rename on macOS. Remove it
      // and retry; if another writer wins that race, accept its complete copy.
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination).catch(
        async (retryError: unknown): Promise<void> => {
          if (!(await snapshotExists(destination))) {
            throw retryError ?? error;
          }
        },
      );
    });
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function prepareWorkspaceCustomLanguages(
  workspace: DesiredBaseWorkspace,
  options?: { forceRefresh?: boolean },
): Promise<{ fingerprint: string; snapshotPath: string } | null> {
  if (!isCodeGraphAvailableForWorkspace(workspace.workspaceId)) {
    return null;
  }
  if (workspace.customLanguageRepoPath === null) {
    const prepared = {
      fingerprint: CODE_GRAPH_NO_CUSTOM_LANGUAGES_FINGERPRINT,
      snapshotPath: await materializeCustomLanguageSnapshot(
        null,
        CODE_GRAPH_NO_CUSTOM_LANGUAGES_FINGERPRINT,
      ),
    };
    await persistPreparedCustomLanguageFingerprint(
      workspace.workspaceId,
      prepared.fingerprint,
    );
    return prepared;
  }
  const preparationKey = `custom-languages:${workspace.workspaceId}:${randomUUID()}`;
  const controller = new AbortController();
  try {
    activeShadowPreparationControllers.set(preparationKey, {
      ownerWorkspaceIds: new Set([workspace.workspaceId]),
      controller,
    });
    const prepared = await withEnsuredRepoShadow(
      workspace.customLanguageRepoPath,
      {
        maxAgeMs: options?.forceRefresh ? 0 : MAINTENANCE_INTERVAL_MS,
        bypassFailureCache: options?.forceRefresh === true,
        shouldContinue: () =>
          !stopped && isCodeGraphAvailableForWorkspace(workspace.workspaceId),
        signal: controller.signal,
      },
      async (shadow) => {
        if (
          stopped ||
          !isCodeGraphAvailableForWorkspace(workspace.workspaceId)
        ) {
          return null;
        }
        const fingerprint = await fingerprintCustomLanguageInputs(
          shadow.shadowPath,
        );
        return {
          fingerprint: fingerprint.value,
          snapshotPath: await materializeCustomLanguageSnapshot(
            shadow.shadowPath,
            fingerprint.value,
          ),
        };
      },
    );
    if (prepared !== null) {
      await persistPreparedCustomLanguageFingerprint(
        workspace.workspaceId,
        prepared.fingerprint,
      );
    }
    return prepared;
  } catch {
    return null;
  } finally {
    if (
      activeShadowPreparationControllers.get(preparationKey)?.controller ===
      controller
    ) {
      activeShadowPreparationControllers.delete(preparationKey);
    }
  }
}

function trackActiveBaseKey(repoRoot: string, key: string): void {
  const keys = activeBaseKeysByRepo.get(repoRoot) ?? new Set<string>();
  keys.add(key);
  activeBaseKeysByRepo.set(repoRoot, keys);
}

function untrackActiveBaseKey(repoRoot: string, key: string): void {
  const keys = activeBaseKeysByRepo.get(repoRoot);
  keys?.delete(key);
  if (keys?.size === 0) {
    activeBaseKeysByRepo.delete(repoRoot);
  }
}

function availableOwnerWorkspaceIds(workspaceIds: readonly string[]): string[] {
  return Array.from(
    new Set(
      workspaceIds
        .map((id) => id.trim())
        .filter(Boolean)
        .filter(isCodeGraphAvailableForWorkspace),
    ),
  );
}

async function workspaceOwnersForRepositoryVariant(
  repository: DesiredBaseRepository,
  customLanguagesFingerprint: string,
  canonicalRepoRoot: string,
): Promise<string[]> {
  const owners: string[] = [];
  for (const workspace of Array.from(desiredWorkspaces.values())) {
    if (
      preparedCustomLanguageFingerprints.get(workspace.workspaceId) !==
        customLanguagesFingerprint ||
      !isCodeGraphAvailableForWorkspace(workspace.workspaceId)
    ) {
      continue;
    }
    for (const candidate of workspace.repositories) {
      if (candidate.repoId !== repository.repoId) continue;
      const candidateCanonicalRoot =
        candidate.repoPath === repository.repoPath
          ? canonicalRepoRoot
          : await resolveWorkspaceReferenceRepoPath(candidate.repoPath).catch(
              () => null,
            );
      if (candidateCanonicalRoot === canonicalRepoRoot) {
        owners.push(workspace.workspaceId);
        break;
      }
    }
  }
  return availableOwnerWorkspaceIds(owners);
}

/**
 * The current generation from its manifest, once the read worker confirms its
 * database carries that identity. Main never opens the database, but a
 * generation it cannot vouch for must not be skipped as current or copied into
 * the next build, where finalization would reject every incremental rebuild.
 * A rejected generation yields null, so maintenance rebuilds from scratch.
 */
/** Readonly admission decision only: never opens a writer or validates graph facts. */
async function publishedSummaryRepairState(
  runnerKey: string,
  dbPath: string,
  diagnosticOwner?: string,
): Promise<'ready' | 'pending' | 'unavailable'> {
  try {
    const summary = await runCodeGraphWorkerRead({
      key: runnerKey,
      kind: 'base-validation',
      ...(diagnosticOwner === undefined
        ? {}
        : { diagnosticOwner: { projectId: diagnosticOwner, worktreeId: '' } }),
      request: { dbPath, task: { kind: 'readonly-summary' } },
    });
    if (!summary.ok || summary.result.kind !== 'readonly-summary')
      return 'unavailable';
    const projection = summary.result.value;
    return projection.state === 'ready' || projection.state === 'pending'
      ? projection.state
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

async function readUsableCodeGraphBase(
  runnerKey: string,
  variantDir: string,
  identity: CodeGraphBaseIdentity,
  diagnosticOwner: string | undefined,
): Promise<ValidatedCodeGraphBase | null> {
  const published = await readPublishedCodeGraphBase({
    variantDir,
    identity,
    validation: 'manifest-only',
  });
  if (published === null) {
    return null;
  }
  const diagnostic =
    diagnosticOwner === undefined
      ? undefined
      : { projectId: diagnosticOwner, worktreeId: '' };
  const response = await runCodeGraphWorkerRead({
    key: runnerKey,
    kind: 'base-validation',
    ...(diagnostic === undefined ? {} : { diagnosticOwner: diagnostic }),
    request: {
      dbPath: published.dbPath,
      task: {
        kind: 'base-identity',
        identity,
        gitHead: published.manifest.gitHead,
      },
    },
  });
  if (!response.ok) {
    throw new Error(response.message);
  }
  if (response.result.kind !== 'base-identity') {
    throw new Error('Code-graph read worker returned an unexpected result.');
  }
  const identityRead: CodeGraphBaseIdentityReadResult = response.result.value;
  if (identityRead.state === 'readable') {
    const matches = identityRead.matches;
    return matches.schema &&
      matches.extractor &&
      matches.canonicalRoot &&
      matches.customLanguagesFingerprint &&
      matches.repoId &&
      matches.gitHead &&
      matches.completed
      ? published
      : null;
  }
  if (identityRead.state === 'missing') return null;

  // Preserve the existing full validator as a fallback when the metadata-only
  // probe cannot safely decide (e.g. older or damaged schemas).
  const fallback = await runCodeGraphWorkerRead({
    key: runnerKey,
    kind: 'base-validation',
    ...(diagnostic === undefined ? {} : { diagnosticOwner: diagnostic }),
    request: {
      dbPath: published.dbPath,
      task: {
        kind: 'validate-base',
        identity,
        gitHead: published.manifest.gitHead,
      },
    },
  });
  if (!fallback.ok) throw new Error(fallback.message);
  if (fallback.result.kind !== 'validate-base') {
    throw new Error('Code-graph read worker returned an unexpected result.');
  }
  return fallback.result.value ? published : null;
}

async function maintainBase(
  repository: DesiredBaseRepository,
  customLanguages: { fingerprint: string; snapshotPath: string },
  options?: {
    ownerWorkspaceIds?: readonly string[];
    forceRefresh?: boolean;
    summaryProjectionRepair?: true;
  },
): Promise<CodeGraphBaseMaintenanceOutcome> {
  const requestedOwnerWorkspaceIds =
    options?.ownerWorkspaceIds ??
    Array.from(desiredWorkspaces.values())
      .filter((workspace) =>
        workspace.repositories.some(
          (candidate) =>
            candidate.repoId === repository.repoId &&
            candidate.repoPath === repository.repoPath,
        ),
      )
      .map((workspace) => workspace.workspaceId);
  const canonicalRepoRoot = await resolveWorkspaceReferenceRepoPath(
    repository.repoPath,
  );
  const ownerWorkspaceIds = availableOwnerWorkspaceIds([
    ...requestedOwnerWorkspaceIds.filter((workspaceId) =>
      desiredWorkspaces.has(workspaceId),
    ),
    ...(await workspaceOwnersForRepositoryVariant(
      repository,
      customLanguages.fingerprint,
      canonicalRepoRoot,
    )),
  ]);
  if (ownerWorkspaceIds.length === 0) {
    return {
      repoId: repository.repoId,
      ok: false,
      message: CODE_GRAPH_UNAVAILABLE_MESSAGE,
    };
  }
  if (stopped || retiringRepoRoots.has(canonicalRepoRoot)) {
    return {
      repoId: repository.repoId,
      ok: false,
      message: 'Code graph maintenance is no longer required.',
    };
  }
  const runnerKey = codeGraphBaseRunnerKey(canonicalRepoRoot, {
    repoId: repository.repoId,
    customLanguagesFingerprint: customLanguages.fingerprint,
  });
  const existing = activeMaintenance.get(runnerKey);
  if (existing !== undefined) {
    const owners = activeMaintenanceOwners.get(runnerKey) ?? new Set<string>();
    for (const owner of ownerWorkspaceIds) owners.add(owner);
    activeMaintenanceOwners.set(runnerKey, owners);
    updateCodeGraphBuildOwners(
      runnerKey,
      Array.from(owners).filter(isCodeGraphAvailableForWorkspace),
    );
    return await existing;
  }
  const activeOwners = new Set(ownerWorkspaceIds);
  activeMaintenanceOwners.set(runnerKey, activeOwners);
  const shadowPreparationController = new AbortController();
  activeShadowPreparationControllers.set(runnerKey, {
    ownerWorkspaceIds: activeOwners,
    controller: shadowPreparationController,
  });
  const enabledOwners = (): string[] =>
    availableOwnerWorkspaceIds(Array.from(activeOwners));
  trackActiveBaseKey(canonicalRepoRoot, runnerKey);
  recordRealisticStartupPerformanceEvent(
    'startup:code-graph-base:repo-started',
    {
      ownerCount: ownerWorkspaceIds.length,
      forced: options?.forceRefresh === true,
    },
  );

  const maintenance = withEnsuredRepoShadow(
    repository.repoPath,
    {
      maxAgeMs: options?.forceRefresh ? 0 : MAINTENANCE_INTERVAL_MS,
      bypassFailureCache: options?.forceRefresh === true,
      shouldContinue: () =>
        !stopped &&
        !retiringRepoRoots.has(canonicalRepoRoot) &&
        enabledOwners().length > 0,
      signal: shadowPreparationController.signal,
    },
    async (shadow) => {
      if (
        stopped ||
        retiringRepoRoots.has(shadow.repoPath) ||
        enabledOwners().length === 0
      ) {
        return {
          repoId: repository.repoId,
          ok: false,
          message: CODE_GRAPH_UNAVAILABLE_MESSAGE,
        };
      }
      const identity = {
        repoId: repository.repoId,
        canonicalRepoRoot: shadow.repoPath,
        customLanguagesFingerprint: customLanguages.fingerprint,
      };
      const variantDir = codeGraphBaseVariantDir(shadow.repoPath, identity);
      const gitHead = await getHeadCommitSha(shadow.shadowPath);
      // Main reads the manifest; the read worker checks the generation's
      // identifying rows before it is trusted as current or as a seed.
      let published = await withCodeGraphBaseVariantLock(
        variantDir,
        async () => {
          await cleanupCodeGraphBaseStaging(variantDir);
          return readUsableCodeGraphBase(
            runnerKey,
            variantDir,
            identity,
            enabledOwners()[0],
          );
        },
      );
      if (
        options?.summaryProjectionRepair === true &&
        published !== null &&
        published.manifest.gitHead === gitHead
      ) {
        const state = await publishedSummaryRepairState(
          runnerKey,
          published.dbPath,
          enabledOwners()[0],
        );
        if (
          stopped ||
          retiringRepoRoots.has(canonicalRepoRoot) ||
          enabledOwners().length === 0
        ) {
          return {
            repoId: repository.repoId,
            ok: false,
            message: CODE_GRAPH_UNAVAILABLE_MESSAGE,
          };
        }
        if (state === 'ready') return { repoId: repository.repoId, ok: true };
        if (state === 'unavailable') {
          return {
            repoId: repository.repoId,
            ok: false,
            message: 'The retained code-graph summary could not be verified.',
          };
        }
        // Only a confirmed pending projection reaches staging. Published bytes
        // remain readonly and all ordinary activeMaintenance/variant fences apply.
      }
      if (
        published?.manifest.gitHead === gitHead &&
        options?.summaryProjectionRepair !== true
      ) {
        return { repoId: repository.repoId, ok: true };
      }
      const mode = published === null ? 'cold' : 'incremental';
      recordRealisticStartupPerformanceEvent(
        'startup:code-graph-base:worker-started',
        { mode },
      );
      const trigger =
        options?.summaryProjectionRepair === true
          ? 'summary-projection-repair'
          : options?.forceRefresh
            ? 'manual-shadow-refresh'
            : 'shadow-maintenance';
      const buildStartedAt = performance.now();
      let buildAttemptId: string | undefined;
      const recordBaseBuild = (
        outcome: 'success' | 'failure',
        extra: Partial<CodeGraphBuildDiagnosticDetail> = {},
      ): void => {
        // Local diagnostic for this base build.
        recordCodeGraphBuildDiagnostic({
          projectId: enabledOwners()[0] ?? ownerWorkspaceIds[0] ?? '',
          worktreeId: '',
          detail: {
            scope: 'base',
            trigger,
            outcome,
            ...(buildAttemptId === undefined
              ? {}
              : { attemptId: buildAttemptId }),
            repoId: repository.repoId,
            totalMs: roundMs(performance.now() - buildStartedAt),
            ...extra,
          },
        });
      };
      // Cloning the published generation into staging is this build's copy.
      let seedCopyMs = 0;
      const staging = await withCodeGraphBaseVariantLock(
        variantDir,
        async () => {
          const copyStartedAt = performance.now();
          try {
            return await prepareCodeGraphBaseStaging({
              variantDir,
              sourceDbPath: published?.dbPath,
            });
          } finally {
            seedCopyMs = performance.now() - copyStartedAt;
          }
        },
      ).catch(() => {
        recordBaseBuild('failure', { failureStage: 'seed-preparation' });
        return null;
      });
      if (staging === null) {
        return {
          repoId: repository.repoId,
          ok: false,
          message: 'Failed to prepare the published graph for updating.',
        };
      }
      let failureStage: 'worker-build' | 'publication' = 'worker-build';
      // The worker's closed class and errno; its message stays in process.
      let workerFailure: Partial<CodeGraphBuildDiagnosticDetail> = {};
      try {
        if (enabledOwners().length === 0) {
          throw new CodeGraphWorkerBuildError(
            'unavailable',
            CODE_GRAPH_UNAVAILABLE_MESSAGE,
          );
        }
        const buildHandle = beginCodeGraphWorkerBuild(
          runnerKey,
          {
            dbPath: staging.dbPath,
            worktreeRootPath: shadow.shadowPath,
            customLanguagesRootPath: customLanguages.snapshotPath,
            resourcesDir: getBundledCodeGraphDir(),
            repositories: [
              { repoId: repository.repoId, rootPath: shadow.shadowPath },
            ],
            options: {},
            baseFinalization: {
              identity,
              gitHead,
              ...(options?.summaryProjectionRepair === true
                ? { repairSummaryProjection: true }
                : {}),
            },
            timings: { seedCopyMs: roundMs(seedCopyMs) },
          },
          {
            priority: codeGraphBaseBuildPriority(
              options?.forceRefresh === true,
            ),
            metadata: {
              scope: 'workspace-shadow',
              workspaceIds: enabledOwners(),
              repositoryId: repository.repoId,
              label: path.basename(repository.repoPath),
              trigger,
            },
          },
        );
        buildAttemptId = buildHandle.attemptId ?? undefined;
        let response: CodeGraphWorkerBuildResponse;
        try {
          response = await buildHandle.promise;
        } finally {
          buildAttemptId = buildHandle.attemptId ?? undefined;
        }
        if (!response.ok) {
          workerFailure = {
            ...(response.failureClass === undefined
              ? {}
              : { failureClass: response.failureClass }),
            ...(response.errno === undefined ? {} : { errno: response.errno }),
          };
          throw new Error(response.message);
        }
        if (response.baseFinalized !== true) {
          throw new Error(
            'The code graph worker did not finalize the base for publication.',
          );
        }
        if (enabledOwners().length === 0) {
          throw new CodeGraphWorkerBuildError(
            'unavailable',
            CODE_GRAPH_UNAVAILABLE_MESSAGE,
          );
        }
        failureStage = 'publication';
        let installMs = 0;
        published = await withCodeGraphBaseVariantLock(variantDir, async () => {
          if (enabledOwners().length === 0) {
            throw new CodeGraphWorkerBuildError(
              'unavailable',
              CODE_GRAPH_UNAVAILABLE_MESSAGE,
            );
          }
          // The worker already recorded metadata, truncated the WAL, and ran
          // the full integrity check; this only renames and swaps manifests.
          const installStartedAt = performance.now();
          try {
            return await installCodeGraphBaseGeneration({
              variantDir,
              stagingDir: staging.stagingDir,
              identity,
              gitHead,
              flushRequiresWriteHandle: hostOperatingSystem() === 'win32',
            });
          } finally {
            installMs = performance.now() - installStartedAt;
          }
        });
        recordBaseBuild('success', {
          ...codeGraphBuildResultDetail(response.result),
          installMs: roundMs(installMs),
        });
        return { repoId: repository.repoId, ok: true };
      } catch (error) {
        const ioDetail: Partial<CodeGraphBuildDiagnosticDetail> =
          error instanceof CodeGraphIoError
            ? {
                failureClass: error.failureClass,
                ...(error.code === undefined ? {} : { errno: error.code }),
              }
            : workerFailure;
        if (
          error instanceof CodeGraphIoError &&
          error.kind === 'durability-unverified'
        ) {
          // Published and current, but its switch is not known durable; its
          // staging is already the generation. A crash that loses the switch
          // leaves the prior generation, which the next cycle rebuilds.
          recordBaseBuild('failure', {
            failureStage: 'publication-durability',
            ...ioDetail,
          });
          return { repoId: repository.repoId, ok: true };
        }
        await rm(staging.stagingDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
        recordBaseBuild('failure', { failureStage, ...ioDetail });
        return {
          repoId: repository.repoId,
          ok: false,
          message:
            error instanceof CodeGraphWorkerBuildError &&
            error.reason === 'unavailable'
              ? CODE_GRAPH_UNAVAILABLE_MESSAGE
              : error instanceof Error
                ? error.message
                : String(error),
        };
      }
    },
  ).catch((error: unknown) => {
    return {
      repoId: repository.repoId,
      ok: false,
      message:
        error instanceof RepoShadowEnsureCanceledError
          ? CODE_GRAPH_UNAVAILABLE_MESSAGE
          : error instanceof Error
            ? error.message
            : String(error),
    };
  });
  activeMaintenance.set(runnerKey, maintenance);
  try {
    return await maintenance;
  } finally {
    untrackActiveBaseKey(canonicalRepoRoot, runnerKey);
    if (activeMaintenance.get(runnerKey) === maintenance) {
      activeMaintenance.delete(runnerKey);
      activeMaintenanceOwners.delete(runnerKey);
      activeShadowPreparationControllers.delete(runnerKey);
    }
  }
}

async function runMaintenanceCycle(): Promise<void> {
  if (stopped) {
    return;
  }
  const workspaces = Array.from(desiredWorkspaces.values()).filter(
    (workspace) => isCodeGraphAvailableForWorkspace(workspace.workspaceId),
  );
  recordRealisticStartupPerformanceEvent(
    'startup:code-graph-base:cycle-started',
    {
      workspaceCount: workspaces.length,
      repositoryCount: workspaces.reduce(
        (total, workspace) => total + workspace.repositories.length,
        0,
      ),
    },
  );
  // Each workspace's maintenance is one initiated-work run that dispatches
  // worker.codeGraph.build in maintenance mode (CAN-5619); the run lands in
  // maintainCodeGraphBasesForWorkspace below. Workspaces run one at a time.
  for (const workspace of workspaces) {
    if (stopped) {
      return;
    }
    if (!isCodeGraphAvailableForWorkspace(workspace.workspaceId)) {
      continue;
    }
    await runCodeGraphBaseMaintenance({
      workspaceId: workspace.workspaceId,
      repositoryCount: workspace.repositories.length,
      available: () => isCodeGraphAvailableForWorkspace(workspace.workspaceId),
      stopped: () => stopped,
    });
  }
  recordRealisticStartupPerformanceEvent(
    'startup:code-graph-base:cycle-completed',
  );
}

function scheduleMaintenanceCycle(options?: { immediate?: boolean }): void {
  dirty = true;
  if (!started || stopped || cyclePromise !== null) {
    return;
  }
  if (cycleTimer !== null) {
    if (!options?.immediate) {
      return;
    }
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }
  if (periodicTimer !== null) {
    clearTimeout(periodicTimer);
    periodicTimer = null;
  }
  cycleTimer = setTimeout(
    () => {
      cycleTimer = null;
      dirty = false;
      cyclePromise = runMaintenanceCycle().finally(() => {
        cyclePromise = null;
        if (dirty) {
          scheduleMaintenanceCycle();
        } else if (!stopped && desiredWorkspaces.size > 0) {
          periodicTimer = setTimeout(() => {
            periodicTimer = null;
            scheduleMaintenanceCycle();
          }, MAINTENANCE_INTERVAL_MS);
          periodicTimer.unref?.();
        }
      });
    },
    options?.immediate ? 0 : MAINTENANCE_START_DELAY_MS,
  );
  cycleTimer.unref?.();
}

function workspaceDescriptor(item: SidebarItem): DesiredBaseWorkspace | null {
  if (item.type === 'cowork') {
    return null;
  }
  if (item.type === 'single-repo') {
    return {
      workspaceId: item.id,
      customLanguageRepoPath: item.repoPath,
      repositories: [
        { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: item.repoPath },
      ],
    };
  }
  return {
    workspaceId: item.id,
    customLanguageRepoPath: item.sourceRepoPath ?? null,
    repositories: [
      ...(item.sourceRepoPath
        ? [
            {
              repoId: WORKSPACE_ROOT_REPO_ID,
              repoPath: item.sourceRepoPath,
            },
          ]
        : []),
      ...item.repos.map((repository) => ({
        repoId: repository.id,
        repoPath: repository.repoPath,
      })),
    ],
  };
}

export function describeCodeGraphBaseWorkspace(
  item: SidebarItem,
): DesiredBaseWorkspace | null {
  return workspaceDescriptor(item);
}

export async function resolveCodeGraphBaseWorkspaceFingerprint(
  workspace: DesiredBaseWorkspace,
): Promise<string | null> {
  const preparedFingerprint = preparedCustomLanguageFingerprints.get(
    workspace.workspaceId,
  );
  if (preparedFingerprint !== undefined) {
    return preparedFingerprint;
  }
  if (!isCodeGraphAvailableForWorkspace(workspace.workspaceId)) {
    return readPersistedCustomLanguageFingerprint(workspace.workspaceId);
  }
  return (
    (await prepareWorkspaceCustomLanguages(workspace))?.fingerprint ?? null
  );
}

/** Order-independent identity of the desired base set. */
function desiredWorkspacesSignature(): string {
  return JSON.stringify(
    Array.from(desiredWorkspaces.values())
      .map((workspace) => [
        workspace.workspaceId,
        workspace.customLanguageRepoPath,
        workspace.repositories.map((repository) => [
          repository.repoId,
          repository.repoPath,
        ]),
      ])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

export function syncCodeGraphBaseRepositories(
  items: SidebarItem[],
  preserveWorkspaceIds: ReadonlySet<string> = new Set(),
): void {
  const previousSignature = desiredWorkspacesSignature();
  const previousWorkspaceIds = Array.from(desiredWorkspaces.keys());
  const nextDesiredWorkspaces = new Map<string, DesiredBaseWorkspace>();
  for (const item of items) {
    const descriptor = workspaceDescriptor(item);
    if (descriptor !== null) {
      nextDesiredWorkspaces.set(descriptor.workspaceId, descriptor);
    }
  }
  for (const workspaceId of Array.from(preserveWorkspaceIds)) {
    const existing = desiredWorkspaces.get(workspaceId);
    if (existing !== undefined && !nextDesiredWorkspaces.has(workspaceId)) {
      nextDesiredWorkspaces.set(workspaceId, existing);
    }
  }
  desiredWorkspaces.clear();
  for (const [workspaceId, descriptor] of Array.from(
    nextDesiredWorkspaces.entries(),
  )) {
    desiredWorkspaces.set(workspaceId, descriptor);
  }
  recordRealisticStartupPerformanceEvent(
    'startup:code-graph-base:repositories-synced',
    {
      workspaceCount: desiredWorkspaces.size,
      repositoryCount: Array.from(desiredWorkspaces.values()).reduce(
        (total, workspace) => total + workspace.repositories.length,
        0,
      ),
    },
  );
  for (const workspaceId of Array.from(
    preparedCustomLanguageFingerprints.keys(),
  )) {
    if (!desiredWorkspaces.has(workspaceId)) {
      preparedCustomLanguageFingerprints.delete(workspaceId);
    }
  }
  for (const workspaceId of previousWorkspaceIds) {
    if (!desiredWorkspaces.has(workspaceId)) {
      removePersistedCustomLanguageFingerprint(workspaceId);
    }
  }
  // Projects reload on many unrelated events. Re-arming here on every reload
  // replaced the 15-minute cadence with a cycle 10 seconds after each one, so
  // only an actual change to the desired repositories reschedules.
  if (desiredWorkspacesSignature() !== previousSignature) {
    scheduleMaintenanceCycle();
  }
}

export function getCodeGraphBaseWorkspaceDescriptor(
  workspaceId: string,
): DesiredBaseWorkspace | null {
  const workspace = desiredWorkspaces.get(workspaceId);
  return workspace === undefined
    ? null
    : {
        ...workspace,
        repositories: workspace.repositories.map((repository) => ({
          ...repository,
        })),
      };
}

/**
 * Refreshes every base the workspace needs. `forceRefresh` rebuilds now in
 * the agent class; `maintenance` is the periodic cycle's pass, which rebuilds
 * a base only when its shadow moved, one repository at a time, in the
 * maintenance class.
 */
export async function maintainCodeGraphBasesForWorkspace(
  workspaceId: string,
  options: { forceRefresh: true } | { maintenance: true },
): Promise<CodeGraphBaseMaintenanceOutcome[]> {
  if (!isCodeGraphAvailableForWorkspace(workspaceId)) {
    return [
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        ok: false,
        message: CODE_GRAPH_UNAVAILABLE_MESSAGE,
      },
    ];
  }
  const workspace = desiredWorkspaces.get(workspaceId);
  if (workspace === undefined) {
    return [
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        ok: false,
        message: 'Project not found.',
      },
    ];
  }
  const forceRefresh = 'forceRefresh' in options;
  const customLanguages = await prepareWorkspaceCustomLanguages(
    workspace,
    forceRefresh ? { forceRefresh } : undefined,
  );
  if (customLanguages === null) {
    return workspace.repositories.map((repository) => ({
      repoId: repository.repoId,
      ok: false,
      message: isCodeGraphAvailableForWorkspace(workspaceId)
        ? 'Failed to prepare custom-language configuration.'
        : CODE_GRAPH_UNAVAILABLE_MESSAGE,
    }));
  }
  if (!forceRefresh) {
    const outcomes: CodeGraphBaseMaintenanceOutcome[] = [];
    for (const repository of workspace.repositories) {
      outcomes.push(
        stopped || !isCodeGraphAvailableForWorkspace(workspaceId)
          ? {
              repoId: repository.repoId,
              ok: false,
              message: CODE_GRAPH_UNAVAILABLE_MESSAGE,
            }
          : await maintainBase(repository, customLanguages, {
              ownerWorkspaceIds: [workspaceId],
            }),
      );
    }
    return outcomes;
  }
  return Promise.all(
    workspace.repositories.map((repository) =>
      maintainBase(repository, customLanguages, {
        ownerWorkspaceIds: [workspaceId],
        forceRefresh: true,
      }),
    ),
  );
}

/**
 * Schedules a hidden projection repair for one immutable published base.
 * `maintainBase` rebuilds a private staging generation and atomically
 * installs it; the published generation is never opened for writing.
 */
export function requestCodeGraphBaseSummaryRepair(
  workspaceId: string,
  repoId: string,
): Promise<CodeGraphBaseMaintenanceOutcome> {
  const requestKey = `${workspaceId}/${repoId}`;
  const active = baseSummaryRepairAttempts.get(requestKey);
  if (active !== undefined) return active;
  if (!isCodeGraphAvailableForWorkspace(workspaceId)) {
    return Promise.resolve({
      repoId,
      ok: false,
      message: CODE_GRAPH_UNAVAILABLE_MESSAGE,
    });
  }
  const repair = (async (): Promise<CodeGraphBaseMaintenanceOutcome> => {
    const workspace = desiredWorkspaces.get(workspaceId);
    const repository = workspace?.repositories.find(
      (candidate) => candidate.repoId === repoId,
    );
    if (workspace === undefined || repository === undefined) {
      return { repoId, ok: false, message: 'Project repository not found.' };
    }
    if (stopped || !isCodeGraphAvailableForWorkspace(workspaceId)) {
      return {
        repoId,
        ok: false,
        message: CODE_GRAPH_UNAVAILABLE_MESSAGE,
      };
    }
    const customLanguages = await prepareWorkspaceCustomLanguages(workspace);
    if (customLanguages === null) {
      return {
        repoId,
        ok: false,
        message: isCodeGraphAvailableForWorkspace(workspaceId)
          ? 'Failed to prepare custom-language configuration.'
          : CODE_GRAPH_UNAVAILABLE_MESSAGE,
      };
    }
    const canonicalRepoRoot = await resolveWorkspaceReferenceRepoPath(
      repository.repoPath,
    );
    const runnerKey = codeGraphBaseRunnerKey(canonicalRepoRoot, {
      repoId,
      customLanguagesFingerprint: customLanguages.fingerprint,
    });
    if (retiringRepoRoots.has(canonicalRepoRoot))
      return { repoId, ok: false, message: CODE_GRAPH_UNAVAILABLE_MESSAGE };
    const activeVariant = baseSummaryRepairVariants.get(runnerKey);
    if (activeVariant !== undefined) {
      baseSummaryRepairVariantOwners.get(runnerKey)?.add(workspaceId);
      const activeOwners = activeMaintenanceOwners.get(runnerKey);
      if (activeOwners !== undefined) {
        activeOwners.add(workspaceId);
        updateCodeGraphBuildOwners(
          runnerKey,
          Array.from(activeOwners).filter(isCodeGraphAvailableForWorkspace),
        );
      }
      return await activeVariant;
    }
    const cooldownUntil = baseSummaryRepairCooldownUntil.get(runnerKey) ?? 0;
    if (cooldownUntil > Date.now())
      return {
        repoId,
        ok: false,
        message: 'A code-graph base summary repair recently failed.',
      };
    baseSummaryRepairCooldownUntil.delete(runnerKey);
    const repairOwners = new Set([workspaceId]);
    baseSummaryRepairVariantOwners.set(runnerKey, repairOwners);
    const variant = (async (): Promise<CodeGraphBaseMaintenanceOutcome> => {
      const currentMaintenance = activeMaintenance.get(runnerKey);
      if (currentMaintenance !== undefined) {
        const currentOutcome = await currentMaintenance;
        if (!currentOutcome.ok) return currentOutcome;
      }
      if (
        stopped ||
        !Array.from(repairOwners).some(isCodeGraphAvailableForWorkspace) ||
        retiringRepoRoots.has(canonicalRepoRoot)
      ) {
        return { repoId, ok: false, message: CODE_GRAPH_UNAVAILABLE_MESSAGE };
      }
      return maintainBase(repository, customLanguages, {
        ownerWorkspaceIds: Array.from(repairOwners).filter(
          isCodeGraphAvailableForWorkspace,
        ),
        summaryProjectionRepair: true,
      });
    })();
    baseSummaryRepairVariants.set(runnerKey, variant);
    const finishVariant = (failed: boolean): void => {
      if (failed)
        baseSummaryRepairCooldownUntil.set(
          runnerKey,
          Date.now() + BASE_SUMMARY_REPAIR_COOLDOWN_MS,
        );
      if (baseSummaryRepairVariants.get(runnerKey) === variant) {
        baseSummaryRepairVariants.delete(runnerKey);
        baseSummaryRepairVariantOwners.delete(runnerKey);
      }
    };
    void variant.then(
      (outcome) => finishVariant(!outcome.ok),
      () => finishVariant(true),
    );
    return await variant;
  })();
  baseSummaryRepairAttempts.set(requestKey, repair);
  const finishRequest = (): void => {
    if (baseSummaryRepairAttempts.get(requestKey) === repair)
      baseSummaryRepairAttempts.delete(requestKey);
  };
  void repair.then(finishRequest, finishRequest);
  return repair;
}

export function reconcileCodeGraphBaseAvailability(): Promise<void> {
  if (stopped) {
    return Promise.resolve();
  }
  activeShadowPreparationControllers.forEach((preparation): void => {
    if (
      !Array.from(preparation.ownerWorkspaceIds).some(
        isCodeGraphAvailableForWorkspace,
      )
    ) {
      preparation.controller.abort();
    }
  });
  scheduleMaintenanceCycle({ immediate: true });
  return Promise.resolve();
}

export function startCodeGraphBaseManager(): void {
  if (started) {
    return;
  }
  started = true;
  stopped = false;
  recordRealisticStartupPerformanceEvent(
    'startup:code-graph-base:manager-started',
  );
  setRepoShadowRetirementHandler(retireCodeGraphBasesForRepo);
  scheduleMaintenanceCycle();
}

export async function retireCodeGraphBasesForRepo(
  repoRoot: string,
): Promise<() => void> {
  retiringRepoRoots.add(repoRoot);
  const keys = Array.from(activeBaseKeysByRepo.get(repoRoot) ?? []);
  await Promise.all(keys.map((key) => cancelBuild(key)));
  const maintenancePromises = keys.flatMap((key) => {
    const maintenance = activeMaintenance.get(key);
    return maintenance === undefined
      ? []
      : [maintenance.catch(() => undefined)];
  });
  await Promise.all(maintenancePromises);
  await retireCodeGraphBaseVariants(repoRoot);
  return () => {
    retiringRepoRoots.delete(repoRoot);
    allowCodeGraphBaseVariants(repoRoot);
    scheduleMaintenanceCycle();
  };
}

export async function shutdownCodeGraphBaseManager(): Promise<void> {
  stopped = true;
  dirty = false;
  if (cycleTimer !== null) {
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }
  if (periodicTimer !== null) {
    clearTimeout(periodicTimer);
    periodicTimer = null;
  }
  setRepoShadowRetirementHandler(null);
  cancelCodeGraphBaseMaintenance('The app is shutting down.');
  // Abort network-bound shadow preparation before awaiting any maintenance
  // promise that may itself be blocked on that Git subprocess.
  activeShadowPreparationControllers.forEach((preparation): void => {
    preparation.controller.abort();
  });
  const keys = Array.from(activeMaintenance.keys());
  await Promise.all(keys.map((key) => cancelBuild(key)));
  await cyclePromise?.catch(() => undefined);
  await Promise.all(
    Array.from(activeMaintenance.values()).map((promise) =>
      promise.catch(() => undefined),
    ),
  );
  await Promise.all(
    Array.from(baseSummaryRepairAttempts.values(), (promise) =>
      promise.catch(() => undefined),
    ),
  );
  desiredWorkspaces.clear();
  preparedCustomLanguageFingerprints.clear();
  activeMaintenance.clear();
  activeMaintenanceOwners.clear();
  baseSummaryRepairAttempts.clear();
  baseSummaryRepairVariants.clear();
  baseSummaryRepairVariantOwners.clear();
  baseSummaryRepairCooldownUntil.clear();
  activeShadowPreparationControllers.clear();
  activeBaseKeysByRepo.clear();
  retiringRepoRoots.clear();
  started = false;
}

export const codeGraphBaseManagerTestExports = {
  publishedSummaryRepairState,
  availableOwnerWorkspaceIds,
  codeGraphBaseBuildPriority,
  clearPreparedCustomLanguageFingerprints(): void {
    preparedCustomLanguageFingerprints.clear();
  },
  maintainBase,
  materializeCustomLanguageSnapshot,
  prepareWorkspaceCustomLanguages,
  setPreparedCustomLanguageFingerprint(
    workspaceId: string,
    fingerprint: string,
  ): void {
    preparedCustomLanguageFingerprints.set(workspaceId, fingerprint);
  },
  workspaceDescriptor,
  workspaceOwnersForRepositoryVariant,
};

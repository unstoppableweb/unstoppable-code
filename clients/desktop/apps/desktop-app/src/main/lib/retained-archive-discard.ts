import { matchesRecordedDirectoryIdentity } from '@canopy/core-runtime/node/w5/recorded-directory-identity';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import type {
  ArchivedContainerManifest,
  ArchivedContainerRecoveryManifest,
  ArchivedGitState,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type {
  WorktreeDiscardCause,
  WorktreeDiscardDescription,
  WorktreeDiscardGitCleanup,
  WorktreeDiscardRefusal,
  WorktreeDiscardSource,
  WorktreeDiscardTarget,
  WorktreeDiscardTargetKind,
} from '@canopy/protocol/remote-control/shell';
import {
  assertArchivedGitStatePurgeable,
  deleteArchivedContainerSnapshotRef,
  inspectArchivedContainerSnapshotRef,
  readArchivedGitStagedDescriptor,
} from './archived-container-git';
import {
  LEDGER_ARCHIVE_NOT_SAVED_MESSAGE,
  recordLedgerMappingBeforeDeletion,
} from './archived-container-ledger';
import {
  readArchivedContainerGitCleanupBlockedRepositories,
  readArchivedContainerRecoveryState,
  readConfiguredWorktreeSourceCandidates,
  verifyArchivedContainerRecoveryFinish,
} from './archived-container-recovery';
import {
  purgeArchivedContainerForDiscard,
  readArchivedContainerManifestIncludingExpired,
} from './archived-containers';
import { getArchivedContainerDir } from './paths';
import { isErrnoException } from './type-guards';
import {
  hasUnfinishedWorkspaceDeletion,
  readWorkspaceDestructiveRecoveries,
} from './w5-destructive-recovery';
import { readWorkspaceConfigDetailed } from './workspace-persistence';
import { gitCleanupWarning } from './worktree-discard-git-residue';
import { hasWorktreeRegistration } from './worktree-registration-removal';
import {
  classifyWorktreeSource,
  isGitUsable,
  readUncommittedChanges,
} from './worktree-source-classification';

/**
 * CAN-5338 (CAN-4995 F): the discard of a retained (archived or deleted)
 * worktree whose permanent deletion cannot finish, because a source it
 * recorded is gone (the version-2 purge validation, a version-3 Git
 * registration cleanup) or a version-3 saved copy fails verification while
 * its checkout is unchanged. Described only for a caller that opts in with
 * `retainedArchives`, and only when no row and no unfinished journal name the
 * id: anything else stays C's. The project's configured sources decide
 * "gone"; an archive that recorded other paths refuses `evidence-mismatch`
 * (Mike, Q6 b). Executed by `discardWorktree` under the container operation
 * lock, with no W5 journal: the archive's own recovery journal and a fresh
 * description make a retry safe.
 */

type RetainedManifest = Extract<ArchivedContainerManifest, { version: 2 | 3 }>;

interface StatIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

/** A configured source a blocked step recorded, classified. */
interface RetainedSource {
  repoId: string;
  path: string;
  relativePath: string;
  state: WorktreeDiscardSource['state'];
  gitCommonDir?: string;
  /** Snapshot refs the archive recorded in it. */
  refs: { snapshotRef: string; worktreeSnapshotCommit: string }[];
  /** The version-3 finish step cleans Git registrations in it. */
  registrations: boolean;
  /** That cleanup is blocked here; refused while the source is available. */
  cleanupBlocked: boolean;
}

interface RetainedTarget {
  kind: WorktreeDiscardTargetKind;
  path: string;
}

export interface RetainedArchivePlan {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly manifest: RetainedManifest;
  readonly containerIdentity: StatIdentity;
  readonly sources: readonly RetainedSource[];
  readonly targets: readonly RetainedTarget[];
  readonly canonicalPath: string;
  readonly quarantinePath: string;
}

export interface RetainedArchiveInspection {
  readonly description: WorktreeDiscardDescription;
  readonly plan?: RetainedArchivePlan;
}

/** A recorded repository whose cleanup is blocked, before classification. */
interface BlockedRepository {
  repoId?: string;
  path: string;
  refs: RetainedSource['refs'];
  registrations: boolean;
  /** The version-3 finish step's Git cleanup is blocked in this repository. */
  cleanupBlocked?: boolean;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function identityString(stats: StatIdentity): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

/** Binds the description and the incarnation of the archive it describes. */
function confirmationOf(
  description: Omit<WorktreeDiscardDescription, 'confirmation'>,
  manifest: RetainedManifest | null,
): string {
  return createHash('sha256')
    .update(
      stableStringify([
        description,
        manifest && {
          version: manifest.version,
          createdAt: manifest.createdAt,
          archivedAt: manifest.archivedAt,
          payloadId:
            manifest.version === 3 ? manifest.recovery.payloadId : null,
          restoredTo: manifest.restoredTo ?? null,
        },
      ]),
    )
    .digest('hex');
}

function finish(
  description: Omit<WorktreeDiscardDescription, 'confirmation'>,
  manifest: RetainedManifest | null,
  plan?: RetainedArchivePlan,
): RetainedArchiveInspection {
  return {
    description: {
      ...description,
      confirmation: confirmationOf(description, manifest),
    },
    ...(description.status === 'discardable' && plan ? { plan } : {}),
  };
}

function mergeBlocked(
  into: BlockedRepository[],
  repository: BlockedRepository,
): void {
  const existing = into.find(
    (candidate) => resolve(candidate.path) === resolve(repository.path),
  );
  if (!existing) {
    into.push({ ...repository, refs: [...repository.refs] });
    return;
  }
  existing.repoId ??= repository.repoId;
  existing.refs.push(...repository.refs);
  existing.registrations ||= repository.registrations;
  existing.cleanupBlocked ||= repository.cleanupBlocked === true;
}

function refsOf(gitState: Pick<ArchivedGitState, 'repositories'>): {
  repoId: string;
  path: string;
  refs: RetainedSource['refs'];
}[] {
  return gitState.repositories.map((repository) => ({
    repoId: repository.repoId,
    path: repository.referenceRepoPath,
    refs: [
      {
        snapshotRef: repository.snapshotRef,
        worktreeSnapshotCommit: repository.worktreeSnapshotCommit,
      },
    ],
  }));
}

type Classified =
  | { kind: 'sources'; sources: RetainedSource[] }
  | { kind: 'refused'; reason: WorktreeDiscardRefusal };

/**
 * Each blocked repository against the project's configured sources (Q6 b).
 * Discardable only when one is gone and every available one is the recorded
 * repository with its refs where the archive left them.
 */
async function classifyBlocked(
  workspaceId: string,
  manifest: RetainedManifest,
  config: WorkspaceConfigFile,
  blocked: readonly BlockedRepository[],
): Promise<Classified> {
  // Every configured repository: a retained archive outlives its row's selection.
  const { includedRepoIds: _included, ...worktree } = manifest.originalWorktree;
  void _included;
  const candidates = await readConfiguredWorktreeSourceCandidates(
    workspaceId,
    worktree,
    config,
  );
  const sources: RetainedSource[] = [];
  for (const repository of blocked) {
    const candidate = candidates.find(
      (configured) =>
        resolve(configured.referenceRepoPath) === resolve(repository.path) &&
        (repository.repoId === undefined ||
          configured.repoId === repository.repoId),
    );
    if (!candidate) return { kind: 'refused', reason: 'evidence-mismatch' };
    const known = sources.find((source) => source.repoId === candidate.repoId);
    if (known) {
      known.refs.push(...repository.refs);
      known.registrations ||= repository.registrations;
      known.cleanupBlocked ||= repository.cleanupBlocked === true;
      continue;
    }
    const classified = await classifyWorktreeSource(
      candidate.referenceRepoPath,
    );
    sources.push({
      repoId: candidate.repoId,
      path: candidate.referenceRepoPath,
      relativePath: candidate.relativePath,
      state: classified.state,
      ...(classified.gitCommonDir
        ? { gitCommonDir: classified.gitCommonDir }
        : {}),
      refs: [...repository.refs],
      registrations: repository.registrations,
      cleanupBlocked: repository.cleanupBlocked === true,
    });
  }
  if (sources.some((source) => source.state === 'unverified'))
    return { kind: 'refused', reason: 'source-unverified' };
  for (const source of sources) {
    if (source.state !== 'available') continue;
    // Available, yet its Git cleanup still can't finish (a re-clone, say):
    // not abandoned validation, so it stays refused.
    if (source.cleanupBlocked)
      return { kind: 'refused', reason: 'evidence-mismatch' };
    for (const ref of source.refs) {
      let inspected: Awaited<
        ReturnType<typeof inspectArchivedContainerSnapshotRef>
      >;
      try {
        inspected = await inspectArchivedContainerSnapshotRef({
          repoPath: source.path,
          refName: ref.snapshotRef,
          expectedCommit: ref.worktreeSnapshotCommit,
        });
      } catch {
        return { kind: 'refused', reason: 'source-unverified' };
      }
      // A moved ref is not abandoned validation: the purge's own refusal stands.
      if (inspected.ref === 'other')
        return { kind: 'refused', reason: 'evidence-mismatch' };
    }
  }
  // Available but still failing: a repository the archive did not record.
  if (!sources.some((source) => source.state !== 'available'))
    return { kind: 'refused', reason: 'evidence-mismatch' };
  return { kind: 'sources', sources };
}

async function describeRepositories(
  target: string,
  sources: readonly RetainedSource[],
  relativePaths: readonly string[],
): Promise<NonNullable<WorktreeDiscardTarget['repositories']>> {
  const repositories: NonNullable<WorktreeDiscardTarget['repositories']> = [];
  for (const relative of relativePaths) {
    const relativePath = relative === '' ? '.' : relative;
    const path = relativePath === '.' ? target : join(target, relativePath);
    const present = await lstatOrNull(path).catch(() => null);
    if (!present?.isDirectory()) continue;
    const source = sources.find(
      (candidate) => candidate.relativePath === relativePath,
    );
    repositories.push({
      repoId: source?.repoId ?? relativePath,
      relativePath,
      ...(source?.state === 'available'
        ? { uncommittedChanges: await readUncommittedChanges(path) }
        : {}),
    });
  }
  return repositories;
}

export interface RetainedArchiveDescribeOptions {
  /** As for C's description: the project-level description only. */
  readonly ignoreInterruptedDeletion?: boolean;
}

/** A refusal a step of the inspection raises; the inspection reports it. */
class RetainedRefusal extends Error {
  constructor(readonly reason: WorktreeDiscardRefusal) {
    super(`The retained archive discard was refused: ${reason}.`);
    this.name = 'RetainedRefusal';
  }
}

async function readRetainedManifest(
  workspaceId: string,
  worktreeId: string,
): Promise<RetainedManifest> {
  let read: ArchivedContainerManifest;
  try {
    // Expired archives are hidden but still block a project deletion.
    read = await readArchivedContainerManifestIncludingExpired(
      workspaceId,
      worktreeId,
    );
  } catch (error) {
    throw new RetainedRefusal(
      isErrnoException(error) &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ? 'not-found'
        : 'evidence-unreadable',
    );
  }
  if (read.version === 1 || read.kind !== 'worktree')
    throw new RetainedRefusal('unsupported-workspace');
  return read;
}

/** The project-level checks C's description makes, for a retained archive. */
async function admitRetained(
  workspaceId: string,
  manifest: RetainedManifest,
  options: RetainedArchiveDescribeOptions,
): Promise<WorkspaceConfigFile> {
  // A restore still installing its destination owns the archive.
  if (manifest.version === 3 && manifest.restoreStaging)
    throw new RetainedRefusal('busy');
  const detail = await readWorkspaceConfigDetailed(workspaceId).catch(
    () => null,
  );
  if (detail?.authority !== 'ok')
    throw new RetainedRefusal('configuration-unreadable');
  const { config } = detail;
  if (config.type === 'cowork')
    throw new RetainedRefusal('unsupported-workspace');
  if (config.type === 'single-repo' && !config.repoPath)
    throw new RetainedRefusal('configuration-unreadable');
  let deletionPending: boolean;
  try {
    await readWorkspaceDestructiveRecoveries(workspaceId);
    deletionPending =
      options.ignoreInterruptedDeletion !== true &&
      (await hasUnfinishedWorkspaceDeletion(workspaceId));
  } catch {
    throw new RetainedRefusal('evidence-unreadable');
  }
  if (deletionPending) throw new RetainedRefusal('project-deletion-pending');
  if (!(await isGitUsable())) throw new RetainedRefusal('source-unverified');
  return config;
}

async function readContainer(path: string): Promise<Stats> {
  const container = await lstatOrNull(path).catch(() => {
    throw new RetainedRefusal('evidence-unreadable');
  });
  if (!container) throw new RetainedRefusal('not-found');
  if (!container.isDirectory() || container.isSymbolicLink())
    throw new RetainedRefusal('unverifiable-target');
  return container;
}

type RecoveryState = Awaited<
  ReturnType<typeof readArchivedContainerRecoveryState>
>;

interface Blockers {
  causes: WorktreeDiscardCause[];
  blocked: BlockedRepository[];
  recoveryState: RecoveryState;
}

/** A recorded Git state the purge's own validation rejects. */
async function addUnpurgeableRefs(
  blocked: BlockedRepository[],
  manifest: Pick<RetainedManifest, 'projectId' | 'id' | 'workspaceType'>,
  gitState: ArchivedGitState,
): Promise<void> {
  try {
    await assertArchivedGitStatePurgeable({ ...manifest, gitState });
  } catch {
    for (const repository of refsOf(gitState))
      mergeBlocked(blocked, { ...repository, registrations: false });
  }
}

/** The version-3 finish step: what still checks, and what it would leave. */
async function addFinishBlockers(
  found: Blockers,
  manifest: ArchivedContainerRecoveryManifest,
): Promise<void> {
  try {
    // What the discard's finish still checks: identity, occupancy, ownership.
    await verifyArchivedContainerRecoveryFinish(manifest, {
      discardingArchive: true,
      abandonVerification: true,
    });
    found.recoveryState = await readArchivedContainerRecoveryState(manifest);
  } catch (error) {
    throw new RetainedRefusal(
      isErrnoException(error) ? 'evidence-unreadable' : 'unverifiable-target',
    );
  }
  try {
    await verifyArchivedContainerRecoveryFinish(manifest, {
      discardingArchive: true,
    });
  } catch (error) {
    if (isErrnoException(error) && error.code !== 'ENOENT')
      throw new RetainedRefusal('evidence-unreadable');
    found.causes.push('archive-recovery-unverified');
  }
  const stuck = (
    await readArchivedContainerGitCleanupBlockedRepositories(manifest)
  ).map((path) => resolve(path));
  if (stuck.length > 0)
    // Every recorded repository: the discard's finish cleans the available ones.
    for (const repository of found.recoveryState?.repositories ?? [])
      mergeBlocked(found.blocked, {
        path: repository.referenceRepoPath,
        refs: [],
        registrations: true,
        cleanupBlocked: stuck.includes(resolve(repository.referenceRepoPath)),
      });
}

/** What keeps the ordinary purge of this archive from finishing. */
async function findBlockers(manifest: RetainedManifest): Promise<Blockers> {
  const found: Blockers = { causes: [], blocked: [], recoveryState: null };
  if (manifest.version === 2) {
    await addUnpurgeableRefs(found.blocked, manifest, manifest.gitState);
    return found;
  }
  if (manifest.recovery.gitCleanupPending)
    await addFinishBlockers(found, manifest);
  const staged = await readArchivedGitStagedDescriptor(
    manifest.projectId,
    manifest.id,
    { readOnly: true, recoveryOnly: true },
  ).catch(() => {
    throw new RetainedRefusal('evidence-unreadable');
  });
  if (staged && staged.repositories.length > 0)
    await addUnpurgeableRefs(found.blocked, manifest, {
      version: 1,
      diffFormatVersion: 1,
      repositories: staged.repositories,
    });
  else if (staged && (staged.status === 'ready' || staged.teardown))
    // The purge keeps such a capture as recovery material; so does this.
    throw new RetainedRefusal('evidence-mismatch');
  return found;
}

/** The checkout or quarantine the finish step still owns: only before `removed`. */
async function finishTargets(
  recoveryState: RecoveryState,
  sources: readonly RetainedSource[],
  reason: WorktreeDiscardCause,
): Promise<{ targets: RetainedTarget[]; described: WorktreeDiscardTarget[] }> {
  const targets: RetainedTarget[] = [];
  const described: WorktreeDiscardTarget[] = [];
  if (!recoveryState || recoveryState.identity === null)
    return { targets, described };
  const { identity, phase, canonicalPath, quarantinePath } = recoveryState;
  const [checkout, quarantine] = await Promise.all([
    phase === 'captured' ? lstatOrNull(canonicalPath) : null,
    phase === 'removed' ? null : lstatOrNull(quarantinePath),
  ]).catch(() => {
    throw new RetainedRefusal('evidence-unreadable');
  });
  const relativePaths = recoveryState.repositories.map(
    (repository) => repository.relativePath,
  );
  for (const [kind, path, present] of [
    ['live-checkout', canonicalPath, checkout],
    ['git-quarantine', quarantinePath, quarantine],
  ] as const) {
    if (!present) continue;
    // Verified against the journal above; re-checked by the finish step.
    if (
      !matchesRecordedDirectoryIdentity(
        identity,
        identityString(present),
        hostOperatingSystem(),
      )
    )
      throw new RetainedRefusal('unverifiable-target');
    targets.push({ kind, path });
    described.push({
      kind,
      path,
      identity,
      identityVerified: false,
      reason,
      repositories: await describeRepositories(path, sources, relativePaths),
    });
  }
  return { targets, described };
}

function mayRemainOf(
  sources: readonly RetainedSource[],
): WorktreeDiscardDescription['mayRemain'] {
  return sources
    .filter((source) => source.state !== 'available')
    .flatMap((source) => [
      ...(source.registrations
        ? [{ kind: 'git-registration' as const, repoId: source.repoId }]
        : []),
      ...(source.refs.length > 0
        ? [{ kind: 'git-ref' as const, repoId: source.repoId }]
        : []),
    ]);
}

/**
 * Read-only. The caller (`inspectWorktreeDiscard`) already refused a
 * read-only scope and found no row and no unfinished journal for the id.
 */
export async function inspectRetainedArchiveDiscard(
  workspaceId: string,
  worktreeId: string,
  options: RetainedArchiveDescribeOptions = {},
): Promise<RetainedArchiveInspection> {
  const containerPath = getArchivedContainerDir(workspaceId, worktreeId);
  const base: Omit<WorktreeDiscardDescription, 'confirmation'> = {
    version: 1,
    workspaceId,
    worktreeId,
    createdAt: '',
    status: 'refused',
    causes: [],
    sources: [],
    targets: [],
    alsoDeleted: [],
    preserved: ['source-working-files', 'branches'],
    mayRemain: [],
  };
  let manifest: RetainedManifest | null = null;
  let sources: RetainedSource[] = [];
  try {
    manifest = await readRetainedManifest(workspaceId, worktreeId);
    const config = await admitRetained(workspaceId, manifest, options);
    const container = await readContainer(containerPath);
    const { causes, blocked, recoveryState } = await findBlockers(manifest);
    if (blocked.length > 0) {
      const classified = await classifyBlocked(
        workspaceId,
        manifest,
        config,
        blocked,
      ).catch(
        (): Classified => ({
          kind: 'refused',
          reason: 'configuration-unreadable',
        }),
      );
      if (classified.kind === 'refused')
        throw new RetainedRefusal(classified.reason);
      sources = classified.sources;
      causes.unshift('source-gone');
    }
    if (causes.length === 0) throw new RetainedRefusal('no-broken-removal');
    const { targets, described } = await finishTargets(
      recoveryState,
      sources,
      causes.includes('archive-recovery-unverified')
        ? 'archive-recovery-unverified'
        : causes[0],
    );
    targets.push({ kind: 'retained-archive', path: containerPath });
    described.push({
      kind: 'retained-archive',
      path: containerPath,
      identity: identityString(container),
      identityVerified: false,
      reason: causes[0],
    });
    const plan: RetainedArchivePlan = {
      workspaceId,
      worktreeId,
      manifest,
      containerIdentity: {
        dev: container.dev,
        ino: container.ino,
        birthtimeMs: container.birthtimeMs,
      },
      sources,
      targets,
      canonicalPath: recoveryState?.canonicalPath ?? '',
      quarantinePath: recoveryState?.quarantinePath ?? '',
    };
    return finish(
      {
        ...base,
        createdAt: manifest.createdAt,
        status: 'discardable',
        causes,
        sources: sources.map(({ repoId, path, state }) => ({
          repoId,
          path,
          state,
        })),
        targets: described,
        alsoDeleted: [
          'chats',
          'plans',
          'attachments',
          'cost-history',
          ...(manifest.version === 3
            ? (['retained-payload-copy'] as const)
            : []),
        ],
        mayRemain: mayRemainOf(sources),
      },
      manifest,
      plan,
    );
  } catch (error) {
    if (!(error instanceof RetainedRefusal)) throw error;
    return finish(
      {
        ...base,
        ...(manifest ? { createdAt: manifest.createdAt } : {}),
        sources: sources.map(({ repoId, path, state }) => ({
          repoId,
          path,
          state,
        })),
        status: 'refused',
        refusal: { reason: error.reason },
      },
      manifest,
    );
  }
}

export interface RetainedArchiveDiscardOutcome {
  removed: WorktreeDiscardTargetKind[];
  gitCleanup: WorktreeDiscardGitCleanup[];
  warnings: string[];
}

/** Whether Git still registers this source's checkout or quarantine. */
async function stillRegistered(
  plan: RetainedArchivePlan,
  source: RetainedSource,
): Promise<boolean> {
  if (!source.registrations || !plan.canonicalPath) return false;
  if (!source.gitCommonDir) return true;
  const relative = source.relativePath === '.' ? '' : source.relativePath;
  return hasWorktreeRegistration(source.gitCommonDir, [
    join(plan.canonicalPath, relative),
    join(plan.quarantinePath, relative),
  ]);
}

/**
 * Removes the confirmed archive (and the version-3 checkout or quarantine its
 * finish step owns) through the purge's discard mode. The caller holds the
 * container operation lock and re-described under it. Ref and registration
 * cleanup is best effort, in available sources only, and reported.
 */
export async function executeRetainedArchiveDiscard(
  plan: RetainedArchivePlan,
): Promise<RetainedArchiveDiscardOutcome> {
  const { workspaceId, worktreeId, manifest } = plan;
  if (!(await recordLedgerMappingBeforeDeletion(manifest)))
    throw new Error(LEDGER_ARCHIVE_NOT_SAVED_MESSAGE);
  const failed = new Set<string>();
  const releaseGitState = async (gitState: ArchivedGitState): Promise<void> => {
    for (const repository of gitState.repositories) {
      const source = plan.sources.find(
        (candidate) =>
          resolve(candidate.path) === resolve(repository.referenceRepoPath),
      );
      // A gone or unclassified source keeps its refs: never written to.
      if (source?.state !== 'available') continue;
      try {
        // Checks the expected commit; never re-pinned.
        await deleteArchivedContainerSnapshotRef({
          repoPath: source.path,
          refName: repository.snapshotRef,
          expectedCommit: repository.worktreeSnapshotCommit,
        });
      } catch {
        failed.add(source.repoId);
      }
    }
  };
  await purgeArchivedContainerForDiscard(workspaceId, worktreeId, {
    expectedIdentity: plan.containerIdentity,
    releaseGitState,
  });
  const gitCleanup: WorktreeDiscardGitCleanup[] = [];
  for (const source of plan.sources) {
    let status: WorktreeDiscardGitCleanup['status'] = 'skipped';
    if (source.state === 'available') {
      const registered = await stillRegistered(plan, source).catch(() => true);
      status = failed.has(source.repoId) || registered ? 'failed' : 'cleaned';
    }
    gitCleanup.push({ repoId: source.repoId, status });
  }
  return {
    removed: plan.targets.map((target) => target.kind),
    gitCleanup,
    warnings: gitCleanup.flatMap((result) =>
      result.status === 'failed'
        ? (gitCleanupWarning('failed', result.repoId) ?? [])
        : [],
    ),
  };
}

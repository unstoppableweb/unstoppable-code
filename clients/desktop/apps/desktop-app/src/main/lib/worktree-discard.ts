import {
  withArchiveFailureTelemetry,
  recordArchiveRefusal,
  type ArchiveTrigger,
} from './archive-failure-telemetry';
import { logMainProcessWarn } from './main-process-logging';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  ArchiveWorktreeResponse,
  WorkspaceConfigFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type {
  WorktreeArchiveTypedRefusal,
  WorktreeDiscardCause,
  WorktreeDiscardDescription,
  WorktreeDiscardGitCleanup,
  WorktreeDiscardRefusal,
  WorktreeDiscardResult,
  WorktreeDiscardRetry,
  WorktreeDiscardSource,
  WorktreeDiscardTarget,
  WorktreeDiscardTargetKind,
} from '@canopy/protocol/portal';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { runArchiveIoRequest } from '../archive/archive-io-runner';
import { assertWorktreeCanBeRemoved } from '../agents/background-work';
import {
  assertNotSplitDestinationWorktreeClaimed,
  assertNotSplitLocked,
} from '../services/split-lock-service';
import {
  areOwnedPathsUnreplaced,
  canFinishArchiveCleanup,
  canResumeInterruptedArchive,
  destructiveStep,
  hasUnfinishedWorkspaceDeletion,
  isDestructiveRecoveryOwnerless,
  isResumableChildArchiveFailure,
  isVerifiedProtectedPathIdentity,
  isWorktreeDiscardRecord,
  probeProtectedPathIdentity,
  readDestructiveRecovery,
  readDirectoryStatIdentity,
  readWorkspaceDestructiveRecoveries,
  retireSupersededDestructiveRecord,
  statIdentityOf,
  supersededDiscardOperationId,
  withWorktreeDiscardLifecycle,
  type DestructiveRecoveryRecord,
} from './w5-destructive-recovery';
import {
  buildArchivedContainerSnapshotRef,
  deleteArchivedContainerSnapshotRef,
  inspectArchivedContainerSnapshotRef,
  readArchivedGitStagedDescriptor,
  verifyArchivedGitQuarantineSnapshots,
  type ArchivedGitStagedDescriptor,
} from './archived-container-git';
import {
  isWorktreeArchiveSourceUnavailable,
  readArchivedContainerRecoveryJournal,
  readConfiguredWorktreeSourceCandidates,
} from './archived-container-recovery';
import { notifyLedgerOfArchivedContainerDeletion } from './archived-container-ledger';
import {
  readArchivedContainerManifestIncludingExpired,
  withArchivedContainerOperationLock,
  withArchivedWorkspaceOperationLock,
} from './archived-containers';
import { getGitCommonDir } from './git';
import {
  getArchivedContainerDir,
  getArchivedContainerManifestPath,
  getArchivedContainersRootDir,
  getWorkspaceDir,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreesRootDir,
} from './paths';
import { isPathInside } from './path-safety';
import { isWritableScope } from './read-only-scope';
import { isErrnoException } from './type-guards';
import { validateId } from './validation';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from './workspace-persistence';
import { WorktreeArchiveRefusedError } from './worktree-archive-refusal';
import {
  GIT_CLEANUP_OUTCOMES,
  gitCleanupFactsBefore,
  gitCleanupOutcomeOf,
  gitCleanupRuns,
  gitCleanupWarning,
  gitResidueOf,
  predictedGitCleanupFacts,
  publicGitCleanupStatus,
  type GitCleanupFacts,
  type GitCleanupOutcome,
  type GitRefEvidence,
  type GitSourceObservation,
} from './worktree-discard-git-residue';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from './worktree-live-cleanup';
import {
  hasWorktreeRegistration,
  removeAbsentWorktreeRegistrations,
} from './worktree-registration-removal';
import {
  executeRetainedArchiveDiscard,
  inspectRetainedArchiveDiscard,
  type RetainedArchivePlan,
} from './retained-archive-discard';
import {
  retryDeferredTemporaryWorkspaceDeletion,
  runWithWorktreeArchiveDeletionLifecycle,
  runWorktreeDiscardTail,
} from './worktree-service';
import {
  classifyWorktreeSource,
  isGitUsable,
  readUncommittedChanges,
} from './worktree-source-classification';

/**
 * CAN-5334: the user-only discard of one listed live worktree whose ordinary
 * removal cannot finish. Describe is read-only and never enters the deletion
 * envelope (which hides the row). The discard re-describes under that
 * envelope and the archive lock, binds to the confirmed description, verifies
 * before its first journal write, and then removes only the confirmed
 * targets. It is unkeyed, and never reached from Auto Delete, automations,
 * boot recovery or a failed agent deletion (see the import-boundary test).
 */

/** The interface a discard came from; both are user-only. */
export type WorktreeDiscardSourceInterface = 'desktop-ui' | 'portal-ui';

interface PlannedTarget {
  kind: WorktreeDiscardTargetKind;
  path: string;
  /** Where the removal moves it first; an interrupted one may leave it there. */
  asidePath: string;
  /** `path` or `asidePath`: where the target is now. */
  location: string;
  identity: string;
  allowedRoot: string;
}

interface PlannedSource {
  repoId: string;
  path: string;
  relativePath: string;
  state: WorktreeDiscardSource['state'];
  gitCommonDir?: string;
}

type RecordedRepository = ArchivedGitStagedDescriptor['repositories'][number];

/** One source's entries in the staged descriptor. */
interface RecordedRefs {
  /** Those naming the snapshot ref the host derives for this worktree. */
  own: RecordedRepository[];
  /** How many name any other ref, which is kept and never read (review r8). */
  foreign: number;
}

/**
 * The descriptor is shape-checked only, so each named ref is compared with
 * the host-derived one for the bound workspace, worktree and source.
 */
function recordedRefsOf(
  descriptor: ArchivedGitStagedDescriptor | null,
  workspaceId: string,
  worktreeId: string,
): (repoId: string) => RecordedRefs {
  return (repoId) => {
    const ownRef = buildArchivedContainerSnapshotRef(
      workspaceId,
      worktreeId,
      repoId,
    );
    const named = (descriptor?.repositories ?? []).filter(
      (repository) => repository.repoId === repoId,
    );
    const own = named.filter((repository) => repository.snapshotRef === ownRef);
    return { own, foreign: named.length - own.length };
  };
}

interface CheckoutPaths {
  canonicalPath: string;
  quarantinePath: string;
}

/** The host-derived paths Git may have registered this source's checkout at. */
function registeredCheckoutsOf(
  source: PlannedSource,
  paths: CheckoutPaths,
): string[] {
  return [paths.canonicalPath, paths.quarantinePath].map((root) =>
    source.relativePath === '.' ? root : join(root, source.relativePath),
  );
}

/**
 * Read-only, and the same look for the description and the cleanup. A source
 * repointed since the capture, or replaced by another repository at the same
 * path, is not the recorded repository: its metadata stays where it was.
 * Registrations are read from the source repository's own entries, never
 * from a checkout's `.git`. `earlierCleaned`: an earlier attempt of this
 * discard recorded `cleaned` for the source.
 */
async function observeGitSource(
  source: PlannedSource,
  recorded: RecordedRefs,
  paths: CheckoutPaths,
  earlierCleaned: boolean,
): Promise<{
  observed: GitSourceObservation;
  gitCommonDir: string | null;
  error?: string;
}> {
  const unreached: GitSourceObservation = {
    reachable: false,
    recordedHere: true,
    registered: false,
    refsNamed: recorded.own.length + recorded.foreign,
    refsForeign: recorded.foreign,
    refsDeletable: 0,
    gitFailed: false,
  };
  if (source.state !== 'available' || !source.gitCommonDir)
    return { observed: unreached, gitCommonDir: null };
  try {
    const common = await getGitCommonDir(source.path);
    if (common !== source.gitCommonDir)
      return { observed: unreached, gitCommonDir: null };
    const registered =
      earlierCleaned ||
      (await hasWorktreeRegistration(
        common,
        registeredCheckoutsOf(source, paths),
      ));
    let recordedHere = true;
    let refsDeletable = 0;
    for (const repository of recorded.own) {
      const recordedCommon = await getGitCommonDir(
        repository.referenceRepoPath,
      ).catch(() => null);
      if (recordedCommon !== common) {
        recordedHere = false;
        continue;
      }
      // The same path can hold another repository: only the captured one has
      // the snapshot commit.
      const snapshot = await inspectArchivedContainerSnapshotRef({
        repoPath: source.path,
        refName: repository.snapshotRef,
        expectedCommit: repository.worktreeSnapshotCommit,
      });
      if (!snapshot.commitPresent) recordedHere = false;
      if (snapshot.ref !== 'other') refsDeletable += 1;
    }
    return {
      observed: {
        ...unreached,
        reachable: true,
        recordedHere,
        registered,
        refsDeletable,
      },
      gitCommonDir: common,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      observed: { ...unreached, reachable: true, gitFailed: true },
      gitCommonDir: null,
    };
  }
}

/** The description's per-source prediction, from `observeGitSource`. */
async function predictGitCleanup(
  sources: readonly PlannedSource[],
  recordedOf: (repoId: string) => RecordedRefs,
  paths: CheckoutPaths,
  earlier: ReadonlyMap<string, GitCleanupOutcome> = new Map(),
): Promise<{ repoId: string; facts: GitCleanupFacts }[]> {
  const predicted: { repoId: string; facts: GitCleanupFacts }[] = [];
  for (const source of sources) {
    const { observed } = await observeGitSource(
      source,
      recordedOf(source.repoId),
      paths,
      earlier.get(source.repoId) === 'cleaned',
    );
    predicted.push({
      repoId: source.repoId,
      facts: predictedGitCleanupFacts(observed),
    });
  }
  return predicted;
}

function gitRefEvidenceOf(
  descriptor: ArchivedGitStagedDescriptor | null,
): GitRefEvidence {
  return descriptor
    ? {
        state: 'read',
        repoIds: descriptor.repositories.map((repository) => repository.repoId),
      }
    : { state: 'absent' };
}

interface DiscardPlan {
  createdAt: string;
  row: WorktreeData | null;
  /** The stranded record a fresh discard supersedes. */
  supersede?: DestructiveRecoveryRecord;
  /** The interrupted discard a retry resumes. */
  resume?: DestructiveRecoveryRecord;
  targets: PlannedTarget[];
  /** Paths that must stay absent (identity null). */
  protectedPaths: { path: string; identity: null }[];
  sources: PlannedSource[];
  canonicalPath: string;
  quarantinePath: string;
}

interface Inspection {
  description: WorktreeDiscardDescription;
  plan?: DiscardPlan;
  /** CAN-5338: a retained archive's discard, described only on opt-in. */
  retained?: RetainedArchivePlan;
}

class DiscardRefused extends Error {
  constructor(readonly result: WorktreeDiscardResult & { status: 'refused' }) {
    super('The worktree discard was refused.');
    this.name = 'DiscardRefused';
  }
}

function quarantinePathOf(canonicalPath: string, worktreeId: string): string {
  return join(dirname(canonicalPath), `.${worktreeId}.archive-quarantine`);
}

/** A target's aside: a sibling only its discard uses (see `removeTarget`). */
function discardAsidePathOf(
  path: string,
  worktreeId: string,
  kind: WorktreeDiscardTargetKind,
): string {
  return join(dirname(path), `.${worktreeId}.discard-aside-${kind}`);
}

function statIdentity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

function parseStatIdentity(
  identity: string,
): { dev: number; ino: number; birthtimeMs: number } | null {
  const parts = identity.split(':');
  if (parts.length !== 3) return null;
  const [dev, ino, birthtimeMs] = parts.map(Number);
  return [dev, ino, birthtimeMs].every(Number.isFinite)
    ? { dev, ino, birthtimeMs }
    : null;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** JSON with sorted object keys, so equal descriptions hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Binds every field the user was shown, including sibling dirty flags. */
function confirmationOf(
  description: Omit<WorktreeDiscardDescription, 'confirmation'>,
  plan: DiscardPlan | undefined,
): string {
  return createHash('sha256')
    .update(
      canonicalJson([
        description,
        plan?.supersede?.operationId ?? null,
        plan?.supersede?.steps.length ?? null,
        plan?.resume?.operationId ?? null,
        plan?.resume?.steps.length ?? null,
      ]),
    )
    .digest('hex');
}

function finish(
  description: Omit<WorktreeDiscardDescription, 'confirmation'>,
  plan?: DiscardPlan,
): Inspection {
  return {
    description: {
      ...description,
      confirmation: confirmationOf(description, plan),
    },
    ...(description.status === 'discardable' && plan ? { plan } : {}),
  };
}

/**
 * Every included source: the configured candidates, each classified. `scope`
 * narrows them to the repositories a resumed discard recorded.
 */
async function classifySources(
  workspaceId: string,
  worktree: WorktreeData,
  config: WorkspaceConfigFile,
  scope: ReadonlySet<string> | null,
): Promise<PlannedSource[]> {
  const candidates = (
    await readConfiguredWorktreeSourceCandidates(workspaceId, worktree, config)
  ).filter((candidate) => !scope || scope.has(candidate.repoId));
  const gitUsable = await isGitUsable();
  const sources: PlannedSource[] = [];
  for (const candidate of candidates) {
    const classified = gitUsable
      ? await classifyWorktreeSource(candidate.referenceRepoPath)
      : { state: 'unverified' as const };
    sources.push({
      repoId: candidate.repoId,
      path: candidate.referenceRepoPath,
      relativePath: candidate.relativePath,
      state: classified.state,
      ...(classified.gitCommonDir
        ? { gitCommonDir: classified.gitCommonDir }
        : {}),
    });
  }
  return sources;
}

function publicSources(sources: PlannedSource[]): WorktreeDiscardSource[] {
  return sources.map(({ repoId, path, state }) => ({ repoId, path, state }));
}

/**
 * A row-absent discard journal that only its cleanup tail has left. An attempt
 * journals the row removal only after all of its own `discard:*` steps
 * finished; an earlier failed attempt's pending steps stay in the record.
 */
function isMissingRowResume(record: DestructiveRecoveryRecord): boolean {
  return record.steps.some((step) => step.phase === 'canonical-row-removal');
}

function targetKindOfOwnedPath(
  path: string,
  plan: Pick<DiscardPlan, 'canonicalPath' | 'quarantinePath'>,
  workspaceId: string,
  worktreeId: string,
  record: DestructiveRecoveryRecord,
): WorktreeDiscardTargetKind | null {
  if (path === plan.quarantinePath) return 'git-quarantine';
  if (path === getArchivedContainerDir(workspaceId, worktreeId))
    return 'files-only-recovery';
  if (path !== plan.canonicalPath) return null;
  return record.ownedPaths.some(
    (owned) => owned.path === plan.quarantinePath && owned.identity !== null,
  )
    ? 'recreated-checkout-path'
    : 'live-checkout';
}

const TARGET_REASON_PREFERENCE: Record<
  WorktreeDiscardTargetKind,
  readonly WorktreeDiscardCause[]
> = {
  'git-quarantine': ['pending-checkout-quarantine', 'stranded-removal-journal'],
  'recreated-checkout-path': [
    'pending-checkout-quarantine',
    'stranded-removal-journal',
  ],
  'live-checkout': ['stranded-removal-journal', 'source-gone'],
  'files-only-recovery': ['stranded-removal-journal', 'source-gone'],
  // CAN-5338: described by `retained-archive-discard.ts`, never here.
  'retained-archive': ['source-gone', 'archive-recovery-unverified'],
};

/** The cause a target blocks under: the most specific one present. */
function targetReason(
  kind: WorktreeDiscardTargetKind,
  causes: readonly WorktreeDiscardCause[],
): WorktreeDiscardCause {
  if (causes.includes('interrupted-discard')) return 'interrupted-discard';
  return (
    TARGET_REASON_PREFERENCE[kind].find((cause) => causes.includes(cause)) ??
    causes[0] ??
    'stranded-removal-journal'
  );
}

function allowedRootOf(
  kind: WorktreeDiscardTargetKind,
  workspaceId: string,
): string {
  return kind === 'files-only-recovery'
    ? getArchivedContainersRootDir(workspaceId)
    : getWorkspaceWorktreesRootDir(workspaceId);
}

async function describeRepositories(
  target: string,
  sources: PlannedSource[],
): Promise<NonNullable<WorktreeDiscardTarget['repositories']>> {
  const repositories: NonNullable<WorktreeDiscardTarget['repositories']> = [];
  for (const source of sources) {
    const path =
      source.relativePath === '.' ? target : join(target, source.relativePath);
    const present = await lstatOrNull(path).catch(() => null);
    if (!present?.isDirectory()) continue;
    repositories.push({
      repoId: source.repoId,
      relativePath: source.relativePath,
      ...(source.state === 'available'
        ? { uncommittedChanges: await readUncommittedChanges(path) }
        : {}),
    });
  }
  return repositories;
}

interface WorktreeDiscardDescribeOptions {
  /**
   * CAN-5337: describe as if the project's interrupted deletion were already
   * superseded; for the project-level description only, after it verified
   * that journal. A discard never takes it: it refuses until that journal is
   * gone, and the description's token does not cover it.
   */
  readonly ignoreInterruptedDeletion?: boolean;
  /**
   * CAN-5338: with no row and no unfinished journal, describe the retained
   * archive of this id instead of refusing `not-found`. Only a caller that
   * renders its targets opts in; without it nothing here changes.
   */
  readonly retainedArchives?: boolean;
}

/** The read-only description, also the discard's binding (CAN-5334 §2). */
async function inspectWorktreeDiscard(
  workspaceId: string,
  worktreeId: string,
  options: WorktreeDiscardDescribeOptions = {},
): Promise<Inspection> {
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  const canonicalPath = resolve(
    getWorkspaceWorktreeDir(workspaceId, worktreeId),
  );
  const quarantinePath = quarantinePathOf(canonicalPath, worktreeId);
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
  const refuse = (
    reason: WorktreeDiscardRefusal,
    extra: Partial<Omit<WorktreeDiscardDescription, 'confirmation'>> = {},
    retry?: WorktreeDiscardRetry,
  ): Inspection =>
    finish({
      ...base,
      ...extra,
      status: 'refused',
      refusal: { reason, ...(retry ? { retry } : {}) },
    });
  if (!isWritableScope(workspaceId)) return refuse('read-only-scope');

  let journal: DestructiveRecoveryRecord | null;
  try {
    journal = await readDestructiveRecovery(workspaceId, worktreeId);
  } catch {
    return refuse('evidence-unreadable');
  }
  const unfinished =
    journal !== null && journal.state !== 'completed' ? journal : null;
  let list: Awaited<ReturnType<typeof readWorkspaceWorktreesDetailed>>;
  try {
    list = await readWorkspaceWorktreesDetailed(workspaceId, {
      persistRemovalCleanup: false,
    });
  } catch {
    return refuse('list-unreadable');
  }
  if (list.authority !== 'ok' && list.authority !== 'absent')
    return refuse('list-unreadable');
  const row = list.worktrees.find((worktree) => worktree.id === worktreeId);
  const interrupted =
    unfinished !== null && isWorktreeDiscardRecord(unfinished)
      ? unfinished
      : null;
  if (!row && unfinished === null && options.retainedArchives === true) {
    const retained = await inspectRetainedArchiveDiscard(
      workspaceId,
      worktreeId,
      options,
    );
    return {
      description: retained.description,
      ...(retained.plan ? { retained: retained.plan } : {}),
    };
  }
  if (!row && !(interrupted && isMissingRowResume(interrupted)))
    return refuse('not-found');
  const createdAt = row?.createdAt ?? interrupted?.createdAt ?? '';
  const known = { createdAt };
  if (unfinished && unfinished.createdAt !== createdAt)
    return refuse('other-incarnation', known);
  if (unfinished && !isDestructiveRecoveryOwnerless(unfinished))
    return refuse('busy', known);

  let config: WorkspaceConfigFile;
  try {
    const detail = await readWorkspaceConfigDetailed(workspaceId);
    if (detail.authority !== 'ok')
      return refuse('configuration-unreadable', known);
    config = detail.config;
  } catch {
    return refuse('configuration-unreadable', known);
  }
  if (config.type === 'cowork') return refuse('unsupported-workspace', known);
  if (config.type === 'single-repo' && !config.repoPath)
    return refuse('configuration-unreadable', known);
  try {
    // Every scanner parses every journal; an unreadable one refuses here too.
    await readWorkspaceDestructiveRecoveries(workspaceId);
    if (
      options.ignoreInterruptedDeletion !== true &&
      (await hasUnfinishedWorkspaceDeletion(workspaceId))
    )
      return refuse('project-deletion-pending', known);
  } catch {
    return refuse('evidence-unreadable', known);
  }

  // Without its row, a resume names only the sources its journal recorded.
  const worktree: WorktreeData = row ?? {
    id: worktreeId,
    branchName: '',
    createdAt,
  };
  const scope = !row && interrupted ? missingRowSourceScope(interrupted) : null;
  let sources: PlannedSource[];
  try {
    sources = await classifySources(workspaceId, worktree, config, scope);
  } catch {
    return refuse('configuration-unreadable', known);
  }
  const described = { ...base, ...known, sources: publicSources(sources) };
  // A checkout or quarantine lists its repositories and their dirty flags,
  // which the confirmation then binds, on a resume too.
  const publicTargetOf = async (
    target: PlannedTarget,
    reason: WorktreeDiscardCause,
  ): Promise<WorktreeDiscardTarget> => ({
    kind: target.kind,
    path: target.location,
    identity: target.identity,
    identityVerified: target.kind === 'recreated-checkout-path',
    reason,
    ...(target.kind === 'files-only-recovery'
      ? {}
      : { repositories: await describeRepositories(target.location, sources) }),
  });
  const targetOf = (
    kind: WorktreeDiscardTargetKind,
    path: string,
    identity: string,
  ): PlannedTarget => ({
    kind,
    path,
    asidePath: discardAsidePathOf(path, worktreeId, kind),
    location: path,
    identity,
    allowedRoot: allowedRootOf(kind, workspaceId),
  });
  const deletedData: WorktreeDiscardDescription['alsoDeleted'] = [
    'chats',
    'plans',
    'attachments',
    'cost-history',
  ];

  if (interrupted) {
    // §1.14: the discard journal and the superseded copy are the only
    // evidence; half-removed domain journals are never re-read.
    const targets: PlannedTarget[] = [];
    for (const owned of interrupted.ownedPaths) {
      const kind = targetKindOfOwnedPath(
        owned.path,
        { canonicalPath, quarantinePath },
        workspaceId,
        worktreeId,
        interrupted,
      );
      const asidePath = kind
        ? discardAsidePathOf(owned.path, worktreeId, kind)
        : null;
      let actual: string | null;
      let aside: string | null;
      try {
        actual = await readDirectoryStatIdentity(owned.path);
        aside = asidePath ? await readDirectoryStatIdentity(asidePath) : null;
      } catch {
        return refuse('unverifiable-target', described);
      }
      if (actual === null && aside === null) continue;
      // Moved aside by the interrupted removal, or still in place; never both.
      const expected =
        owned.identity === null ? null : statIdentityOf(owned.identity);
      if (
        expected === null ||
        (actual !== null && actual !== expected) ||
        (aside !== null && aside !== expected)
      )
        return refuse('unverifiable-target', described);
      if (!kind || !asidePath) continue;
      targets.push({
        ...targetOf(kind, owned.path, expected),
        location: aside !== null ? asidePath : owned.path,
      });
    }
    const plan: DiscardPlan = {
      createdAt,
      row: row ?? null,
      resume: interrupted,
      targets,
      protectedPaths: [],
      sources,
      canonicalPath,
      quarantinePath,
    };
    const resumedTargets: WorktreeDiscardTarget[] = [];
    for (const target of targets)
      resumedTargets.push(await publicTargetOf(target, 'interrupted-discard'));
    // Read only to name the refs that may remain, never to refuse (§1.14).
    // Once the recovery data's removal started, an absent descriptor may have
    // named refs too.
    const read = await readGitRefEvidence(workspaceId, worktreeId);
    let { evidence } = read;
    if (
      evidence.state === 'absent' &&
      interrupted.steps.some(
        (step) => step.phase === 'discard:target:files-only-recovery',
      )
    )
      evidence = { state: 'unknown' };
    const gitCleanupDone = interrupted.steps.some(
      (step) => step.phase === 'discard:git-cleanup' && step.state === 'done',
    );
    return finish(
      {
        ...described,
        status: 'discardable',
        causes: ['interrupted-discard'],
        targets: resumedTargets,
        alsoDeleted: [
          ...deletedData,
          ...(targets.some((target) => target.kind === 'files-only-recovery')
            ? (['retained-payload-copy'] as const)
            : []),
        ],
        mayRemain: gitResidueOf(
          await predictGitCleanup(
            sources,
            recordedRefsOf(read.descriptor, workspaceId, worktreeId),
            { canonicalPath, quarantinePath },
            recordedGitCleanup(interrupted),
          ),
          evidence,
          gitCleanupDone ? recordedGitCleanup(interrupted) : undefined,
        ),
      },
      plan,
    );
  }
  if (!row) return refuse('not-found', described);

  let descriptor: ArchivedGitStagedDescriptor | null;
  let recoveryJournal: Awaited<
    ReturnType<typeof readArchivedContainerRecoveryJournal>
  >;
  let canonical: Stats | null;
  let quarantine: Stats | null;
  let container: Stats | null;
  let manifestPresent: boolean;
  let asideOccupied: boolean;
  try {
    descriptor = await readArchivedGitStagedDescriptor(
      workspaceId,
      worktreeId,
      {
        readOnly: true,
        recoveryOnly: true,
      },
    );
    recoveryJournal = await readArchivedContainerRecoveryJournal(
      workspaceId,
      worktreeId,
    );
    [canonical, quarantine, container] = await Promise.all([
      lstatOrNull(canonicalPath),
      lstatOrNull(quarantinePath),
      lstatOrNull(getArchivedContainerDir(workspaceId, worktreeId)),
    ]);
    manifestPresent =
      (await lstatOrNull(
        getArchivedContainerManifestPath(workspaceId, worktreeId),
      )) !== null;
    const asides = await Promise.all(
      REMOVAL_ORDER.map((kind) =>
        lstatOrNull(
          discardAsidePathOf(
            kind === 'files-only-recovery'
              ? getArchivedContainerDir(workspaceId, worktreeId)
              : kind === 'git-quarantine'
                ? quarantinePath
                : canonicalPath,
            worktreeId,
            kind,
          ),
        ),
      ),
    );
    asideOccupied = asides.some((aside) => aside !== null);
  } catch {
    return refuse('evidence-unreadable', described);
  }
  // Only an interrupted discard leaves an aside; any other occupant is foreign.
  if (asideOccupied) return refuse('unverifiable-target', described);
  const teardown = descriptor?.teardown;
  if (
    (teardown &&
      (resolve(teardown.canonicalPath) !== canonicalPath ||
        resolve(teardown.quarantinePath) !== quarantinePath)) ||
    (recoveryJournal && recoveryJournal.createdAt !== createdAt) ||
    descriptor?.repositories.some((repository) => {
      // A repointed source disagrees with its capture: conservative refusal.
      const source = sources.find(
        (candidate) => candidate.repoId === repository.repoId,
      );
      return (
        !source ||
        resolve(source.path) !== resolve(repository.referenceRepoPath)
      );
    }) === true
  )
    return refuse('evidence-mismatch', described);

  if (manifestPresent) {
    // Q4 A: a committed archive is F's (CAN-5345), or its verified cleanup's.
    const manifest = await readArchivedContainerManifestIncludingExpired(
      workspaceId,
      worktreeId,
    ).catch(() => null);
    if (
      unfinished &&
      (manifest?.version === 2 || manifest?.version === 3) &&
      manifest.kind === 'worktree' &&
      manifest.createdAt === createdAt &&
      (await canFinishArchiveCleanup(unfinished, createdAt, manifest.version))
    )
      return refuse('retry-available', described, 'finish-archive-cleanup');
    return refuse('retained-archive', described);
  }
  if (sources.some((source) => source.state === 'unverified'))
    return refuse('source-unverified', described);

  const causes: WorktreeDiscardCause[] = [];
  if (unfinished) causes.push('stranded-removal-journal');
  const recordedCheckoutEntry = unfinished?.ownedPaths.find(
    (owned) => owned.path === canonicalPath,
  );
  const recordedCheckout = recordedCheckoutEntry?.identity;
  const quarantineIdentity = quarantine ? statIdentity(quarantine) : null;
  const recordedQuarantine = teardown?.quarantineIdentity;
  const quarantineBound =
    quarantine !== null &&
    quarantine.isDirectory() &&
    !quarantine.isSymbolicLink() &&
    ((recordedCheckout != null &&
      statIdentityOf(recordedCheckout) === quarantineIdentity) ||
      (recordedQuarantine !== undefined &&
        recordedQuarantine.dev === quarantine.dev &&
        recordedQuarantine.ino === quarantine.ino &&
        recordedQuarantine.birthtimeMs === quarantine.birthtimeMs &&
        // Q5 A: without a journal, only a quarantine entered by this incarnation.
        (unfinished !== null ||
          (teardown !== undefined &&
            Date.parse(teardown.enteredAt) >= Date.parse(createdAt)))));
  if (quarantine && !quarantineBound)
    return refuse('unverifiable-target', described);
  if (teardown?.phase === 'quarantine-pending' && quarantine)
    causes.push('pending-checkout-quarantine');
  const someGone = sources.some(
    (source) =>
      source.state === 'gone-absent' ||
      source.state === 'gone-not-a-repository',
  );
  if (
    someGone &&
    (await isWorktreeArchiveSourceUnavailable(workspaceId, row, config.type))
  )
    causes.push('source-gone');

  let verifyAtDiscard: WorktreeDiscardDescription['verifyAtDiscard'];
  if (unfinished) {
    // Source admission (CAN-5158) and owned-path guards can refuse that redo.
    // CAN-5717 admission alone must not hide an existing discard escape hatch.
    if (
      canResumeInterruptedArchive(unfinished) &&
      (await areOwnedPathsUnreplaced(unfinished).catch(() => false)) &&
      !causes.includes('source-gone')
    )
      return refuse('retry-available', described, 'remove-worktree');
    if (isResumableChildArchiveFailure(unfinished, 'workspace-delete')) {
      const redoRefused =
        !(await areOwnedPathsUnreplaced(unfinished).catch(() => false)) ||
        (teardown?.phase === 'quarantine-pending' &&
          (canonical !== null) === (quarantine !== null)) ||
        causes.includes('source-gone');
      if (!redoRefused) {
        if (
          teardown?.phase === 'quarantine-pending' &&
          quarantine !== null &&
          canonical === null
        )
          verifyAtDiscard = 'quarantine-against-snapshots';
        else return refuse('retry-available', described, 'delete-project');
      }
    }
  }
  if (causes.length === 0) return refuse('no-broken-removal', described);

  const targets: PlannedTarget[] = [];
  const protectedPaths: DiscardPlan['protectedPaths'] = [];
  if (canonical) {
    if (!canonical.isDirectory() || canonical.isSymbolicLink())
      return refuse('unverifiable-target', described);
    if (quarantine) {
      // Q3 B: a real directory recreated at the managed checkout path, inside
      // the app's workspace root, with a verified CAN-5024 identity.
      const [parent, root, project] = await Promise.all([
        realpath(dirname(canonicalPath)),
        realpath(getWorkspaceWorktreesRootDir(workspaceId)),
        realpath(getWorkspaceDir(workspaceId)),
      ]).catch(() => [null, null, null]);
      const identity = await probeProtectedPathIdentity(
        canonicalPath,
        workspaceId,
      ).catch(() => null);
      if (
        parent === null ||
        parent !== root ||
        project === null ||
        !isPathInside(project, join(parent, worktreeId)) ||
        identity === null ||
        !isVerifiedProtectedPathIdentity(identity) ||
        identity !== statIdentity(canonical)
      )
        return refuse('unverifiable-target', described);
      targets.push(
        targetOf('recreated-checkout-path', canonicalPath, identity),
      );
    } else {
      // A journal binds the checkout it recorded; never a later occupant, nor
      // one where it recorded none.
      if (
        recordedCheckoutEntry !== undefined &&
        (recordedCheckout == null ||
          statIdentityOf(recordedCheckout) !== statIdentity(canonical))
      )
        return refuse('unverifiable-target', described);
      targets.push(
        targetOf('live-checkout', canonicalPath, statIdentity(canonical)),
      );
    }
  } else protectedPaths.push({ path: canonicalPath, identity: null });
  if (quarantine && quarantineIdentity)
    targets.push(
      targetOf('git-quarantine', quarantinePath, quarantineIdentity),
    );
  if (container) {
    if (!container.isDirectory() || container.isSymbolicLink())
      return refuse('unverifiable-target', described);
    targets.push(
      targetOf(
        'files-only-recovery',
        getArchivedContainerDir(workspaceId, worktreeId),
        statIdentity(container),
      ),
    );
  }

  const publicTargets: WorktreeDiscardTarget[] = [];
  for (const target of targets)
    publicTargets.push(
      await publicTargetOf(target, targetReason(target.kind, causes)),
    );
  const plan: DiscardPlan = {
    createdAt,
    row,
    ...(unfinished ? { supersede: unfinished } : {}),
    targets,
    protectedPaths,
    sources,
    canonicalPath,
    quarantinePath,
  };
  return finish(
    {
      ...described,
      status: 'discardable',
      causes,
      targets: publicTargets,
      alsoDeleted: [
        ...deletedData,
        ...(container ? (['retained-payload-copy'] as const) : []),
      ],
      mayRemain: gitResidueOf(
        await predictGitCleanup(
          sources,
          recordedRefsOf(descriptor, workspaceId, worktreeId),
          { canonicalPath, quarantinePath },
        ),
        gitRefEvidenceOf(descriptor),
      ),
      ...(verifyAtDiscard ? { verifyAtDiscard } : {}),
    },
    plan,
  );
}

/** Read-only. Its CAN-5024 probe of a recreated path creates and removes `.w5-birth-order-*`. */
export async function describeWorktreeDiscard(
  workspaceId: string,
  worktreeId: string,
  options?: WorktreeDiscardDescribeOptions,
): Promise<WorktreeDiscardDescription> {
  return (await inspectWorktreeDiscard(workspaceId, worktreeId, options))
    .description;
}

function refusedWith(
  inspection: Inspection,
  reason: WorktreeDiscardRefusal,
  retry?: WorktreeDiscardRetry,
): DiscardRefused {
  const { confirmation: _confirmation, ...rest } = inspection.description;
  void _confirmation;
  return new DiscardRefused({
    status: 'refused',
    reason,
    description: finish({
      ...rest,
      status: 'refused',
      refusal: { reason, ...(retry ? { retry } : {}) },
    }).description,
  });
}

/** The split, live-delegate and background-work safeguards archive applies. */
function admissionRefusal(inspection: Inspection): DiscardRefused | null {
  const { workspaceId, worktreeId } = inspection.description;
  try {
    assertNotSplitLocked(workspaceId, worktreeId, 'discarding the worktree');
    assertNotSplitDestinationWorktreeClaimed(
      workspaceId,
      worktreeId,
      'discarding the worktree',
    );
    assertWorktreeCanBeRemoved(workspaceId, worktreeId);
    return null;
  } catch {
    return refusedWith(inspection, 'busy');
  }
}

/** The refusal for a description that no longer matches the confirmation. */
function bindingRefusal(
  inspection: Inspection,
  confirmation: string,
): DiscardRefused | null {
  const { description } = inspection;
  if (
    description.status !== 'discardable' ||
    (!inspection.plan && !inspection.retained)
  )
    return new DiscardRefused({
      status: 'refused',
      reason: description.refusal?.reason ?? 'no-broken-removal',
      description,
    });
  if (description.confirmation !== confirmation)
    return new DiscardRefused({
      status: 'refused',
      reason: 'changed',
      description,
    });
  return null;
}

/**
 * The worker moves the target to its aside before removing it, so a directory
 * that reoccupies the path during the walk is never reached (review r1
 * finding 1). A retry after a crash between the move and the removal finds the
 * target at its aside and finishes it there.
 */
async function removeTarget(
  workspaceId: string,
  worktreeId: string,
  createdAt: string,
  target: PlannedTarget,
): Promise<void> {
  const [actual, aside] = await Promise.all([
    readDirectoryStatIdentity(target.path),
    readDirectoryStatIdentity(target.asidePath),
  ]);
  if (actual === null && aside === null) return;
  const expected = statIdentityOf(target.identity);
  const expectedIdentity = parseStatIdentity(expected);
  if (
    (actual !== null && actual !== expected) ||
    (aside !== null && aside !== expected) ||
    !expectedIdentity
  )
    throw new Error('A discard target changed identity; it was preserved.');
  await runArchiveIoRequest({
    version: 1,
    type: 'remove-directory',
    requestId: randomUUID(),
    operationId: `discard:${workspaceId}:${worktreeId}:${target.kind}`,
    projectId: workspaceId,
    containerId: worktreeId,
    expectedCreatedAt: createdAt,
    input: {
      path: target.path,
      allowedRoot: target.allowedRoot,
      expectedIdentity,
      asidePath: target.asidePath,
    },
  });
}

/** Read-only and never refusing: an unreadable descriptor is `unknown` evidence. */
async function readGitRefEvidence(
  workspaceId: string,
  worktreeId: string,
): Promise<{
  evidence: GitRefEvidence;
  descriptor: ArchivedGitStagedDescriptor | null;
}> {
  try {
    const descriptor = await readArchivedGitStagedDescriptor(
      workspaceId,
      worktreeId,
      { readOnly: true, recoveryOnly: true },
    );
    return { evidence: gitRefEvidenceOf(descriptor), descriptor };
  } catch {
    return { evidence: { state: 'unknown' }, descriptor: null };
  }
}

interface GitCleanupResult {
  error?: string;
  repoId: string;
  outcome: GitCleanupOutcome;
}

/**
 * Best effort and never `cleanupRequired`: Git's own entries for the removed
 * paths and this container's snapshot refs, in the recorded repository only,
 * from the configured path. It deletes only refs equal to the host-derived
 * name (`recordedRefsOf`); never branches, `prune` or `worktree remove
 * --force`. Each source's outcome comes from its facts alone.
 */
async function cleanUpGitMetadata(
  workspaceId: string,
  worktreeId: string,
  plan: DiscardPlan,
): Promise<GitCleanupResult[]> {
  const { evidence, descriptor } = await readGitRefEvidence(
    workspaceId,
    worktreeId,
  );
  const earlier = plan.resume
    ? recordedGitCleanup(plan.resume)
    : new Map<string, GitCleanupOutcome>();
  const recordedOf = recordedRefsOf(descriptor, workspaceId, worktreeId);
  const results: GitCleanupResult[] = [];
  for (const source of plan.sources) {
    const recorded = recordedOf(source.repoId);
    const checkouts = registeredCheckoutsOf(source, plan);
    const {
      observed,
      gitCommonDir,
      error: observationError,
    } = await observeGitSource(
      source,
      recorded,
      plan,
      earlier.get(source.repoId) === 'cleaned',
    );
    const facts = gitCleanupFactsBefore(observed);
    let failure = observationError;
    if (gitCleanupRuns(observed) && gitCommonDir !== null) {
      try {
        await removeAbsentWorktreeRegistrations(gitCommonDir, checkouts);
        facts.registrationsRemoved = !(await hasWorktreeRegistration(
          gitCommonDir,
          checkouts,
        ));
        for (const repository of recorded.own) {
          // Verifies the ref is absent afterwards, or throws.
          await deleteArchivedContainerSnapshotRef({
            repoPath: source.path,
            refName: repository.snapshotRef,
            expectedCommit: repository.worktreeSnapshotCommit,
          });
          facts.refsDeleted += 1;
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        facts.gitFailed = true;
      }
    }
    const outcome = gitCleanupOutcomeOf(evidence, facts);
    if (outcome === 'failed') {
      failure ??= !facts.registrationsRemoved
        ? 'Git registration remains after targeted cleanup'
        : 'Snapshot refs could not be safely removed';
      logMainProcessWarn('Worktree discard Git metadata cleanup failed', {
        workspaceId,
        worktreeId,
        repoId: source.repoId,
        error: failure,
      });
    }
    results.push({
      ...(failure ? { error: failure.slice(0, 4096) } : {}),
      repoId: source.repoId,
      outcome,
    });
  }
  return results;
}

interface DiscardOutcome extends ArchiveWorktreeResponse {
  removed: WorktreeDiscardTargetKind[];
  gitCleanup: WorktreeDiscardGitCleanup[];
}

const TARGET_PHASE_PREFIX = 'discard:target:';
/** One per repository, recorded inside `discard:git-cleanup` (phase strings only). */
const GIT_RESULT_PHASE_PREFIX = 'discard:git-result:';
/** The repository ids an attempt with the row used, as a JSON array; the last wins. */
const SOURCE_SET_PHASE_PREFIX = 'discard:source-set:';

function sourceSetPhaseOf(
  sources: readonly PlannedSource[],
): `discard:${string}` {
  return `${SOURCE_SET_PHASE_PREFIX}${JSON.stringify(
    sources.map((source) => source.repoId),
  )}`;
}

function lastSourceSetPhase(
  record: DestructiveRecoveryRecord | undefined,
): string | undefined {
  let last: string | undefined;
  for (const step of record?.steps ?? [])
    if (step.state === 'done' && step.phase.startsWith(SOURCE_SET_PHASE_PREFIX))
      last = step.phase;
  return last;
}

function recordedSourceSet(
  record: DestructiveRecoveryRecord,
): Set<string> | null {
  const phase = lastSourceSetPhase(record);
  if (phase === undefined) return null;
  try {
    const ids: unknown = JSON.parse(
      phase.slice(SOURCE_SET_PHASE_PREFIX.length),
    );
    return Array.isArray(ids) &&
      ids.every((id): id is string => typeof id === 'string')
      ? new Set(ids)
      : null;
  } catch {
    return null;
  }
}

/**
 * The sources a resume without its row reports. A journal from before the
 * source set was recorded falls back to the repositories its Git cleanup
 * recorded, which the row removal always follows: never the configuration,
 * which a placeholder row reads as every repository (review r5 finding 1).
 */
function missingRowSourceScope(
  record: DestructiveRecoveryRecord,
): ReadonlySet<string> {
  return (
    recordedSourceSet(record) ?? new Set(recordedGitCleanup(record).keys())
  );
}
const REMOVAL_ORDER: readonly WorktreeDiscardTargetKind[] = [
  'recreated-checkout-path',
  'live-checkout',
  'git-quarantine',
  'files-only-recovery',
];

/**
 * What an interrupted discard already removed: each target an earlier
 * attempt started on that is now gone, so the plan no longer lists it.
 */
function removedByEarlierAttempts(
  resume: DestructiveRecoveryRecord,
  remaining: readonly PlannedTarget[],
): WorktreeDiscardTargetKind[] {
  return REMOVAL_ORDER.filter(
    (kind) =>
      resume.steps.some(
        (step) => step.phase === `${TARGET_PHASE_PREFIX}${kind}`,
      ) && !remaining.some((target) => target.kind === kind),
  );
}

/** The finished Git cleanup's outcomes by repository; a rerun's later entry wins. */
function recordedGitCleanup(
  resume: DestructiveRecoveryRecord,
): Map<string, GitCleanupOutcome> {
  const byRepo = new Map<string, GitCleanupOutcome>();
  for (const step of resume.steps) {
    if (
      step.state !== 'done' ||
      !step.phase.startsWith(GIT_RESULT_PHASE_PREFIX)
    )
      continue;
    const rest = step.phase.slice(GIT_RESULT_PHASE_PREFIX.length);
    const separator = rest.indexOf(':');
    const outcome = GIT_CLEANUP_OUTCOMES.find(
      (candidate) => candidate === rest.slice(0, separator),
    );
    if (separator < 0 || !outcome) continue;
    byRepo.set(rest.slice(separator + 1), outcome);
  }
  return byRepo;
}

/**
 * A finished cleanup's results for a retry, in source order. As the
 * description counts it, a source it did not record did not finish.
 */
function resumedGitCleanup(
  resume: DestructiveRecoveryRecord,
  sources: readonly PlannedSource[],
): GitCleanupResult[] {
  const recorded = recordedGitCleanup(resume);
  return [
    ...sources.map((source) => ({
      repoId: source.repoId,
      outcome: recorded.get(source.repoId) ?? ('failed' as const),
    })),
    ...Array.from(recorded)
      .filter(([repoId]) => sources.every((source) => source.repoId !== repoId))
      .map(([repoId, outcome]) => ({ repoId, outcome })),
  ];
}

async function executeDiscard(
  workspaceId: string,
  worktreeId: string,
  plan: DiscardPlan,
  onLiveSessionsDestroyed: () => void,
  onArchiveDeletionCommitted: () => void,
): Promise<DiscardOutcome> {
  // A retry reports the whole discard: earlier attempts' journaled effects too.
  const removed = new Set<WorktreeDiscardTargetKind>(
    plan.resume ? removedByEarlierAttempts(plan.resume, plan.targets) : [],
  );
  let gitCleanup: GitCleanupResult[] = [];
  const readCreatedAt = async (): Promise<string | null> => {
    const list = await readWorkspaceWorktreesDetailed(workspaceId, {
      persistRemovalCleanup: false,
    });
    if (list.authority !== 'ok' && list.authority !== 'absent')
      throw new W5CommitRefusedError(
        'recovery-required',
        list.unserved
          ? `${list.unserved.message} The discard stopped.`
          : 'The worktree list is unreadable; the discard stopped.',
        { workspaceId, worktreeId, phase: 'discard-row' },
      );
    return (
      list.worktrees.find((worktree) => worktree.id === worktreeId)
        ?.createdAt ?? null
    );
  };
  const removedInOrder = (): WorktreeDiscardTargetKind[] =>
    REMOVAL_ORDER.filter((kind) => removed.has(kind));
  const supersedes =
    plan.supersede?.operationId ??
    (plan.resume ? supersededDiscardOperationId(plan.resume) : undefined);
  const stepDone = (phase: string): boolean =>
    plan.resume?.steps.some(
      (step) => step.phase === phase && step.state === 'done',
    ) === true;
  return withWorktreeDiscardLifecycle(
    {
      workspaceId,
      worktreeId,
      createdAt: plan.createdAt,
      ...(plan.supersede ? { supersede: plan.supersede } : {}),
      ...(plan.resume ? { resume: plan.resume } : {}),
      ownedPaths: [
        ...plan.targets.map((target) => ({
          path: target.path,
          identity: target.identity,
        })),
        ...plan.protectedPaths,
      ],
      readCreatedAt,
      projectOutcome: (outcome: DiscardOutcome) => ({
        success: outcome.success,
        warnings: outcome.warnings,
        ...(outcome.removedTemporaryWorkspaceId
          ? {
              removedTemporaryWorkspaceId: outcome.removedTemporaryWorkspaceId,
              removedTemporaryWorkspaceName:
                outcome.removedTemporaryWorkspaceName,
            }
          : {}),
        // Zod strips this from every archive outcome parse (§1.1).
        discard: { removed: outcome.removed, gitCleanup: outcome.gitCleanup },
      }),
    },
    async () => {
      const sourceSet = sourceSetPhaseOf(plan.sources);
      if (plan.row && lastSourceSetPhase(plan.resume) !== sourceSet)
        await destructiveStep(sourceSet, () => Promise.resolve());
      const response = await runWorktreeDiscardTail({
        workspaceId,
        worktreeId,
        createdAt: plan.createdAt,
        persistedWorktree: plan.row,
        turnDiffRepoPaths: plan.sources
          .filter((source) => source.state === 'available')
          .map((source) => source.path),
        liveServices: {
          cleanupLiveState: cleanupLiveWorktreeState,
          purgeObservabilityData: purgeLiveWorktreeObservabilityData,
        },
        onLiveSessionsDestroyed,
        onArchiveDeletionCommitted,
        removeTargets: async () => {
          for (const kind of REMOVAL_ORDER.filter(
            (candidate) => candidate !== 'files-only-recovery',
          ))
            for (const target of plan.targets.filter(
              (candidate) => candidate.kind === kind,
            )) {
              await destructiveStep(`${TARGET_PHASE_PREFIX}${kind}`, () =>
                removeTarget(workspaceId, worktreeId, plan.createdAt, target),
              );
              removed.add(kind);
            }
          if (plan.resume && stepDone('discard:git-cleanup'))
            gitCleanup = resumedGitCleanup(plan.resume, plan.sources);
          else
            gitCleanup = await destructiveStep(
              'discard:git-cleanup',
              async () => {
                const results = await cleanUpGitMetadata(
                  workspaceId,
                  worktreeId,
                  plan,
                );
                // Journaled before the step is done, so a retry reports them.
                for (const result of results)
                  await destructiveStep(
                    `${GIT_RESULT_PHASE_PREFIX}${result.outcome}:${result.repoId}`,
                    () => Promise.resolve(),
                    { error: result.error },
                  );
                return results;
              },
            );
          for (const target of plan.targets.filter(
            (candidate) => candidate.kind === 'files-only-recovery',
          )) {
            await destructiveStep(
              'discard:target:files-only-recovery',
              async () => {
                // A manifest committed since describe makes it a retained archive.
                if (
                  await lstatOrNull(
                    getArchivedContainerManifestPath(workspaceId, worktreeId),
                  )
                )
                  throw new Error(
                    'A retained archive appeared; its files were preserved.',
                  );
                await removeTarget(
                  workspaceId,
                  worktreeId,
                  plan.createdAt,
                  target,
                );
              },
            );
            removed.add(target.kind);
          }
          if (supersedes && !stepDone('discard:retire-superseded'))
            await destructiveStep('discard:retire-superseded', () =>
              retireSupersededDestructiveRecord(
                workspaceId,
                worktreeId,
                supersedes,
              ),
            );
          return gitCleanup.flatMap(
            (result) => gitCleanupWarning(result.outcome, result.repoId) ?? [],
          );
        },
      });
      return {
        ...response,
        removed: removedInOrder(),
        gitCleanup: gitCleanup.map((result) => ({
          repoId: result.repoId,
          status: publicGitCleanupStatus(result.outcome),
        })),
      };
    },
  );
}

/**
 * The user-only discard (CAN-5334). Resolves with a typed refusal instead of
 * throwing one; an unexpected failure still rejects. `source` records which
 * user interface asked.
 */
export async function discardWorktree(request: {
  workspaceId: string;
  worktreeId: string;
  confirmation: string;
  source: WorktreeDiscardSourceInterface;
  /** CAN-5338: the confirmed description lists a retained archive. */
  retainedArchives?: boolean;
}): Promise<WorktreeDiscardResult> {
  const { workspaceId, worktreeId, confirmation } = request;
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  const options: WorktreeDiscardDescribeOptions =
    request.retainedArchives === true ? { retainedArchives: true } : {};
  // Refuse before the envelope when nothing could match; a refusal inside it
  // is reported as an archive failure, so only a race reaches one there.
  const first = await inspectWorktreeDiscard(workspaceId, worktreeId, options);
  if (first.retained) {
    const unbound = bindingRefusal(first, confirmation);
    if (unbound) return unbound.result;
    return discardRetainedArchive(workspaceId, worktreeId, confirmation);
  }
  const early = bindingRefusal(first, confirmation) ?? admissionRefusal(first);
  if (early) return early.result;
  try {
    const outcome = await runWithWorktreeArchiveDeletionLifecycle(
      workspaceId,
      worktreeId,
      (onLiveSessionsDestroyed, onArchiveDeletionCommitted) =>
        withArchivedWorkspaceOperationLock(workspaceId, async () => {
          const fresh = await inspectWorktreeDiscard(workspaceId, worktreeId);
          const refusal =
            bindingRefusal(fresh, confirmation) ?? admissionRefusal(fresh);
          if (refusal) throw refusal;
          const plan = fresh.plan;
          if (!plan) throw refusedWith(fresh, 'no-broken-removal');
          if (fresh.description.verifyAtDiscard) {
            // Verify before any journal write; repair is the redo's own step.
            const verdict = await verifyArchivedGitQuarantineSnapshots(
              workspaceId,
              worktreeId,
            );
            if (verdict === 'match')
              throw refusedWith(fresh, 'retry-available', 'delete-project');
            if (verdict === 'error')
              throw refusedWith(fresh, 'source-unverified');
          }
          return executeDiscard(
            workspaceId,
            worktreeId,
            plan,
            onLiveSessionsDestroyed,
            onArchiveDeletionCommitted,
          );
        }),
    );
    return {
      status: 'discarded',
      removed: outcome.removed,
      gitCleanup: outcome.gitCleanup,
      warnings: outcome.warnings,
      ...(outcome.removedTemporaryWorkspaceId
        ? { removedTemporaryWorkspaceId: outcome.removedTemporaryWorkspaceId }
        : {}),
    };
  } catch (error) {
    if (error instanceof DiscardRefused) return error.result;
    throw error;
  }
}

/**
 * CAN-5338: the retained archive's discard. No row, so no deletion envelope:
 * the container operation lock (inside the workspace archive lock, the
 * order the ordinary deletion takes) serializes it with restore, retention
 * and the ordinary deletion. It re-describes and binds under that lock.
 */
async function discardRetainedArchive(
  workspaceId: string,
  worktreeId: string,
  confirmation: string,
): Promise<WorktreeDiscardResult> {
  let committed: RetainedArchivePlan | undefined;
  try {
    const outcome = await withArchivedContainerOperationLock(
      workspaceId,
      worktreeId,
      async () => {
        const fresh = await inspectWorktreeDiscard(workspaceId, worktreeId, {
          retainedArchives: true,
        });
        const refusal = bindingRefusal(fresh, confirmation);
        if (refusal) throw refusal;
        if (!fresh.retained) throw refusedWith(fresh, 'no-broken-removal');
        const result = await executeRetainedArchiveDiscard(fresh.retained);
        committed = fresh.retained;
        return result;
      },
    );
    if (committed) notifyLedgerOfArchivedContainerDeletion(committed.manifest);
    await retryDeferredTemporaryWorkspaceDeletion(workspaceId).catch(
      () => null,
    );
    return { status: 'discarded', ...outcome };
  } catch (error) {
    if (error instanceof DiscardRefused) return error.result;
    throw error;
  }
}

/** A refusal of an archive or delete that the discard description travels with. */
export function isDiscardDescribedArchiveRefusal(error: unknown): boolean {
  return (
    error instanceof WorktreeArchiveRefusedError ||
    (error instanceof W5CommitRefusedError &&
      error.reason === 'recovery-required')
  );
}

/**
 * CAN-5334 Q1 B: when an archive or delete request opts in with
 * `typedRefusal`, an ordinary refusal resolves with its reason and the discard
 * description instead of throwing. Without the flag nothing changes.
 *
 * CAN-5336 Q9 A: only a discardable description resolves. Any other refusal,
 * or one whose description can't be read, keeps its original throw, so an
 * unreadable-journal refusal still reaches its quarantine review.
 */
export async function withTypedArchiveRefusal<
  T extends ArchiveWorktreeResponse,
>(
  request: {
    typedRefusal?: boolean;
    workspaceId: string;
    worktreeId: string;
    archiveTrigger?: ArchiveTrigger;
  },
  run: () => Promise<T>,
): Promise<
  T | (ArchiveWorktreeResponse & { refusal: WorktreeArchiveTypedRefusal })
> {
  return withArchiveFailureTelemetry(request, async () => {
    try {
      return await run();
    } catch (error) {
      const discard = await describeWorktreeDiscard(
        request.workspaceId,
        request.worktreeId,
      ).catch(() => null);
      const offered =
        request.typedRefusal === true &&
        isDiscardDescribedArchiveRefusal(error) &&
        discard?.status === 'discardable';
      recordArchiveRefusal(error, discard, offered);
      if (!offered || discard?.status !== 'discardable') throw error;
      const reason =
        error instanceof WorktreeArchiveRefusedError ||
        error instanceof W5CommitRefusedError
          ? error.reason
          : 'recovery-required';
      return {
        success: false,
        warnings: [],
        refusal: {
          reason,
          message: error instanceof Error ? error.message : String(error),
          discard,
        },
      };
    }
  });
}

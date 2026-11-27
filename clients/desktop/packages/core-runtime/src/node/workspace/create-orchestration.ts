import { basename, dirname, isAbsolute } from 'node:path';
import {
  normalizeRepositoryCloneUrl,
  repositoryNameFromCloneUrl,
} from '@canopy/protocol/remote-control/shell';
import type { WorkspaceCreationRepository } from '../w5/commit-log/reservation-diagnostics';
import type {
  CoreWorkspaceAdditionDecision,
  CoreWorkspaceCreationDecision,
  W5LifecycleDecisionPort,
  W5LifecycleTypes,
} from '../w5/lifecycle-ports';

/*
 * Workspace create orchestration (CAN-4096 C1, C2, D) for
 * `core.workspace.create` and `core.workspace.import`: admission, variant
 * routing, the keyed request, the new-project publication, the post-commit
 * order, the remote clone and manifest import (reserve, record `started`,
 * clone through the worker, record `completed`, publish; member reuse and the
 * member locks), and the external project registration with its chat
 * destination. Core builds the W6a1 addition, creation and import decisions
 * from the host's items and applies them through P0's
 * `W5LifecycleDecisionPort`; the host supplies every read, reservation and
 * effect through the ports below. The external Cowork registration (W6a2) has
 * no P0 decision type, so its `publish` port wraps the host's create (plan
 * decision D1, design (a)).
 */

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type WorkspaceCreationRefusal =
  | 'name-required'
  | 'invalid-path'
  | 'missing-folder'
  | 'not-a-repository'
  | 'not-a-manifest'
  | 'not-importable'
  | 'already-tracked'
  | 'invalid-remote';

/**
 * A workspace create or import refused before it indexed anything (CAN-3806).
 * The message is the one the desktop has always shown.
 */
export class WorkspaceCreationRefusedError extends Error {
  constructor(
    readonly reason: WorkspaceCreationRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceCreationRefusedError';
  }
}

export function refuseWorkspaceCreation(
  reason: WorkspaceCreationRefusal,
  message: string,
): never {
  throw new WorkspaceCreationRefusedError(reason, message);
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The host types create orchestration carries. Core reads only an item's id
 * and sets its sidebar order; everything else stays the host's.
 */
export interface WorkspaceCreateTypes extends W5LifecycleTypes {
  readonly item: { readonly id: string; order: number };
  readonly singleRepoItem: { readonly id: string; order: number };
  readonly multiRepoItem: { readonly id: string; order: number };
  /** A multi-repo item's repositories. */
  readonly repos: unknown;
}

/**
 * The portable create and import variants. Local paths are trusted host
 * selections the adapter projected (CAN-3799 D8); none crosses a wire.
 * `Progress` is the host's live clone hooks.
 */
export type CoreWorkspaceCreationVariant<Progress> =
  /** A new repository under the managed repos directory. */
  | { kind: 'new-single-repo'; name: string }
  /** A new multi-repo project with its source repository. */
  | { kind: 'new-multi-repo'; name: string }
  /**
   * An existing folder: a repository, a multi-repo manifest repository, or a
   * plain folder imported as an external Cowork project.
   */
  | { kind: 'local-folder'; folderPath: string }
  /** A repository whose `canopy.json` declares a multi-repo project. */
  | { kind: 'repository-manifest'; repoPath: string }
  /** A repository registered without writing `canopy.json` into it. */
  | { kind: 'repository-without-manifest'; repoPath: string; name?: string }
  /** A clone of a remote repository into `destinationDir`. */
  | {
      kind: 'remote-clone';
      remoteUrl: string;
      destinationDir: string;
      progress?: Progress;
    };

export interface SingleRepoItemPlan {
  id: string;
  name: string;
  repoPath: string;
  order: number;
}

export interface MultiRepoItemPlan<T extends WorkspaceCreateTypes> {
  id: string;
  name: string;
  repos: T['repos'];
  sourceRepoPath: string;
  order: number;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A `canopy.json` member: the repository a manifest import clones or reuses. */
export interface ManifestMember {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

/** A member repository as the imported multi-repo project lists it. */
export interface ManifestMemberRepository {
  id: string;
  name: string;
  repoPath: string;
  manifestUrl: string;
}

/** A checkout the sidebar tracks, with its `origin` URL. */
export interface TrackedRepositoryRemote {
  repoName: string;
  repoPath: string;
  remoteUrl: string | null;
}

/** A project's own checkout (a single repo or a multi-repo source), with its `origin` URL. */
export interface WorkspaceRootRemote {
  repoPath: string;
  remoteUrl: string | null;
}

/** The host's sidebar reads and item vocabulary. */
export interface WorkspaceCreatePlanPort<T extends WorkspaceCreateTypes> {
  /** The live sidebar items, read inside `serialize`. */
  readItems(): Promise<T['item'][]>;
  /** A new single-repo item at `order`, with no worktrees. */
  singleRepoItem(plan: SingleRepoItemPlan): T['singleRepoItem'];
  /** A new multi-repo item at `order`, with no worktrees. */
  multiRepoItem(plan: MultiRepoItemPlan<T>): T['multiRepoItem'];
  /** A multi-repo item's repositories for these manifest members. */
  manifestRepositories(
    members: readonly ManifestMemberRepository[],
  ): T['repos'];
  /**
   * A free id for a new project named `name`: not in `taken`, not reserved by
   * a pending creation or a holder, and with no index entry or directory.
   */
  availableWorkspaceId(
    name: string,
    taken: readonly { readonly id: string }[],
  ): Promise<string>;
  /** The project tracking `repoPath` as its repository or multi-repo source. */
  trackingWorkspaceName(
    items: readonly T['item'][],
    repoPath: string,
  ): string | undefined;
  /** The multi-repo project whose source repository is `repoPath`. */
  manifestSourceWorkspaceName(
    items: readonly T['item'][],
    repoPath: string,
  ): string | undefined;
  /** Every repository checkout `items` track, single-repo or member. */
  repositoryRemotes(items: T['item'][]): Promise<TrackedRepositoryRemote[]>;
  /** Each single-repo checkout and multi-repo source repository. */
  workspaceRootRemotes(items: T['item'][]): Promise<WorkspaceRootRemote[]>;
}

/** The validated orphan records a reclaiming create expects, by fingerprint. */
export interface ExpectedWorkspaceRecords {
  manifest: string | null;
  worktrees: string | null;
}

/**
 * One creation identity across short queued preparation and the provisioning
 * that follows outside the queue.
 */
export interface WorkspaceCreationReservation {
  prepare<R>(work: () => Promise<R>): Promise<R>;
  run<R>(work: () => Promise<R>): Promise<R>;
  /** Drops the identity once its failed creation's owned paths are removed. */
  releaseRemoved(this: void): Promise<void>;
}

/** The host's creation identity reservation and boundary step. */
export interface WorkspaceCreateReservationPort {
  /** Commits `publish` in the create's boundary step, locking `workspaceIds`. */
  commit<R>(
    publish: () => Promise<R>,
    workspaceIds: readonly string[],
  ): Promise<R>;
  /** Marks the step's first potential effect. */
  markEffectsStarted(): void;
  /** Runs `work` holding the workspace's identity, its directory and `ownedPaths`. */
  reserveLocal<R>(
    workspaceId: string,
    ownedPaths: string[],
    work: () => Promise<R>,
    expectedWorkspaceRecords?: ExpectedWorkspaceRecords,
  ): Promise<R>;
  /**
   * Reserves the workspace's identity, its directory and `ownedPaths`. With
   * `releaseBeforeEffects`, a failure before the first effect releases it.
   */
  reserve(
    workspaceId: string,
    ownedPaths: string[],
    options?: { releaseBeforeEffects: true },
  ): Promise<WorkspaceCreationReservation>;
  /** Records a repository step in the running reservation. */
  recordRepository(repository: WorkspaceCreationRepository): Promise<void>;
}

/** Rejects a queued operation with `error()` once `signal` aborts. */
export interface WorkspaceCreateCancellation {
  signal: AbortSignal;
  error: () => Error;
}

export interface WorkspaceCreatePorts<T extends WorkspaceCreateTypes> {
  /** Runs `operation` in the host's workspace mutation queue. */
  serialize<R>(
    operation: () => Promise<R>,
    cancellation?: WorkspaceCreateCancellation,
  ): Promise<R>;
  plan: WorkspaceCreatePlanPort<T>;
  reservation: WorkspaceCreateReservationPort;
  decisions: Pick<
    W5LifecycleDecisionPort<T>,
    'applyWorkspaceAdditionDecision' | 'applyWorkspaceCreationDecision'
  >;
}

/** The interactive clone hooks core calls; the host's `Progress` adds its own. */
export interface WorkspaceCloneHooks {
  readonly signal: AbortSignal;
  /** The reserved checkout, and a release for its identity once it is removed. */
  onDestination(
    path: string,
    releaseRemovedDestination: () => Promise<void>,
  ): void;
  /** The checkout is complete and the project is being added. */
  onCloned(): void;
}

/** The host's clone and remote URL vocabulary. */
export interface WorkspaceCreateGitPort<Progress> {
  /**
   * Clones `url` into the empty `destination` through the worker. `progress`
   * streams and cancels it; without it, the host's quit stops it.
   */
  clone(url: string, destination: string, progress?: Progress): Promise<void>;
  /** The error a cancelled interactive clone rejects with. */
  cancelled(): Error;
  /** A remote's normalized form, or null when it doesn't normalize. */
  normalizeRemote(url: string): string | null;
  sameRemote(left: string, right: string): boolean;
  /** `url` without its user info. */
  redactCredentials(url: string): string;
}

/** The files a clone or manifest import reads and creates. */
export interface WorkspaceImportFilesPort {
  /** A repository's `canopy.json` members, or undefined without a multi-repo manifest. */
  readManifestMembers(
    repoPath: string,
  ): Promise<readonly ManifestMember[] | undefined>;
  /** The managed repositories directory that manifest members clone into. */
  managedReposDirectory(): string;
  /** `directory/preferredName`, suffixed until no entry or pending creation holds it. */
  uniqueDestination(directory: string, preferredName: string): Promise<string>;
  /** Creates `parentDirectory` if needed, then `destination` exclusively. */
  createDestination(
    parentDirectory: string,
    destination: string,
  ): Promise<void>;
  /** Writes a single-repo `canopy.json` when the repository has none. */
  ensureSingleRepoManifest(repoPath: string): Promise<void>;
}

export interface WorkspaceImportPorts<
  T extends WorkspaceCreateTypes,
  Progress,
> extends WorkspaceCreatePorts<T> {
  /** Whether the caller already runs inside `serialize`. */
  ownsSerialization(): boolean;
  git: WorkspaceCreateGitPort<Progress>;
  files: WorkspaceImportFilesPort;
}

/** Admission's folder inspection. */
export interface WorkspaceCreateFilesPort {
  /** A missing import folder's message, or undefined when the folder exists. */
  missingImportFolder(path: string): Promise<string | undefined>;
}

/** The post-commit effects of a create, in the order they run. */
export interface WorkspaceCreateAfterCommitPort<
  T extends WorkspaceCreateTypes,
  Source,
> {
  /** Runs `effect` after the enclosing W5 commit applies, or now outside one. */
  afterCommit(effect: () => void | Promise<void>): Promise<void>;
  recordCreated(workspaceId: string, source: Source): void;
  /** The repositories a created item adds to script actions; undefined for none. */
  scriptActionsRepoIds(item: T['item']): string[] | undefined;
  newOperationId(): string;
  notifyRepositoryAdd(
    workspaceId: string,
    repoIds: string[],
    operationId: string,
  ): void;
}

/** The host lifecycle each portable variant runs. */
export interface WorkspaceCreationRoutes<Progress, Outcome> {
  newSingleRepo(name: string): Promise<Outcome>;
  newMultiRepo(name: string): Promise<Outcome>;
  localFolder(folderPath: string): Promise<Outcome>;
  repositoryManifest(repoPath: string): Promise<Outcome>;
  repositoryWithoutManifest(repoPath: string, name?: string): Promise<Outcome>;
  remoteClone(
    remoteUrl: string,
    destinationDir: string,
    progress?: Progress,
  ): Promise<Outcome>;
}

// ---------------------------------------------------------------------------
// Admission and routing
// ---------------------------------------------------------------------------

/** An absolute import path; `inspectFolder` also requires that it exists. */
export async function admitImportFolder(
  path: string,
  inspectFolder: boolean,
  files: WorkspaceCreateFilesPort,
): Promise<void> {
  if (!isAbsolute(path)) {
    refuseWorkspaceCreation(
      'invalid-path',
      'repoPath must be an absolute path',
    );
  }
  if (!inspectFolder) return;
  const missing = await files.missingImportFolder(path);
  if (missing !== undefined) refuseWorkspaceCreation('missing-folder', missing);
}

/** The checks that need no index read; each refuses before any effect. */
export async function admitWorkspaceCreation(
  variant: CoreWorkspaceCreationVariant<unknown>,
  inspectFolder: boolean,
  files: WorkspaceCreateFilesPort,
): Promise<void> {
  switch (variant.kind) {
    case 'new-single-repo':
    case 'new-multi-repo':
      if (!variant.name.trim()) {
        refuseWorkspaceCreation('name-required', 'Project name is required');
      }
      return;
    case 'local-folder':
      await admitImportFolder(variant.folderPath, inspectFolder, files);
      return;
    case 'repository-manifest':
      await admitImportFolder(variant.repoPath, inspectFolder, files);
      return;
    case 'repository-without-manifest':
      if (!isAbsolute(variant.repoPath)) {
        refuseWorkspaceCreation(
          'invalid-path',
          'repoPath must be an absolute path',
        );
      }
      return;
    case 'remote-clone':
      if (!variant.remoteUrl.trim()) {
        refuseWorkspaceCreation('invalid-remote', 'Remote URL is required');
      }
      if (!isAbsolute(variant.destinationDir.trim())) {
        refuseWorkspaceCreation(
          'invalid-path',
          'Destination directory must be an absolute path',
        );
      }
      return;
  }
}

export function routeWorkspaceCreation<Progress, Outcome>(
  variant: CoreWorkspaceCreationVariant<Progress>,
  routes: WorkspaceCreationRoutes<Progress, Outcome>,
): Promise<Outcome> {
  switch (variant.kind) {
    case 'new-single-repo':
      return routes.newSingleRepo(variant.name);
    case 'new-multi-repo':
      return routes.newMultiRepo(variant.name);
    case 'local-folder':
      return routes.localFolder(variant.folderPath);
    case 'repository-manifest':
      return routes.repositoryManifest(variant.repoPath);
    case 'repository-without-manifest':
      return routes.repositoryWithoutManifest(variant.repoPath, variant.name);
    case 'remote-clone':
      return variant.progress
        ? routes.remoteClone(
            variant.remoteUrl,
            variant.destinationDir,
            variant.progress,
          )
        : routes.remoteClone(variant.remoteUrl, variant.destinationDir);
  }
}

export interface WorkspaceCreationKeyedRequest {
  operation: 'core.workspace.create' | 'core.workspace.import';
  /** The fingerprinted parameters: no clone hooks, and trimmed names. */
  parameters: unknown;
}

/** The operation and fingerprinted parameters of a keyed create or import. */
export function workspaceCreationKeyedRequest(
  variant: CoreWorkspaceCreationVariant<unknown>,
): WorkspaceCreationKeyedRequest {
  switch (variant.kind) {
    case 'new-single-repo':
    case 'new-multi-repo':
      return {
        operation: 'core.workspace.create',
        parameters: { ...variant, name: variant.name.trim() },
      };
    case 'remote-clone':
      return {
        operation: 'core.workspace.import',
        parameters: {
          kind: variant.kind,
          remoteUrl: variant.remoteUrl,
          destinationDir: variant.destinationDir,
        },
      };
    case 'local-folder':
    case 'repository-manifest':
    case 'repository-without-manifest':
      return { operation: 'core.workspace.import', parameters: variant };
  }
}

// ---------------------------------------------------------------------------
// Publication (W6a1 decisions)
// ---------------------------------------------------------------------------

/**
 * Adds a find-or-create destination: a scoped addition writes only this
 * workspace's files in its caller's step; an unscoped one rewrites the
 * sidebar read in the mutation queue.
 */
export function stageWorkspaceAddition<T extends WorkspaceCreateTypes>(
  decisions: WorkspaceCreatePorts<T>['decisions'],
  addition: {
    item: T['item'];
    previousItems: T['item'][];
    preserveWorkspaceIds: string[];
    scoped: boolean;
  },
): Promise<T['itemsFile']> {
  const decision: CoreWorkspaceAdditionDecision<T> = {
    kind: 'workspace.add',
    item: addition.item,
    scope: addition.scoped
      ? { kind: 'workspace' }
      : {
          kind: 'sidebar',
          previousItems: addition.previousItems,
          preserveWorkspaceIds: addition.preserveWorkspaceIds,
        },
  };
  return decisions.applyWorkspaceAdditionDecision(decision);
}

/** The workspaces a publication writes, whose records its creation step locks. */
function creationWorkspaceIds<T extends WorkspaceCreateTypes>(
  decision: CoreWorkspaceCreationDecision<T>,
): string[] {
  return decision.kind === 'workspace.create.publish'
    ? [decision.item.id]
    : [decision.workspace.id, ...decision.childWorkspaces.map(({ id }) => id)];
}

/** Applies `decision` in its creation boundary step and returns `result`. */
function publishCreationDecision<T extends WorkspaceCreateTypes, R>(
  ports: Pick<WorkspaceCreatePorts<T>, 'decisions' | 'reservation'>,
  decision: CoreWorkspaceCreationDecision<T>,
  result: R,
): Promise<R> {
  return ports.reservation.commit(async () => {
    await ports.decisions.applyWorkspaceCreationDecision(decision, () =>
      ports.reservation.markEffectsStarted(),
    );
    return result;
  }, creationWorkspaceIds(decision));
}

/**
 * Publishes a created or imported repository project in its creation boundary
 * step; observer edits made during provisioning survive.
 */
export function publishWorkspaceCreation<
  T extends WorkspaceCreateTypes,
  I extends T['item'],
>(
  ports: Pick<WorkspaceCreatePorts<T>, 'decisions' | 'reservation'>,
  item: I,
): Promise<I> {
  return publishCreationDecision(
    ports,
    { kind: 'workspace.create.publish', item },
    item,
  );
}

/** Publishes an imported multi-repo project and its new member projects together. */
export function publishWorkspaceImport<T extends WorkspaceCreateTypes>(
  ports: Pick<WorkspaceCreatePorts<T>, 'decisions' | 'reservation'>,
  workspace: T['multiRepoItem'],
  childWorkspaces: T['singleRepoItem'][],
): Promise<T['multiRepoItem']> {
  return publishCreationDecision(
    ports,
    { kind: 'workspace.import.publish', workspace, childWorkspaces },
    workspace,
  );
}

/** A local create's provisioning, run under its identity reservation. */
export interface NewWorkspaceProvisioning<I> {
  effects?: (item: I) => Promise<void>;
  ownedPaths?: (item: I) => string[];
  expectedWorkspaceRecords?: ExpectedWorkspaceRecords;
}

/**
 * Plans a new project against the live index in the mutation queue (CAN-3806),
 * then provisions it and publishes it at the end of the sidebar. With
 * `provisioning`, the identity and owned paths stay reserved until the
 * publication commits.
 */
export function commitNewWorkspace<
  T extends WorkspaceCreateTypes,
  I extends T['item'],
>(
  ports: WorkspaceCreatePorts<T>,
  prepare: (items: T['item'][]) => Promise<I>,
  provisioning?: NewWorkspaceProvisioning<I>,
): Promise<I> {
  return ports.serialize(async () => {
    const items = await ports.plan.readItems();
    const item = await prepare(items);
    const persisted: I = { ...item, order: items.length };
    const publish = async (): Promise<I> => {
      await provisioning?.effects?.(persisted);
      return publishWorkspaceCreation(ports, persisted);
    };
    return provisioning
      ? ports.reservation.reserveLocal(
          item.id,
          provisioning.ownedPaths?.(item) ?? [],
          publish,
          provisioning.expectedWorkspaceRecords,
        )
      : publish();
  });
}

// ---------------------------------------------------------------------------
// Clone and manifest import (C2)
// ---------------------------------------------------------------------------

/**
 * Waits for the previous holder of `key` in `locks`, then holds it until the
 * returned release runs; releasing twice is a no-op.
 */
export async function acquireKeyedLock(
  locks: Map<string, Promise<void>>,
  key: string,
): Promise<() => void> {
  const previous = locks.get(key);
  let releaseLock: (() => void) | undefined;
  const current = new Promise<void>((resolveLock) => {
    releaseLock = resolveLock;
  });
  locks.set(key, current);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseLock?.();
    if (locks.get(key) === current) locks.delete(key);
  };
}

const manifestMemberLocks = new Map<string, Promise<void>>();

/**
 * Holds one in-process lock per manifest member URL while `operation` runs,
 * taken in sorted order, so an import that shares a member with another
 * waits for it to publish and then reuses its checkout. A URL that doesn't
 * normalize keys on its text.
 *
 * Taken outside `serialize`: a waiter inside the queue would hold the queue
 * its holder needs to publish.
 *
 * Residual risk: installs and org/cloud materialization also clone into the
 * managed repositories directory without these locks, so either can still
 * race an import.
 */
async function withManifestMemberLocks<R>(
  ports: {
    ownsSerialization(): boolean;
    git: Pick<WorkspaceCreateGitPort<unknown>, 'normalizeRemote'>;
  },
  urls: readonly string[],
  operation: () => Promise<R>,
): Promise<R> {
  if (ports.ownsSerialization()) {
    throw new Error(
      'Manifest member locks must be taken outside workspace serialization',
    );
  }
  const keys = [
    ...new Set(urls.map((url) => ports.git.normalizeRemote(url) ?? url.trim())),
  ].sort();
  const releases: (() => void)[] = [];
  try {
    for (const key of keys) {
      releases.push(await acquireKeyedLock(manifestMemberLocks, key));
    }
    return await operation();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** Refuses a repository a project already tracks, as its repository or source. */
export function refuseTrackedRepository<T extends WorkspaceCreateTypes>(
  plan: Pick<WorkspaceCreatePlanPort<T>, 'trackingWorkspaceName'>,
  items: readonly T['item'][],
  repoPath: string,
): void {
  const tracking = plan.trackingWorkspaceName(items, repoPath);
  if (tracking !== undefined) {
    refuseWorkspaceCreation(
      'already-tracked',
      `This repository is already tracked as project "${tracking}"`,
    );
  }
}

function refuseAttachedManifestSource<T extends WorkspaceCreateTypes>(
  plan: WorkspaceCreatePlanPort<T>,
  items: readonly T['item'][],
  repoPath: string,
): void {
  const attached = plan.manifestSourceWorkspaceName(items, repoPath);
  if (attached !== undefined) {
    refuseWorkspaceCreation(
      'already-tracked',
      `This source repo is already attached to project "${attached}"`,
    );
  }
}

/** Whether a project already has `repoPath`, or a checkout of `remoteUrl`. */
function workspaceRootTracked(
  git: Pick<WorkspaceCreateGitPort<unknown>, 'sameRemote'>,
  roots: readonly WorkspaceRootRemote[],
  repoPath: string,
  remoteUrl: string,
): boolean {
  return roots.some(
    (root) =>
      root.repoPath === repoPath ||
      (root.remoteUrl !== null && git.sameRemote(root.remoteUrl, remoteUrl)),
  );
}

interface ManifestMemberStep {
  repository: ManifestMemberRepository;
  cloned: boolean;
}

/**
 * Reuses a tracked checkout of the member's remote, or reserves a new
 * destination, records the clone `started` and creates the empty directory.
 * Runs inside `serialize`.
 */
async function admitManifestMember<T extends WorkspaceCreateTypes, Progress>(
  ports: WorkspaceImportPorts<T, Progress>,
  member: ManifestMember,
): Promise<ManifestMemberStep> {
  // A prior member clone may have overlapped an install or an org/cloud
  // materialization, which take no member lock.
  const items = await ports.plan.readItems();
  const remotes = await ports.plan.repositoryRemotes(items);
  const existing = remotes.find(
    (remote) =>
      remote.remoteUrl !== null &&
      ports.git.sameRemote(remote.remoteUrl, member.url),
  );
  if (existing) {
    await ports.reservation.recordRepository({
      id: member.id,
      role: 'member',
      owned: false,
      action: 'import',
      status: 'completed',
    });
    return {
      repository: {
        id: member.id,
        name: existing.repoName,
        repoPath: existing.repoPath,
        manifestUrl: member.url,
      },
      cloned: false,
    };
  }
  const destination = await ports.files.uniqueDestination(
    ports.files.managedReposDirectory(),
    member.name,
  );
  await ports.reservation.recordRepository({
    id: member.id,
    role: 'member',
    owned: true,
    path: destination,
    action: 'clone',
    status: 'started',
  });
  ports.reservation.markEffectsStarted();
  await ports.files.createDestination(dirname(destination), destination);
  return {
    repository: {
      id: member.id,
      name: member.name,
      repoPath: destination,
      manifestUrl: member.url,
    },
    cloned: true,
  };
}

/**
 * Publishes the imported project with a single-repo project for each member
 * no project tracks yet, by path or remote. Runs inside `serialize`.
 */
async function publishManifestImport<T extends WorkspaceCreateTypes, Progress>(
  ports: WorkspaceImportPorts<T, Progress>,
  workspacePlan: {
    id: string;
    name: string;
    sourceRepoPath: string;
    repositories: readonly ManifestMemberRepository[];
  },
): Promise<T['multiRepoItem']> {
  const items = await ports.plan.readItems();
  refuseAttachedManifestSource(ports.plan, items, workspacePlan.sourceRepoPath);
  const workspace = ports.plan.multiRepoItem({
    id: workspacePlan.id,
    name: workspacePlan.name,
    repos: ports.plan.manifestRepositories(workspacePlan.repositories),
    sourceRepoPath: workspacePlan.sourceRepoPath,
    order: items.length,
  });
  const roots = await ports.plan.workspaceRootRemotes(items);
  const childWorkspaces: T['singleRepoItem'][] = [];
  for (const repository of workspacePlan.repositories) {
    if (
      !repository.manifestUrl ||
      workspaceRootTracked(
        ports.git,
        roots,
        repository.repoPath,
        repository.manifestUrl,
      )
    )
      continue;
    const additions = [workspace, ...childWorkspaces];
    childWorkspaces.push(
      ports.plan.singleRepoItem({
        id: await ports.plan.availableWorkspaceId(repository.name, [
          ...items,
          ...additions,
        ]),
        name: repository.name,
        repoPath: repository.repoPath,
        order: items.length + additions.length,
      }),
    );
    roots.push({
      repoPath: repository.repoPath,
      remoteUrl: repository.manifestUrl,
    });
  }
  return publishWorkspaceImport(ports, workspace, childWorkspaces);
}

/** A manifest import's published project and the members it cloned. */
export interface ManifestImportOutcome<T extends WorkspaceCreateTypes> {
  workspace: T['multiRepoItem'];
  clonedRepoIds: string[];
}

/**
 * Imports the multi-repo project `repoPath`'s `canopy.json` declares: admits
 * it and reserves its identity in the mutation queue, then, holding the member
 * locks, reuses or clones each member and publishes the project with its new
 * member projects. A remote clone passes the identity it already reserved.
 */
export async function importManifestWorkspace<
  T extends WorkspaceCreateTypes,
  Progress,
>(
  ports: WorkspaceImportPorts<T, Progress>,
  repoPath: string,
  reservedWorkspaceId?: string,
): Promise<ManifestImportOutcome<T>> {
  const admission = await ports.serialize(async () => {
    const members = await ports.files.readManifestMembers(repoPath);
    if (members === undefined) {
      refuseWorkspaceCreation(
        'not-a-manifest',
        'Selected repo does not contain a multi-repo canopy.json',
      );
    }
    const items = await ports.plan.readItems();
    refuseAttachedManifestSource(ports.plan, items, repoPath);
    const workspaceName = basename(repoPath);
    const workspaceId =
      reservedWorkspaceId ??
      (await ports.plan.availableWorkspaceId(workspaceName, items));
    const reservation = reservedWorkspaceId
      ? undefined
      : await ports.reservation.reserve(workspaceId, []);
    if (reservation)
      await reservation.prepare(() =>
        ports.reservation.recordRepository({
          id: 'source',
          role: 'source',
          owned: false,
          action: 'import',
          status: 'completed',
        }),
      );
    return { members, workspaceId, workspaceName, reservation };
  });
  const provision = async (): Promise<ManifestImportOutcome<T>> => {
    const repositories: ManifestMemberRepository[] = [];
    const clonedRepoIds: string[] = [];
    // A URL listed twice still clones twice (`<name>`, `<name>-2`): members
    // sharing a checkout can't create a multi-repo worktree. Revisit with
    // shared-repoPath worktree support (CAN-7974).
    for (const member of admission.members) {
      const step = await ports.serialize(() =>
        admitManifestMember(ports, member),
      );
      if (step.cloned) {
        await ports.git.clone(member.url, step.repository.repoPath);
        await ports.serialize(() =>
          ports.reservation.recordRepository({
            id: member.id,
            role: 'member',
            owned: true,
            path: step.repository.repoPath,
            action: 'clone',
            status: 'completed',
          }),
        );
        clonedRepoIds.push(member.id);
      }
      repositories.push(step.repository);
    }
    const workspace = await ports.serialize(() =>
      publishManifestImport(ports, {
        id: admission.workspaceId,
        name: admission.workspaceName,
        sourceRepoPath: repoPath,
        repositories,
      }),
    );
    return { workspace, clonedRepoIds };
  };
  const provisionLocked = (): Promise<ManifestImportOutcome<T>> =>
    withManifestMemberLocks(
      ports,
      admission.members.map((member) => member.url),
      provision,
    );
  return admission.reservation
    ? admission.reservation.run(provisionLocked)
    : provisionLocked();
}

/**
 * Clones `remoteUrl` into a new directory under `destinationDir` and adds it:
 * as a multi-repo project when its `canopy.json` declares one, otherwise as a
 * single-repo project. The identity and destination are reserved in the
 * mutation queue and released if the create fails before its first effect.
 * With `progress`, the clone streams progress and `progress.signal` cancels it
 * at any step.
 */
export async function cloneRemoteWorkspace<
  T extends WorkspaceCreateTypes,
  Progress extends WorkspaceCloneHooks,
>(
  ports: WorkspaceImportPorts<T, Progress>,
  remoteUrl: string,
  destinationDir: string,
  progress?: Progress,
): Promise<T['multiRepoItem'] | T['singleRepoItem']> {
  const url = normalizeRepositoryCloneUrl(remoteUrl);
  if (!url) {
    refuseWorkspaceCreation('invalid-remote', 'Remote URL is required');
  }
  const directory = destinationDir.trim();
  if (!directory || !isAbsolute(directory)) {
    refuseWorkspaceCreation(
      'invalid-path',
      'Destination directory must be an absolute path',
    );
  }
  // The interactive flow names the checkout from the URL without user info.
  const preferredName = repositoryNameFromCloneUrl(
    progress ? ports.git.redactCredentials(url) : url,
  );
  if (!preferredName) {
    refuseWorkspaceCreation(
      'invalid-remote',
      'Unable to determine repository name from URL',
    );
  }

  // Check before joining the queue, and cancel a waiting admission immediately.
  if (progress?.signal.aborted) throw ports.git.cancelled();
  const admission = await ports.serialize(
    async () => {
      const items = await ports.plan.readItems();
      const workspaceId = await ports.plan.availableWorkspaceId(
        preferredName,
        items,
      );
      const destination = await ports.files.uniqueDestination(
        directory,
        preferredName,
      );
      const reservation = await ports.reservation.reserve(
        workspaceId,
        [destination],
        { releaseBeforeEffects: true },
      );
      await reservation.prepare(async () => {
        if (progress?.signal.aborted) throw ports.git.cancelled();
        await ports.reservation.recordRepository({
          id: 'source',
          role: 'source',
          owned: true,
          path: destination,
          action: 'clone',
          status: 'started',
        });
        await ports.files.createDestination(directory, destination);
        ports.reservation.markEffectsStarted();
        progress?.onDestination(destination, reservation.releaseRemoved);
      });
      return { workspaceId, destination, reservation };
    },
    progress
      ? { signal: progress.signal, error: (): Error => ports.git.cancelled() }
      : undefined,
  );
  return admission.reservation.run(async () => {
    const { destination, workspaceId } = admission;
    if (progress) {
      await ports.git.clone(url, destination, progress);
      if (progress.signal.aborted) throw ports.git.cancelled();
      progress.onCloned();
    } else {
      await ports.git.clone(url, destination);
    }
    await ports.serialize(() =>
      ports.reservation.recordRepository({
        id: 'source',
        role: 'source',
        owned: true,
        path: destination,
        action: 'clone',
        status: 'completed',
      }),
    );
    if ((await ports.files.readManifestMembers(destination)) !== undefined) {
      const imported = await importManifestWorkspace(
        ports,
        destination,
        workspaceId,
      );
      return imported.workspace;
    }
    await ports.files.ensureSingleRepoManifest(destination);
    return ports.serialize(async () => {
      const items = await ports.plan.readItems();
      refuseTrackedRepository(ports.plan, items, destination);
      return publishWorkspaceCreation(
        ports,
        ports.plan.singleRepoItem({
          id: workspaceId,
          name: basename(destination),
          repoPath: destination,
          order: items.length,
        }),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// External project registration (D)
// ---------------------------------------------------------------------------

export type ExternalProjectDestinationType =
  | 'single-repo'
  | 'multi-repo'
  | 'cowork';

/** A sidebar item as external project registration reads it. */
export interface ExternalProjectItem {
  readonly id: string;
  readonly type: ExternalProjectDestinationType;
}

/** The project an external project's chats land in. */
export interface ExternalProjectDestination<Item extends ExternalProjectItem> {
  id: string;
  type: ExternalProjectDestinationType;
  item: Item;
}

/** A scanned external project, as registration reads it. */
export interface ExternalProjectRegistrationCandidate {
  readonly id: string;
  readonly kind: 'git' | 'folder';
  readonly rootPath: string;
  readonly displayName: string;
  /** The project the scan saw tracking this root. */
  readonly trackedWorkspaceId?: string;
}

/** The host's reads and creates for an external project registration. */
export interface ExternalProjectRegistrationPorts<
  Item extends ExternalProjectItem,
> {
  /** `path` with every symbolic link resolved; rejects when it is gone. */
  canonicalPath(path: string): Promise<string>;
  /** Whether `path` resolves to `canonicalPath`; false when it is gone. */
  resolvesTo(path: string, canonicalPath: string): Promise<boolean>;
  /** Every sidebar item. */
  readItems(): Promise<Item[]>;
  /** The folder an item is rooted at, if it has one. */
  rootPath(item: Item): string | undefined;
  /** The project an earlier import of this candidate registered. */
  recordedWorkspaceId(candidateId: string): Promise<string | undefined>;
  /** Registers a repository as a single-repo project without writing `canopy.json`. */
  registerRepository(repoPath: string, name: string): Promise<Item>;
  /** Refuses a folder that may not become an external Cowork project. */
  admitFolder(folderPath: string, items: Item[]): Promise<void>;
  /** Publishes the external Cowork project rooted at `folderPath` (W6a2). */
  publish(folderPath: string, name: string): Promise<Item>;
}

function externalProjectDestination<Item extends ExternalProjectItem>(
  item: Item,
): ExternalProjectDestination<Item> {
  return { id: item.id, type: item.type, item };
}

/**
 * The destination a candidate already has: the project the scan saw tracking
 * it, the project an earlier import registered (which makes a same-scan retry
 * idempotent), or an item rooted at the same canonical path.
 */
async function registeredExternalProject<Item extends ExternalProjectItem>(
  ports: ExternalProjectRegistrationPorts<Item>,
  candidate: ExternalProjectRegistrationCandidate,
  canonicalRootPath: string,
): Promise<ExternalProjectDestination<Item> | null> {
  const items = await ports.readItems();
  const byId = (id: string | undefined): Item | undefined =>
    id ? items.find((item) => item.id === id) : undefined;
  const tracked = byId(candidate.trackedWorkspaceId);
  if (tracked) return externalProjectDestination(tracked);
  const recorded = byId(await ports.recordedWorkspaceId(candidate.id));
  if (recorded) return externalProjectDestination(recorded);
  for (const item of items) {
    const rootPath = ports.rootPath(item);
    if (!rootPath) continue;
    if (
      rootPath === canonicalRootPath ||
      (await ports.resolvesTo(rootPath, canonicalRootPath))
    ) {
      return externalProjectDestination(item);
    }
  }
  return null;
}

/**
 * Finds or registers the project for an external project import: a Git root
 * becomes a single-repo project without `canopy.json`, any other folder an
 * external Cowork project.
 */
export async function registerExternalProject<Item extends ExternalProjectItem>(
  ports: ExternalProjectRegistrationPorts<Item>,
  candidate: ExternalProjectRegistrationCandidate,
): Promise<ExternalProjectDestination<Item>> {
  // The scan's path was canonical when it was taken; resolve it again now so
  // a folder swapped for a symlink since then is judged by where it points.
  const rootPath = await ports.canonicalPath(candidate.rootPath);
  const existing = await registeredExternalProject(ports, candidate, rootPath);
  if (existing) return existing;
  if (candidate.kind === 'git') {
    const workspace = await ports.registerRepository(
      rootPath,
      candidate.displayName,
    );
    if (workspace.type !== 'single-repo') {
      throw new Error('Imported project was persisted with an unexpected type');
    }
    return externalProjectDestination(workspace);
  }
  await ports.admitFolder(rootPath, await ports.readItems());
  const workspace = await ports.publish(rootPath, candidate.displayName);
  return { id: workspace.id, type: 'cowork', item: workspace };
}

/** The host's Work Entries and worktrees that hold an import's chats. */
export interface ExternalProjectChatDestinationPort<
  Item extends ExternalProjectItem,
> {
  /** A new, empty Work Entry in the Cowork project; returns its id. */
  createWorkEntry(workspaceId: string): Promise<string>;
  workEntryIds(workspaceId: string): Promise<string[]>;
  /** Removes an empty Work Entry with its data. */
  removeWorkEntry(workspaceId: string, worktreeId: string): Promise<void>;
  /** A new worktree in the single-repo project; returns its id. */
  createWorktree(
    workspaceId: string,
    existingWorktreeIds: string[],
  ): Promise<string>;
  /** A single-repo item's worktree ids; empty for any other item. */
  worktreeIds(item: Item): string[];
  /** Archives an empty worktree this import created, deleting its branch. */
  removeWorktree(workspaceId: string, worktreeId: string): Promise<void>;
}

/** A new Work Entry or worktree for the destination's imported chats. */
export async function createExternalChatDestination<
  Item extends ExternalProjectItem,
>(
  port: ExternalProjectChatDestinationPort<Item>,
  destination: ExternalProjectDestination<Item>,
): Promise<string> {
  if (destination.type === 'cowork') {
    return port.createWorkEntry(destination.id);
  }
  if (destination.item.type !== 'single-repo') {
    throw new Error('Chats can only be imported into Code or Cowork projects');
  }
  return port.createWorktree(
    destination.id,
    port.worktreeIds(destination.item),
  );
}

async function externalChatDestinationExists<Item extends ExternalProjectItem>(
  port: ExternalProjectChatDestinationPort<Item>,
  destination: ExternalProjectDestination<Item>,
  worktreeId: string,
): Promise<boolean> {
  if (destination.type === 'cowork') {
    const entries = await port
      .workEntryIds(destination.id)
      .catch((): string[] => []);
    return entries.includes(worktreeId);
  }
  if (destination.item.type !== 'single-repo') return false;
  return port.worktreeIds(destination.item).includes(worktreeId);
}

/** What an earlier import of the project recorded about its chats. */
export interface ExternalProjectChatRecord {
  chatWorktreeId?: string;
  sessions: Record<string, { worktreeId: string; importedAt?: string }>;
}

/**
 * The worktree or Work Entry an earlier import put the project's chats in,
 * when it still exists: the recorded destination first, then the newest
 * session's, for records written before the destination was.
 */
export async function reusableExternalChatDestination<
  Item extends ExternalProjectItem,
>(
  port: ExternalProjectChatDestinationPort<Item>,
  destination: ExternalProjectDestination<Item>,
  recorded: ExternalProjectChatRecord | undefined,
): Promise<string | null> {
  if (!recorded) return null;
  const candidates: string[] = [];
  if (recorded.chatWorktreeId) candidates.push(recorded.chatWorktreeId);
  let newest: { worktreeId: string; importedAt: string } | null = null;
  for (const record of Object.values(recorded.sessions)) {
    const importedAt = record.importedAt ?? '';
    if (!newest || importedAt > newest.importedAt) {
      newest = { worktreeId: record.worktreeId, importedAt };
    }
  }
  if (newest && !candidates.includes(newest.worktreeId)) {
    candidates.push(newest.worktreeId);
  }
  for (const worktreeId of candidates) {
    if (await externalChatDestinationExists(port, destination, worktreeId))
      return worktreeId;
  }
  return null;
}

/**
 * Undoes an empty chat destination this import created. Best effort: an
 * orphaned empty destination is recoverable by hand and must not turn a
 * reported chat failure into an import failure.
 */
export async function rollbackExternalChatDestination<
  Item extends ExternalProjectItem,
>(
  port: ExternalProjectChatDestinationPort<Item>,
  destination: ExternalProjectDestination<Item>,
  worktreeId: string,
): Promise<void> {
  try {
    if (destination.type === 'cowork') {
      await port.removeWorkEntry(destination.id, worktreeId);
      return;
    }
    await port.removeWorktree(destination.id, worktreeId);
  } catch {
    // Best effort; see above.
  }
}

// ---------------------------------------------------------------------------
// Post-commit
// ---------------------------------------------------------------------------

/**
 * Records the create's telemetry, then, when `addsScriptActions` and the item
 * has repositories, announces them to script actions. Both run after the
 * commit, in that order. Returns the announcement's operation id.
 */
export async function afterWorkspaceCreationCommit<
  T extends WorkspaceCreateTypes,
  Source,
>(
  port: WorkspaceCreateAfterCommitPort<T, Source>,
  created: { workspace: T['item']; source: Source; addsScriptActions: boolean },
): Promise<string | undefined> {
  const workspaceId = created.workspace.id;
  await port.afterCommit(() => port.recordCreated(workspaceId, created.source));
  if (!created.addsScriptActions) return undefined;
  const repoIds = port.scriptActionsRepoIds(created.workspace);
  if (repoIds === undefined) return undefined;
  const operationId = port.newOperationId();
  await port.afterCommit(() => {
    port.notifyRepositoryAdd(workspaceId, repoIds, operationId);
  });
  return operationId;
}

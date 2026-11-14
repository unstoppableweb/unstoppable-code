import { createW5RecordImageReaders } from '@canopy/core-runtime/node/w5/record-image-repositories';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import {
  APP_ADVISOR_WORKTREE_ID,
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  normalizeActivitySectionOrder,
  type WorkspaceIndexSnapshot,
} from '../../lib/workspace-index-repository';
import { desktopW5FileStore } from '../../lib/w5-commit-log-file-store';
import {
  getAppManagedChatWorkspaceDir,
  getAppWorkspacesRootDir,
  getWorkspaceDir,
  getWorkspacesRootDir,
} from '../../lib/paths';
import {
  readWorkspaceWorktreesDetailed,
  readWorkspaceConfigDetailed,
  type WorktreeListAuthority,
} from '../../lib/workspace-persistence';
import { validateId } from '../../lib/validation';
import type { WorkspaceType } from '@canopy/desktop-shared/types';
import { parseWorkEntriesFile } from '../../lib/cowork-work-entries-file';
import { isE2eBuild } from '../../lib/e2e-gate';
import { logMainProcessInfo } from '../../lib/main-process-logging';
import {
  readStartupStreamRepairCutoff,
  writeStartupStreamRepairCheckpoint,
} from './startup-stream-repair-checkpoint';

export interface StartupStreamRepairScope {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly identity: string;
  readonly runsDirectory?: string;
  readonly revalidateScope: () => boolean | Promise<boolean>;
}

export interface StartupStreamRepairCandidate {
  readonly scope: StartupStreamRepairScope;
  readonly runsDirectory?: string;
}

export interface StartupStreamRepairDiscovery {
  readonly scopes: readonly StartupStreamRepairScope[];
  readonly provisionalRecordCount: number;
  readonly failed: number;
  readonly complete: boolean;
}

export interface StartupStreamRepairSummary {
  readonly discovered: number;
  readonly repaired: number;
  readonly skipped: number;
  readonly failed: number;
  readonly durationMs: number;
}

export interface StartupStreamRepairScopeResult {
  readonly repaired: number;
  readonly failed: number;
  readonly skipped: boolean;
}

interface ReadOnlyResult {
  readonly missing: boolean;
  readonly records: readonly Pick<StoredDelegation, 'version'>[];
}

interface DiscoveryScope extends StartupStreamRepairScope {
  readonly provisionalRecordCount: number;
}

interface JobDiscovery {
  readonly scopes: readonly StartupStreamRepairScope[];
  readonly failed: number;
  readonly complete: boolean;
}

export interface StartupStreamRepairJobDependencies {
  readonly discover: () => Promise<JobDiscovery>;
  readonly readCheckpoint: (now: number) => Promise<number | undefined>;
  readonly writeCheckpoint: (passStartedAt: number) => Promise<void>;
  readonly repairScope: (
    scope: StartupStreamRepairScope,
    cutoff: number | undefined,
  ) => Promise<StartupStreamRepairScopeResult>;
  readonly now: () => number;
  readonly logMainProcessInfo: (message: string, context?: unknown) => void;
  readonly isE2eBuild: () => boolean;
  readonly e2eOptedIn: () => boolean;
}

export interface StartupStreamRepairJob {
  start(): Promise<StartupStreamRepairSummary>;
  shutdown(): Promise<void>;
  result(): StartupStreamRepairSummary | undefined;
}

const APP_MANAGED_PROJECT_IDS: readonly string[] = [
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
];

// These paths are permanently app-managed in paths.ts. The other reserved
// IDs can also be real indexed workspaces; in that case their index/manifest
// is authoritative and their canonical root is workspaces/<id>.
const PERMANENT_APP_MANAGED_PROJECT_IDS: readonly string[] = [
  APP_ADVISOR_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
];

const workspaceIndex = createW5RecordImageReaders({
  root: getWorkspacesRootDir,
  store: desktopW5FileStore,
}).index(normalizeActivitySectionOrder);

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function isValidScopeId(value: string): boolean {
  try {
    validateId(value, 'delegation scope id');
    return true;
  } catch {
    return false;
  }
}

function identityOf(info: Awaited<ReturnType<typeof lstat>>): string {
  return `${String(info.dev)}:${String(info.ino)}`;
}

type DirectoryIdentityRead =
  | { readonly kind: 'present'; readonly identity: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'error' };

async function readDirectoryIdentity(
  directory: string,
): Promise<DirectoryIdentityRead> {
  try {
    const info = await lstat(directory);
    return info.isDirectory()
      ? { kind: 'present', identity: identityOf(info) }
      : { kind: 'invalid' };
  } catch (error) {
    return errnoCode(error) === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'error' };
  }
}

async function readWorkspaceIndex(): Promise<WorkspaceIndexSnapshot> {
  return workspaceIndex.read();
}

function hasWorkspace(
  index: WorkspaceIndexSnapshot,
  projectId: string,
): boolean {
  return (
    index.authority === 'ok' &&
    index.entries.some((entry) => entry.id === projectId)
  );
}

function indexedScopeDirectory(projectId: string, worktreeId: string): string {
  return path.join(getWorkspaceDir(projectId), 'worktree-data', worktreeId);
}

function appManagedScopeDirectory(
  projectId: string,
  worktreeId: string,
): string {
  return path.join(
    getAppManagedChatWorkspaceDir(projectId),
    'worktree-data',
    worktreeId,
  );
}

async function readWorkEntriesAt(
  filePath: string,
): Promise<Awaited<ReturnType<typeof parseWorkEntriesFile>>> {
  return parseWorkEntriesFile(await readFile(filePath, 'utf8'));
}

function worktreeAuthorityIsComplete(
  authority: WorktreeListAuthority,
): boolean {
  return authority === 'ok' || authority === 'absent';
}

async function revalidateIndexedScope(
  projectId: string,
  worktreeId: string,
  createdAt: string,
  workspaceType: WorkspaceType,
  scopeDirectory: string,
  scopeIdentity: string,
  runsDirectory: string,
  runsIdentity: string,
): Promise<boolean> {
  const index = await readWorkspaceIndex();
  if (!hasWorkspace(index, projectId)) return false;
  const manifest = await readWorkspaceConfigDetailed(projectId);
  if (manifest.authority !== 'ok' || manifest.config.type !== workspaceType)
    return false;
  const worktrees = await readWorkspaceWorktreesDetailed(projectId, {
    persistRemovalCleanup: false,
  });
  if (worktrees.authority !== 'ok') return false;
  const current = worktrees.worktrees.find((entry) => entry.id === worktreeId);
  if (!current || current.createdAt !== createdAt) return false;
  try {
    const [scopeInfo, runsInfo] = await Promise.all([
      lstat(scopeDirectory),
      lstat(runsDirectory),
    ]);
    return (
      scopeInfo.isDirectory() &&
      identityOf(scopeInfo) === scopeIdentity &&
      runsInfo.isDirectory() &&
      identityOf(runsInfo) === runsIdentity
    );
  } catch {
    return false;
  }
}

async function revalidateAppManagedScope(
  appWorkspaceDirectory: string,
  scopeDirectory: string,
  runsDirectory: string,
  workspaceIdentity: string,
  scopeIdentity: string,
  runsIdentity: string,
): Promise<boolean> {
  try {
    const [workspaceInfo, scopeInfo, runsInfo] = await Promise.all([
      lstat(appWorkspaceDirectory),
      lstat(scopeDirectory),
      lstat(runsDirectory),
    ]);
    return (
      workspaceInfo.isDirectory() &&
      identityOf(workspaceInfo) === workspaceIdentity &&
      scopeInfo.isDirectory() &&
      identityOf(scopeInfo) === scopeIdentity &&
      runsInfo.isDirectory() &&
      identityOf(runsInfo) === runsIdentity
    );
  } catch {
    return false;
  }
}

async function authoritativeWorkspaceTypes(
  index: WorkspaceIndexSnapshot,
  reportFailure: () => void,
): Promise<Map<string, WorkspaceType>> {
  const types = new Map<string, WorkspaceType>();
  for (const workspace of index.entries) {
    const projectId = workspace.id;
    if (!isValidScopeId(projectId)) {
      reportFailure();
      continue;
    }
    // The two hard-routed sentinels stay app-managed even if stale index rows
    // exist. Other reserved IDs use their canonical indexed workspace when
    // the index contains them.
    if (PERMANENT_APP_MANAGED_PROJECT_IDS.some((id) => id === projectId))
      continue;
    try {
      const manifest = await readWorkspaceConfigDetailed(projectId);
      if (manifest.authority !== 'ok') {
        reportFailure();
        continue;
      }
      types.set(projectId, manifest.config.type);
    } catch {
      reportFailure();
    }
  }
  return types;
}

async function revalidateWorkEntryScope(
  projectId: string,
  worktreeId: string,
  createdAt: string,
  appManaged: boolean,
  appWorkspaceDirectory: string,
  appWorkspaceIdentity: string | undefined,
  scopeDirectory: string,
  scopeIdentity: string,
  runsDirectory: string,
  runsIdentity: string,
): Promise<boolean> {
  const registryPath = path.join(
    appManaged ? appWorkspaceDirectory : getWorkspaceDir(projectId),
    'work-entries.json',
  );
  if (!appManaged) {
    const index = await readWorkspaceIndex();
    if (!hasWorkspace(index, projectId)) return false;
    const manifest = await readWorkspaceConfigDetailed(projectId);
    if (manifest.authority !== 'ok' || manifest.config.type !== 'cowork')
      return false;
    const registry = await readWorkEntriesAt(registryPath);
    if (
      !registry.entries.some(
        (entry) => entry.id === worktreeId && entry.createdAt === createdAt,
      )
    )
      return false;
  } else {
    const registry = await readWorkEntriesAt(registryPath);
    if (
      !registry.entries.some(
        (entry) => entry.id === worktreeId && entry.createdAt === createdAt,
      )
    )
      return false;
  }
  try {
    const [workspaceInfo, scopeInfo, runsInfo] = await Promise.all([
      appManaged ? lstat(appWorkspaceDirectory) : Promise.resolve(undefined),
      lstat(scopeDirectory),
      lstat(runsDirectory),
    ]);
    return (
      (!appManaged ||
        (workspaceInfo?.isDirectory() === true &&
          identityOf(workspaceInfo) === appWorkspaceIdentity)) &&
      scopeInfo.isDirectory() &&
      identityOf(scopeInfo) === scopeIdentity &&
      runsInfo.isDirectory() &&
      identityOf(runsInfo) === runsIdentity
    );
  } catch {
    return false;
  }
}

async function workEntryScopeCandidates(
  projectId: string,
  entries: Awaited<ReturnType<typeof parseWorkEntriesFile>>['entries'],
  appManaged: boolean,
  reportFailure: () => void,
): Promise<StartupStreamRepairCandidate[]> {
  const candidates: StartupStreamRepairCandidate[] = [];
  const appWorkspaceDirectory = getAppManagedChatWorkspaceDir(projectId);
  let appWorkspaceIdentity: string | undefined;
  if (appManaged) {
    const appWorkspace = await readDirectoryIdentity(appWorkspaceDirectory);
    if (appWorkspace.kind !== 'present') {
      if (appWorkspace.kind !== 'missing') reportFailure();
      return candidates;
    }
    appWorkspaceIdentity = appWorkspace.identity;
  }

  for (const entry of entries) {
    if (!isValidScopeId(entry.id)) {
      reportFailure();
      continue;
    }
    const scopeDirectory = appManaged
      ? appManagedScopeDirectory(projectId, entry.id)
      : indexedScopeDirectory(projectId, entry.id);
    const runsDirectory = path.join(scopeDirectory, 'delegation', 'runs');
    const [scopeRead, runsRead] = await Promise.all([
      readDirectoryIdentity(scopeDirectory),
      readDirectoryIdentity(runsDirectory),
    ]);
    if (scopeRead.kind === 'missing' || runsRead.kind === 'missing') continue;
    if (scopeRead.kind !== 'present' || runsRead.kind !== 'present') {
      reportFailure();
      continue;
    }
    const scopeIdentity = scopeRead.identity;
    const runsIdentity = runsRead.identity;
    const workspaceIdentity = appWorkspaceIdentity;
    candidates.push({
      runsDirectory,
      scope: {
        projectId,
        worktreeId: entry.id,
        identity: `${entry.createdAt}:${workspaceIdentity ?? 'workspace'}:${scopeIdentity}:${runsIdentity}`,
        runsDirectory,
        revalidateScope: (): Promise<boolean> =>
          revalidateWorkEntryScope(
            projectId,
            entry.id,
            entry.createdAt,
            appManaged,
            appWorkspaceDirectory,
            workspaceIdentity,
            scopeDirectory,
            scopeIdentity,
            runsDirectory,
            runsIdentity,
          ),
      },
    });
  }
  return candidates;
}

async function appAdvisorGlobalCandidate(
  reportFailure: () => void,
): Promise<StartupStreamRepairCandidate | undefined> {
  const projectId = APP_ADVISOR_PROJECT_ID;
  const worktreeId = APP_ADVISOR_WORKTREE_ID;
  const appWorkspaceDirectory = getAppManagedChatWorkspaceDir(projectId);
  const scopeDirectory = appManagedScopeDirectory(projectId, worktreeId);
  const runsDirectory = path.join(scopeDirectory, 'delegation', 'runs');
  const [workspaceRead, scopeRead, runsRead] = await Promise.all([
    readDirectoryIdentity(appWorkspaceDirectory),
    readDirectoryIdentity(scopeDirectory),
    readDirectoryIdentity(runsDirectory),
  ]);
  if (
    workspaceRead.kind === 'missing' ||
    scopeRead.kind === 'missing' ||
    runsRead.kind === 'missing'
  )
    return undefined;
  if (
    workspaceRead.kind !== 'present' ||
    scopeRead.kind !== 'present' ||
    runsRead.kind !== 'present'
  ) {
    reportFailure();
    return undefined;
  }
  const workspaceIdentity = workspaceRead.identity;
  const scopeIdentity = scopeRead.identity;
  const runsIdentity = runsRead.identity;
  return {
    runsDirectory,
    scope: {
      projectId,
      worktreeId,
      identity: `${workspaceIdentity}:${scopeIdentity}:${runsIdentity}`,
      runsDirectory,
      revalidateScope: (): Promise<boolean> =>
        revalidateAppManagedScope(
          appWorkspaceDirectory,
          scopeDirectory,
          runsDirectory,
          workspaceIdentity,
          scopeIdentity,
          runsIdentity,
        ),
    },
  };
}

async function revalidateCoworkHomeScope(
  projectId: string,
  scopeDirectory: string,
  scopeIdentity: string,
  runsDirectory: string,
  runsIdentity: string,
): Promise<boolean> {
  const index = await readWorkspaceIndex();
  if (!hasWorkspace(index, projectId)) return false;
  const manifest = await readWorkspaceConfigDetailed(projectId);
  if (manifest.authority !== 'ok' || manifest.config.type !== 'cowork')
    return false;
  try {
    const [scopeInfo, runsInfo] = await Promise.all([
      lstat(scopeDirectory),
      lstat(runsDirectory),
    ]);
    return (
      scopeInfo.isDirectory() &&
      identityOf(scopeInfo) === scopeIdentity &&
      runsInfo.isDirectory() &&
      identityOf(runsInfo) === runsIdentity
    );
  } catch {
    return false;
  }
}

async function coworkHomeCandidate(
  projectId: string,
  reportFailure: () => void,
): Promise<StartupStreamRepairCandidate | undefined> {
  const worktreeId = COWORK_HOME_WORKTREE_ID;
  const scopeDirectory = indexedScopeDirectory(projectId, worktreeId);
  const runsDirectory = path.join(scopeDirectory, 'delegation', 'runs');
  const [scopeRead, runsRead] = await Promise.all([
    readDirectoryIdentity(scopeDirectory),
    readDirectoryIdentity(runsDirectory),
  ]);
  if (scopeRead.kind === 'missing' || runsRead.kind === 'missing')
    return undefined;
  if (scopeRead.kind !== 'present' || runsRead.kind !== 'present') {
    reportFailure();
    return undefined;
  }
  const scopeIdentity = scopeRead.identity;
  const runsIdentity = runsRead.identity;
  return {
    runsDirectory,
    scope: {
      projectId,
      worktreeId,
      identity: `${worktreeId}:${scopeIdentity}:${runsIdentity}`,
      runsDirectory,
      revalidateScope: (): Promise<boolean> =>
        revalidateCoworkHomeScope(
          projectId,
          scopeDirectory,
          scopeIdentity,
          runsDirectory,
          runsIdentity,
        ),
    },
  };
}

async function indexedScopeCandidates(
  index: WorkspaceIndexSnapshot,
  authoritativeTypes: ReadonlyMap<string, WorkspaceType>,
  reportFailure: () => void,
): Promise<StartupStreamRepairCandidate[]> {
  const candidates: StartupStreamRepairCandidate[] = [];
  if (index.authority !== 'ok') return candidates;
  for (const workspace of index.entries) {
    const projectId = workspace.id;
    if (!isValidScopeId(projectId)) {
      reportFailure();
      continue;
    }
    if (PERMANENT_APP_MANAGED_PROJECT_IDS.some((id) => id === projectId))
      continue;
    const workspaceType = authoritativeTypes.get(projectId);
    if (workspaceType === undefined) continue;
    if (workspaceType === 'cowork') {
      let entries: Awaited<ReturnType<typeof readWorkEntriesAt>>['entries'] =
        [];
      try {
        entries = (
          await readWorkEntriesAt(
            path.join(getWorkspaceDir(projectId), 'work-entries.json'),
          )
        ).entries;
      } catch (error) {
        // Like the Work Entry reader, a missing registry means no entries yet.
        if (errnoCode(error) !== 'ENOENT') reportFailure();
      }
      candidates.push(
        ...(await workEntryScopeCandidates(
          projectId,
          entries,
          false,
          reportFailure,
        )),
      );
      // Home chats have their own scope, which no Work Entry lists.
      if (!entries.some((entry) => entry.id === COWORK_HOME_WORKTREE_ID)) {
        const home = await coworkHomeCandidate(projectId, reportFailure);
        if (home) candidates.push(home);
      }
      continue;
    }
    let read: Awaited<ReturnType<typeof readWorkspaceWorktreesDetailed>>;
    try {
      read = await readWorkspaceWorktreesDetailed(projectId, {
        persistRemovalCleanup: false,
      });
    } catch {
      reportFailure();
      continue;
    }
    if (!worktreeAuthorityIsComplete(read.authority)) {
      reportFailure();
      continue;
    }
    for (const worktree of read.worktrees) {
      if (!isValidScopeId(worktree.id)) {
        reportFailure();
        continue;
      }
      const scopeDirectory = indexedScopeDirectory(projectId, worktree.id);
      const runsDirectory = path.join(scopeDirectory, 'delegation', 'runs');
      const [scopeRead, runsRead] = await Promise.all([
        readDirectoryIdentity(scopeDirectory),
        readDirectoryIdentity(runsDirectory),
      ]);
      if (scopeRead.kind === 'missing' || runsRead.kind === 'missing') continue;
      if (scopeRead.kind !== 'present' || runsRead.kind !== 'present') {
        reportFailure();
        continue;
      }
      const scopeIdentity = scopeRead.identity;
      const runsIdentity = runsRead.identity;
      const identity = `${worktree.createdAt}:${scopeIdentity}:${runsIdentity}`;
      candidates.push({
        runsDirectory,
        scope: {
          projectId,
          worktreeId: worktree.id,
          identity,
          runsDirectory,
          revalidateScope: (): Promise<boolean> =>
            revalidateIndexedScope(
              projectId,
              worktree.id,
              worktree.createdAt,
              workspaceType,
              scopeDirectory,
              scopeIdentity,
              runsDirectory,
              runsIdentity,
            ),
        },
      });
    }
  }
  return candidates;
}

async function appManagedScopeCandidates(
  indexedIds: ReadonlySet<string>,
  allowUnindexedReservedScopes: boolean,
  reportFailure: () => void,
): Promise<StartupStreamRepairCandidate[]> {
  const candidates: StartupStreamRepairCandidate[] = [];
  let projects: string[];
  try {
    const entries = await readdir(getAppWorkspacesRootDir(), {
      withFileTypes: true,
    });
    const existing = new Set<string>();
    for (const entry of entries) {
      if (APP_MANAGED_PROJECT_IDS.some((id) => id === entry.name)) {
        if (entry.isDirectory()) existing.add(entry.name);
        else reportFailure();
      }
    }
    projects = APP_MANAGED_PROJECT_IDS.filter(
      (id) =>
        existing.has(id) &&
        (PERMANENT_APP_MANAGED_PROJECT_IDS.some(
          (permanent) => permanent === id,
        ) ||
          (allowUnindexedReservedScopes && !indexedIds.has(id))),
    );
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return candidates;
    reportFailure();
    return candidates;
  }

  for (const projectId of projects) {
    const appWorkspaceDirectory = getAppManagedChatWorkspaceDir(projectId);
    const workspaceRead = await readDirectoryIdentity(appWorkspaceDirectory);
    if (workspaceRead.kind === 'missing') continue;
    if (workspaceRead.kind !== 'present') {
      reportFailure();
      continue;
    }
    const workspaceIdentity = workspaceRead.identity;

    if (projectId === APP_ADVISOR_PROJECT_ID) {
      try {
        const registry = await readWorkEntriesAt(
          path.join(appWorkspaceDirectory, 'work-entries.json'),
        );
        candidates.push(
          ...(await workEntryScopeCandidates(
            projectId,
            registry.entries,
            true,
            reportFailure,
          )),
        );
      } catch (error) {
        if (errnoCode(error) !== 'ENOENT') reportFailure();
      }
      const global = await appAdvisorGlobalCandidate(reportFailure);
      if (global) candidates.push(global);
      continue;
    }

    const worktreeDataRoot = path.join(appWorkspaceDirectory, 'worktree-data');
    try {
      const scopes = await readdir(worktreeDataRoot, { withFileTypes: true });
      for (const entry of scopes) {
        if (!entry.isDirectory()) {
          reportFailure();
          continue;
        }
        const worktreeId = entry.name;
        if (!isValidScopeId(worktreeId)) {
          reportFailure();
          continue;
        }
        const scopeDirectory = appManagedScopeDirectory(projectId, worktreeId);
        const runsDirectory = path.join(scopeDirectory, 'delegation', 'runs');
        const [scopeRead, runsRead] = await Promise.all([
          readDirectoryIdentity(scopeDirectory),
          readDirectoryIdentity(runsDirectory),
        ]);
        if (scopeRead.kind === 'missing' || runsRead.kind === 'missing')
          continue;
        if (scopeRead.kind !== 'present' || runsRead.kind !== 'present') {
          reportFailure();
          continue;
        }
        const scopeIdentity = scopeRead.identity;
        const runsIdentity = runsRead.identity;
        candidates.push({
          runsDirectory,
          scope: {
            projectId,
            worktreeId,
            identity: `${workspaceIdentity}:${scopeIdentity}:${runsIdentity}`,
            runsDirectory,
            revalidateScope: (): Promise<boolean> =>
              revalidateAppManagedScope(
                appWorkspaceDirectory,
                scopeDirectory,
                runsDirectory,
                workspaceIdentity,
                scopeIdentity,
                runsIdentity,
              ),
          },
        });
      }
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') continue;
      reportFailure();
      continue;
    }
  }
  return candidates;
}

export async function createStartupStreamRepairDiscovery(
  candidates: readonly StartupStreamRepairCandidate[],
  readOnly: (
    candidate: StartupStreamRepairCandidate,
  ) => Promise<ReadOnlyResult>,
): Promise<StartupStreamRepairDiscovery> {
  const scopes: DiscoveryScope[] = [];
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await readOnly(candidate);
      if (result.missing) continue;
      const provisionalRecordCount = result.records.reduce(
        (count, record) => count + (record.version === 3 ? 1 : 0),
        0,
      );
      if (provisionalRecordCount > 0)
        scopes.push({ ...candidate.scope, provisionalRecordCount });
    } catch {
      failed += 1;
    }
  }
  return {
    scopes,
    provisionalRecordCount: scopes.reduce(
      (count, scope) => count + scope.provisionalRecordCount,
      0,
    ),
    failed,
    complete: failed === 0,
  };
}

export async function discoverStartupStreamRepairScopes(): Promise<JobDiscovery> {
  let failed = 0;
  let complete = true;
  const reportFailure = (): void => {
    failed += 1;
    complete = false;
  };
  let index: WorkspaceIndexSnapshot;
  try {
    index = await readWorkspaceIndex();
  } catch {
    index = { entries: [], authority: 'unreadable' };
  }
  if (index.authority === 'partial' || index.authority === 'unreadable')
    reportFailure();

  let types = new Map<string, WorkspaceType>();
  if (index.authority === 'ok')
    types = await authoritativeWorkspaceTypes(index, reportFailure);
  const indexedIds = new Set(
    index.authority === 'ok' ? index.entries.map((entry) => entry.id) : [],
  );
  const candidates = [
    ...(index.authority === 'ok'
      ? await indexedScopeCandidates(index, types, reportFailure)
      : []),
    ...(await appManagedScopeCandidates(
      indexedIds,
      index.authority === 'ok' || index.authority === 'absent',
      reportFailure,
    )),
  ];
  const discovery = await createStartupStreamRepairDiscovery(
    candidates,
    async (candidate): Promise<ReadOnlyResult> => {
      if (!candidate.runsDirectory) return { missing: true, records: [] };
      const loaded = await new FileDelegationStorage(candidate.runsDirectory, {
        create: false,
      }).loadReadOnly();
      return loaded;
    },
  );
  if (!discovery.complete) complete = false;
  failed += discovery.failed;
  return { scopes: discovery.scopes, failed, complete };
}

export function createStartupStreamRepairJob(
  dependencies: StartupStreamRepairJobDependencies,
): StartupStreamRepairJob {
  let started: Promise<StartupStreamRepairSummary> | undefined;
  let stopped = false;
  let completion: Promise<void> | undefined;
  let summary: StartupStreamRepairSummary | undefined;

  const run = async (): Promise<StartupStreamRepairSummary> => {
    const passStartedAt = dependencies.now();
    let discovered = 0;
    let repaired = 0;
    let skipped = 0;
    let failed = 0;
    let complete = true;
    let scopes: readonly StartupStreamRepairScope[] = [];
    try {
      const discovery = await dependencies.discover();
      scopes = discovery.scopes;
      discovered = scopes.length;
      failed += discovery.failed;
      complete = discovery.complete && discovery.failed === 0;
    } catch {
      failed += 1;
      complete = false;
    }

    if (stopped) {
      skipped += scopes.length;
      complete = false;
    } else {
      let cutoff: number | undefined;
      try {
        cutoff = await dependencies.readCheckpoint(passStartedAt);
      } catch {
        // An unreadable checkpoint is a full-audit condition, not a failed pass.
        cutoff = undefined;
      }
      for (let index = 0; index < scopes.length; index += 1) {
        const scope = scopes[index];
        if (!scope) continue;
        if (stopped) {
          skipped += scopes.length - index;
          complete = false;
          break;
        }
        try {
          const result = await dependencies.repairScope(scope, cutoff);
          repaired += result.repaired;
          failed += result.failed;
          if (result.skipped) {
            skipped += 1;
            complete = false;
          }
          if (result.failed > 0) complete = false;
        } catch {
          failed += 1;
          complete = false;
        }
      }
    }

    if (complete && !stopped) {
      try {
        await dependencies.writeCheckpoint(passStartedAt);
      } catch {
        failed += 1;
      }
    }

    const endedAt = dependencies.now();
    const result: StartupStreamRepairSummary = {
      discovered,
      repaired,
      skipped,
      failed,
      durationMs: Math.max(0, endedAt - passStartedAt),
    };
    summary = result;
    dependencies.logMainProcessInfo('[delegation-startup-repair] completed', {
      discovered: result.discovered,
      repaired: result.repaired,
      skipped: result.skipped,
      failed: result.failed,
      durationMs: result.durationMs,
    });
    if (dependencies.isE2eBuild() && dependencies.e2eOptedIn())
      dependencies.logMainProcessInfo('[startup-stream-repair] E2E completion');
    return result;
  };

  return {
    start(): Promise<StartupStreamRepairSummary> {
      if (!started) {
        started = run();
        completion = started.then(
          () => undefined,
          () => undefined,
        );
      }
      return started;
    },
    async shutdown(): Promise<void> {
      stopped = true;
      if (completion) await completion;
    },
    result: (): StartupStreamRepairSummary | undefined => summary,
  };
}

let processJob: StartupStreamRepairJob | undefined;

function defaultJob(): StartupStreamRepairJob {
  processJob ??= createStartupStreamRepairJob({
    discover: discoverStartupStreamRepairScopes,
    readCheckpoint: readStartupStreamRepairCutoff,
    writeCheckpoint: writeStartupStreamRepairCheckpoint,
    repairScope: async (
      scope,
      cutoff,
    ): Promise<StartupStreamRepairScopeResult> => {
      const { repairStartupStreamScope } = await import('./service');
      return repairStartupStreamScope(scope, cutoff);
    },
    now: Date.now,
    logMainProcessInfo,
    isE2eBuild,
    e2eOptedIn: () => process.env.CANOPY_E2E_STARTUP_STREAM_REPAIR === '1',
  });
  return processJob;
}

export function startStartupStreamRepair(): Promise<StartupStreamRepairSummary> {
  return defaultJob().start();
}

export async function shutdownStartupStreamRepair(): Promise<void> {
  await processJob?.shutdown();
}

export function getStartupStreamRepairResult():
  | StartupStreamRepairSummary
  | undefined {
  return processJob?.result();
}

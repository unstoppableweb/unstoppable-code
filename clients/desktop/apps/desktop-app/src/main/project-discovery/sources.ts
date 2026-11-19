import { AsyncLocalStorage } from 'node:async_hooks';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  type ChatStateSnapshot,
  type CoworkWorkEntriesFile,
  type SidebarItem,
  type WorkspaceIndexEntry,
  type WorktreeData,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { CanopyQueryOptions } from '@canopy/core-runtime';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { getWorkspaceIndexRepository } from '../lib/sidebar-items';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { workspaceStorageUnavailable } from '../lib/workspace-storage-availability';
import { noteProjectInventoryCall } from '../observability/chat-wait-diagnostics';
import { DiscoveryError } from './errors';

export type LegacyReadAuthority = 'ok' | 'absent' | 'unreadable' | 'partial';

export interface LegacyAuthoritySnapshot {
  authority: LegacyReadAuthority;
  indexAuthority?: LegacyReadAuthority;
  ownerMalformed?: boolean;
}

export interface ProjectInventorySnapshot {
  items: SidebarItem[];
  /** Aggregate authority includes every project's manifests. */
  authority: LegacyReadAuthority;
  /** Index-only authority, falling back to the aggregate for older adapters. */
  indexAuthority: LegacyReadAuthority;
  ownerMalformed: boolean;
}

export interface ProjectConfigSnapshot {
  config: WorkspaceConfigFile;
  authority: LegacyReadAuthority;
}

export interface ProjectIndexSnapshot {
  entry: WorkspaceIndexEntry | null;
  authority: LegacyReadAuthority;
}

/** The trusted agent-discovery caller, with exactly one read grant. */
export function readOptions(
  grant: CanopyCallerDescriptor['grants'][number],
): CanopyQueryOptions {
  return {
    caller: {
      principalId: 'local-desktop-user',
      clientInstanceId: 'project-discovery-service',
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'mcp',
      grants: [grant],
    },
  };
}

function readAuthority(response: object): LegacyAuthoritySnapshot | null {
  if (!('legacyAuthority' in response)) return null;
  const raw = response.legacyAuthority;
  if (typeof raw !== 'object' || raw === null || !('authority' in raw))
    return null;
  const authority = raw.authority;
  if (
    authority !== 'ok' &&
    authority !== 'absent' &&
    authority !== 'unreadable' &&
    authority !== 'partial'
  ) {
    return null;
  }
  return {
    authority,
    ...('indexAuthority' in raw &&
    (raw.indexAuthority === 'ok' ||
      raw.indexAuthority === 'absent' ||
      raw.indexAuthority === 'unreadable' ||
      raw.indexAuthority === 'partial')
      ? { indexAuthority: raw.indexAuthority }
      : {}),
    ...('ownerMalformed' in raw && raw.ownerMalformed === true
      ? { ownerMalformed: true }
      : {}),
  };
}

function sourceReadFailed(message: string): DiscoveryError {
  return new DiscoveryError('execution_failed', message);
}

/** The W5 index repository is authoritative without projecting sidebar rows. */
export async function readProjectIndexSnapshot(
  projectId: string,
): Promise<ProjectIndexSnapshot> {
  const index = await getWorkspaceIndexRepository().read();
  if (index.authority === 'unreadable')
    throw workspaceStorageUnavailable(index.unserved);
  if (index.authority === 'partial') {
    throw sourceReadFailed('Project inventory could not be read.');
  }
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  return {
    entry:
      index.authority === 'absent'
        ? null
        : (index.entries.find((entry) => entry.id === workspaceId) ?? null),
    authority: index.authority,
  };
}

/** Read the compatibility workspace inventory through the authorized dispatcher. */
export async function readProjectInventory(): Promise<ProjectInventorySnapshot> {
  noteProjectInventoryCall();
  const response =
    await getActiveDesktopRuntime().queryWorkspaceListForLegacyIpc(
      {},
      readOptions('core.workspace.read'),
    );
  const authority = readAuthority(response);
  if (!authority) {
    throw sourceReadFailed('Project inventory could not be read.');
  }
  const indexAuthority = authority.indexAuthority ?? authority.authority;
  if (indexAuthority === 'unreadable') {
    throw workspaceStorageUnavailable();
  }
  if (
    indexAuthority !== 'absent' &&
    !Array.isArray(response.legacyResult.items)
  ) {
    throw sourceReadFailed('Project inventory could not be read.');
  }
  return {
    items: indexAuthority === 'absent' ? [] : response.legacyResult.items,
    authority: authority.authority,
    indexAuthority,
    ownerMalformed: authority.ownerMalformed === true,
  };
}

/** Read one trusted workspace configuration; never use its owner field as authorization. */
export async function readProjectConfig(
  projectId: string,
): Promise<WorkspaceConfigFile> {
  return (await readProjectConfigSnapshot(projectId)).config;
}

export async function readProjectConfigSnapshot(
  projectId: string,
): Promise<ProjectConfigSnapshot> {
  const response =
    await getActiveDesktopRuntime().queryWorkspaceGetForLegacyIpc(
      { workspaceId: resolveCoworkWorkspaceId(projectId) },
      readOptions('core.workspace.read'),
    );
  const authority = readAuthority(response);
  if (
    !authority ||
    (authority.authority !== 'ok' && authority.authority !== 'absent') ||
    authority.ownerMalformed === true
  ) {
    throw sourceReadFailed('Project configuration could not be read.');
  }
  return { config: response.legacyResult, authority: authority.authority };
}

interface ProjectWorktreeReadMemo {
  open: boolean;
  readonly lists: Map<string, Promise<WorktreeData[]>>;
}

const projectWorktreeReadMemo =
  new AsyncLocalStorage<ProjectWorktreeReadMemo>();

/**
 * Shares one scoped worktree list per project across a single listing or
 * discovery call (CAN-7129). The memo closes when `work` settles, so it never
 * spans calls; a nested call gets its own memo, so its fresh re-reads stay
 * fresh. Callers keep their account-epoch checks: a shared list is keyed by
 * the epoch it started under and is shared only when that epoch held across a
 * drain of account transitions, so a retry under a later epoch never reuses a
 * sample from before or during its transition.
 */
export async function withProjectWorktreeReadMemo<T>(
  work: () => Promise<T>,
): Promise<T> {
  const memo: ProjectWorktreeReadMemo = { open: true, lists: new Map() };
  try {
    return await projectWorktreeReadMemo.run(memo, work);
  } finally {
    memo.open = false;
    memo.lists.clear();
  }
}

/** Read a scoped worktree list; only an authoritative absent file means empty. */
export async function readProjectWorktrees(
  projectId: string,
): Promise<WorktreeData[]> {
  const memo = projectWorktreeReadMemo.getStore();
  if (!memo?.open) return queryProjectWorktrees(projectId);
  // Each caller gets its own array; rows stay shared read-only legacy data.
  return [...(await memoizedProjectWorktrees(memo, projectId))];
}

async function memoizedProjectWorktrees(
  memo: ProjectWorktreeReadMemo,
  projectId: string,
): Promise<WorktreeData[]> {
  const service = getWorkspaceContextService();
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  const keyAt = (epoch: number): string => JSON.stringify([epoch, workspaceId]);
  const shared = memo.lists.get(keyAt(service.accountEpoch()));
  if (shared) return shared;
  // The epoch bumps when a transition starts, so a sample is shared only if
  // the epoch held across the drain: no transition was running when the read
  // began, and one starting later bumps past this key. Otherwise a retry
  // under the new epoch would reuse a mid-transition sample.
  const drainedFrom = service.accountEpoch();
  await service.whenIdle();
  const epoch = service.accountEpoch();
  if (!memo.open || epoch !== drainedFrom) {
    return queryProjectWorktrees(projectId);
  }
  const key = keyAt(epoch);
  const read = memo.lists.get(key) ?? queryProjectWorktrees(projectId);
  memo.lists.set(key, read);
  return read;
}

/**
 * One task row under the authority rules of {@link readProjectWorktrees}:
 * undefined only when an authoritative list lacks it. A memo scope reuses its
 * list; otherwise the row is read by id, and any by-id failure is reclassified
 * by the list read, so missing rows and unreadable lists keep their errors.
 */
export async function readProjectWorktree(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeData | undefined> {
  const findInList = async (): Promise<WorktreeData | undefined> =>
    (await readProjectWorktrees(projectId)).find(
      (candidate) => candidate.id === worktreeId,
    );
  if (projectWorktreeReadMemo.getStore()?.open) return findInList();
  const response = await getActiveDesktopRuntime()
    .queryWorktreeGetForLegacyIpc(
      {
        worktreeId,
        scope: { workspaceId: resolveCoworkWorkspaceId(projectId) },
      },
      readOptions('core.worktree.read'),
    )
    .catch(() => null);
  if (!response) return findInList();
  const authority = readAuthority(response)?.authority;
  if (authority === 'absent') return undefined;
  if (authority !== 'ok')
    throw sourceReadFailed('Project worktrees could not be read.');
  return response.legacyResult;
}

async function queryProjectWorktrees(
  projectId: string,
): Promise<WorktreeData[]> {
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  const response = await getActiveDesktopRuntime().readWorktreeListForLegacy(
    workspaceId,
    readOptions('core.worktree.read'),
  );
  const authority = readAuthority(response);
  if (
    !authority ||
    (authority.authority !== 'ok' && authority.authority !== 'absent')
  ) {
    throw sourceReadFailed('Project worktrees could not be read.');
  }
  if (authority.authority === 'absent') return [];
  if (Array.isArray(response.legacyResult)) return response.legacyResult;
  throw sourceReadFailed('Project worktrees could not be read.');
}

/** Strict registry-only read. A failure is intentionally left for the caller to type. */
export async function readProjectEntries(
  projectId: string,
): Promise<CoworkWorkEntriesFile> {
  return readWorkEntriesFileStrict(resolveCoworkWorkspaceId(projectId));
}

/** One runtime snapshot for an authorized task; transcript/session data is not read. */
export async function readTaskSnapshot(
  projectId: string,
  taskId: string,
): Promise<ChatStateSnapshot> {
  const response = await getActiveDesktopRuntime().queryChatStateForLegacyIpc(
    {
      scope: {
        workspaceId: resolveCoworkWorkspaceId(projectId),
        worktreeId: taskId,
      },
    },
    readOptions('core.chat.read'),
  );
  const snapshot = response.legacyResult;
  if (snapshot.recoveryError !== undefined) {
    throw sourceReadFailed('Task runtime snapshot could not be read.');
  }
  if (
    snapshot.projectId !== resolveCoworkWorkspaceId(projectId) ||
    snapshot.worktreeId !== taskId
  ) {
    throw sourceReadFailed(
      'Task runtime snapshot did not match the requested task.',
    );
  }
  return snapshot;
}

/** Read committed parent and tab evidence without starting runtime recovery. */
export async function readCommittedTaskSnapshot(
  projectId: string,
  taskId: string,
): Promise<ChatStateSnapshot> {
  const { getChatStateService } =
    await import('../services/chat-state-service');
  return getChatStateService().getCommittedWatcherSnapshot({
    projectId: resolveCoworkWorkspaceId(projectId),
    worktreeId: taskId,
  });
}

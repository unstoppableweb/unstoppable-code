import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import type {
  CanopyCallerDescriptor,
  CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import type { WorkspaceType } from '@canopy/desktop-shared/types';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/**
 * Which local reads may be sent to the core daemon, as code (CAN-5501).
 * The eligibility half of each daemon read route: the operation × platform
 * qualification table, operation prerequisites, caller and scope rules, and
 * local lookups only, never daemon contact. A route still applies its own
 * disposal and selection set.
 * Nothing here reads a user setting; under the always-on daemon model there
 * is no switch.
 */

export type FilesReadRouteOperation =
  | 'files.roots'
  | 'files.directory'
  | 'files.file'
  | 'files.search'
  | 'files.link';

/** `status` and `diff` are reserved for CAN-4103's changed-files and diff reads. */
export type GitReadRouteOperation =
  | 'git.branch.list'
  | 'git.remote.get'
  | 'git.worktree.health.get'
  | 'git.executable.get'
  | 'git.status.get'
  | 'git.diff.get';

export type ReadRouteOperation =
  | FilesReadRouteOperation
  | GitReadRouteOperation;

export type ReadRoutePlatform = PlatformOperatingSystem;

export type ReadRouteDisposition =
  | { readonly kind: 'eligible' }
  | {
      readonly kind: 'blocked';
      /** The ticket that satisfies this prerequisite or qualification. */
      readonly until: `CAN-${number}`;
      readonly reason: string;
    };

const ELIGIBLE: ReadRouteDisposition = { kind: 'eligible' };
const WINDOWS_PENDING: ReadRouteDisposition = {
  kind: 'blocked',
  until: 'CAN-4732',
  reason: 'Windows daemon reads beyond roots and directory are not verified.',
};
const ELIGIBLE_EXCEPT_WINDOWS: Readonly<
  Record<ReadRoutePlatform, ReadRouteDisposition>
> = {
  darwin: ELIGIBLE,
  win32: WINDOWS_PENDING,
  linux: ELIGIBLE,
};
/**
 * CAN-4729's decision: Electron main's own Git spawns, Browse and the
 * installer resolve Git from this detection, so a daemon route would add a
 * round trip without retiring main's detection. Reconsider when main no
 * longer runs Git (CAN-6803).
 */
const EXECUTABLE_RETAINED: ReadRouteDisposition = {
  kind: 'blocked',
  until: 'CAN-4729',
  reason: 'Stays in-process: main resolves Git for its own spawns from it.',
};
const CHANGED_FILES_PENDING: ReadRouteDisposition = {
  kind: 'blocked',
  until: 'CAN-4103',
  reason: 'Reserved for the changed-files and diff reads.',
};
const PROTOCOL_QUALIFICATION_PENDING: ReadRouteDisposition = {
  kind: 'blocked',
  until: 'CAN-4729',
  reason:
    'Platform qualification has not been assessed for this reserved read.',
};
const CHANGED_FILES_QUALIFICATION_PENDING: ReadRouteDisposition = {
  kind: 'blocked',
  until: 'CAN-4103',
  reason:
    'Platform qualification has not been assessed for this reserved read.',
};
/**
 * CAN-4729's decision: both callers of the remote read, `repo:get-remote-url`
 * and the workspace reference repository health, answer with the origin URL
 * as Git printed it. The contract withholds a local remote's URL and strips a
 * network URL's userinfo, so a daemon answer could not serve them without
 * reading the configuration again in main. Reconsider when no caller needs
 * the unredacted URL.
 */
const REMOTE_RETAINED: ReadRouteDisposition = {
  kind: 'blocked',
  until: 'CAN-4729',
  reason: 'Stays in-process: callers need the origin URL the contract redacts.',
};

/**
 * Platform qualification only, not route selection or proof of serving.
 * Roots and directory keep their shipped reach on all three hosts. File,
 * search, link and branch list qualified on Linux in CAN-5547 after their
 * equivalence suites passed; Linux owns the daemon since CAN-4966. Worktree
 * health qualified on macOS and Linux in CAN-4729: its checks run no network
 * Git, and the daemon answers with codes only.
 * Reserved cells stay blocked pending assessment even when prerequisites
 * are met.
 * A missing row or platform fails to compile.
 */
export const READ_ROUTE_TABLE: Readonly<
  Record<
    ReadRouteOperation,
    Readonly<Record<ReadRoutePlatform, ReadRouteDisposition>>
  >
> = {
  'files.roots': { darwin: ELIGIBLE, win32: ELIGIBLE, linux: ELIGIBLE },
  'files.directory': { darwin: ELIGIBLE, win32: ELIGIBLE, linux: ELIGIBLE },
  'files.file': ELIGIBLE_EXCEPT_WINDOWS,
  'files.search': ELIGIBLE_EXCEPT_WINDOWS,
  'files.link': ELIGIBLE_EXCEPT_WINDOWS,
  'git.branch.list': ELIGIBLE_EXCEPT_WINDOWS,
  'git.remote.get': {
    darwin: PROTOCOL_QUALIFICATION_PENDING,
    win32: PROTOCOL_QUALIFICATION_PENDING,
    linux: PROTOCOL_QUALIFICATION_PENDING,
  },
  'git.worktree.health.get': ELIGIBLE_EXCEPT_WINDOWS,
  'git.executable.get': {
    darwin: PROTOCOL_QUALIFICATION_PENDING,
    win32: PROTOCOL_QUALIFICATION_PENDING,
    linux: PROTOCOL_QUALIFICATION_PENDING,
  },
  'git.status.get': {
    darwin: CHANGED_FILES_QUALIFICATION_PENDING,
    win32: WINDOWS_PENDING,
    linux: CHANGED_FILES_QUALIFICATION_PENDING,
  },
  'git.diff.get': {
    darwin: CHANGED_FILES_QUALIFICATION_PENDING,
    win32: WINDOWS_PENDING,
    linux: CHANGED_FILES_QUALIFICATION_PENDING,
  },
};

/** Non-platform blockers survive any platform qualification change. */
export const READ_ROUTE_PREREQUISITES: Readonly<
  Record<ReadRouteOperation, ReadRouteDisposition>
> = {
  'files.roots': ELIGIBLE,
  'files.directory': ELIGIBLE,
  'files.file': ELIGIBLE,
  'files.search': ELIGIBLE,
  'files.link': ELIGIBLE,
  'git.branch.list': ELIGIBLE,
  'git.remote.get': REMOTE_RETAINED,
  'git.worktree.health.get': ELIGIBLE,
  'git.executable.get': EXECUTABLE_RETAINED,
  'git.status.get': CHANGED_FILES_PENDING,
  'git.diff.get': CHANGED_FILES_PENDING,
};

/**
 * The scope selectors an operation's IPC requests carry; any other selector
 * keeps the in-process reader, so no route reinterprets a foreign selection.
 * `worktree`: exactly `{workspaceId, worktreeId}`. `repository`: a
 * `workspaceId` with an optional `worktreeId` and `repoId`.
 */
export type ReadRouteScopeShape = 'worktree' | 'repository';

export const READ_ROUTE_SCOPE_SHAPES: Readonly<
  Record<ReadRouteOperation, ReadRouteScopeShape>
> = {
  'files.roots': 'worktree',
  'files.directory': 'worktree',
  'files.file': 'worktree',
  'files.search': 'worktree',
  'files.link': 'worktree',
  'git.branch.list': 'repository',
  'git.remote.get': 'repository',
  'git.worktree.health.get': 'worktree',
  'git.executable.get': 'repository',
  'git.status.get': 'repository',
  'git.diff.get': 'repository',
};

/** The trusted ids a plan carries, after alias resolution. */
export type ReadRouteTarget =
  | {
      readonly shape: 'worktree';
      readonly workspaceId: string;
      readonly worktreeId: string;
    }
  | {
      readonly shape: 'repository';
      readonly workspaceId: string;
      readonly worktreeId?: string;
      readonly repoId?: string;
    };

export interface ReadRouteLookups {
  /** Trusted alias normalization (standalone Cowork); `null` stays in-process. */
  readonly resolveWorktreeTargetIds: (
    projectId: string,
    worktreeId: string,
  ) => { projectId: string; worktreeId: string } | null;
  readonly workspaceType: (workspaceId: string) => WorkspaceType | null;
  /** Checked on the requested id, before alias resolution. */
  readonly excludedWorkspaceIds: ReadonlySet<string>;
  readonly routedWorkspaceTypes: ReadonlySet<WorkspaceType>;
}

export interface ReadRouteInput {
  readonly operation: ReadRouteOperation;
  /** `null`: an unknown host, which no cell names, so every read stays in-process. */
  readonly platform: ReadRoutePlatform | null;
  readonly caller: CanopyCallerDescriptor;
  /** The trusted IPC event's sender. */
  readonly senderId: number;
  readonly scope: CanopyWorkspaceScope;
  readonly lookups: ReadRouteLookups;
}

const LOCAL_CALLER_PREFIX = 'electron-web-contents:';

const SCOPE_SELECTORS: Readonly<
  Record<ReadRouteScopeShape, ReadonlySet<string>>
> = {
  worktree: new Set(['workspaceId', 'worktreeId']),
  repository: new Set(['workspaceId', 'worktreeId', 'repoId']),
};

function hasOnlySelectors(
  scope: CanopyWorkspaceScope,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.entries(scope).every(
    ([key, value]) => value === undefined || allowed.has(key),
  );
}

/**
 * The host platform the table is read for; an unsupported host is `null`,
 * which keeps every read in-process.
 */
export function resolveReadRoutePlatform(
  read: () => ReadRoutePlatform = hostPlatformOperatingSystem,
): ReadRoutePlatform | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * The local window caller trusted main derived for this exact sender.
 * Remote-control bridge callers (`remote-bridge:<id>`) never match: they
 * always keep the in-process reader, by decision.
 */
export function isLocalWindowCaller(
  caller: CanopyCallerDescriptor,
  senderId: number,
): boolean {
  return (
    caller.interfaceKind === 'desktop' &&
    caller.authorityId === LOCAL_DESKTOP_AUTHORITY_ID &&
    caller.clientInstanceId === `${LOCAL_CALLER_PREFIX}${senderId}`
  );
}

/**
 * Whether a read is eligible, independent of production selection: satisfied
 * operation prerequisites and platform qualification for this host,
 * the trusted local window caller for this exact sender, a scope of the
 * operation's shape, and a registered, routed workspace. `null` keeps the
 * in-process reader.
 */
export function evaluateReadRoute(
  input: ReadRouteInput,
): ReadRouteTarget | null {
  const { operation, platform } = input;
  if (platform === null) return null;
  if (READ_ROUTE_PREREQUISITES[operation].kind !== 'eligible') return null;
  if (READ_ROUTE_TABLE[operation][platform].kind !== 'eligible') return null;
  return evaluateLocalRouteTarget({
    ...input,
    shape: READ_ROUTE_SCOPE_SHAPES[operation],
  });
}

/** Shared local caller/scope guard, also used by unselected mutation and watch routes. */
export function evaluateLocalRouteTarget(
  input: Pick<ReadRouteInput, 'caller' | 'senderId' | 'scope' | 'lookups'> & {
    readonly shape: ReadRouteScopeShape;
  },
): ReadRouteTarget | null {
  const { caller, scope, lookups, shape } = input;
  if (!isLocalWindowCaller(caller, input.senderId)) return null;
  const { workspaceId, worktreeId, repoId } = scope;
  if (
    workspaceId === undefined ||
    (shape === 'worktree' && worktreeId === undefined) ||
    !hasOnlySelectors(scope, SCOPE_SELECTORS[shape])
  )
    return null;
  if (
    isBotProjectId(workspaceId) ||
    lookups.excludedWorkspaceIds.has(workspaceId)
  )
    return null;
  const resolved =
    worktreeId === undefined
      ? null
      : lookups.resolveWorktreeTargetIds(workspaceId, worktreeId);
  if (worktreeId !== undefined && !resolved) return null;
  // Only registered workspaces: an unknown id keeps the in-process read.
  const type = lookups.workspaceType(resolved?.projectId ?? workspaceId);
  if (type === null || !lookups.routedWorkspaceTypes.has(type)) return null;
  if (shape === 'worktree')
    return resolved
      ? {
          shape,
          workspaceId: resolved.projectId,
          worktreeId: resolved.worktreeId,
        }
      : null;
  return {
    shape,
    workspaceId: resolved?.projectId ?? workspaceId,
    ...(resolved && { worktreeId: resolved.worktreeId }),
    ...(repoId !== undefined && { repoId }),
  };
}

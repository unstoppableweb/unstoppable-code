import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  NEW_WORKTREE_DISPLAY_NAME,
  pickUniqueAnimalName,
} from '@canopy/protocol/worktree-branch-names';
import type { WorktreeRowProps } from '@canopy/ui-shared/components';
import { orderWorktreesForSidebar } from './sidebar-model';
import type { SidebarSortMode } from './sidebar/sidebar-ordering';
import {
  compareWorkspaces,
  compareWorktrees,
  deriveWorktreeUiStatus,
  isTreeLayout,
  type SnapshotWorkspace,
  type SnapshotWorktree,
} from './worktree-status';

/**
 * Minimal structural snapshot the sections layer consumes. A host may pass
 * its full `SessionViewModel`, but browser-local projections that omit
 * unrelated collections (e.g. the web portal's `RemoteControlSessionShellState`
 * without `chatProjects`) satisfy this shape too.
 */
export interface WorkspaceSectionsSnapshot {
  readonly workspaces: readonly SnapshotWorkspace[];
  readonly worktrees: readonly SnapshotWorktree[];
  /**
   * The standalone chats a flat-layout project lists, when the host renders
   * them. Only their ownership and archived state are read: they are a flat
   * project's live content for the `alwaysShow: false` visibility rule.
   */
  readonly standaloneChats?: readonly WorkspaceContentChat[];
  /**
   * Per-chat attention the rows roll up (a waiting question). Optional: a
   * host whose snapshot carries no chat summaries simply gets no roll-up.
   */
  readonly chatSummaries?: readonly WorktreeChatAttentionSummary[];
}

/** The slice of a standalone chat the project visibility rule reads. */
export interface WorkspaceContentChat {
  readonly projectLocalId?: string;
  readonly archived?: boolean;
}

/**
 * The chat-summary fields a worktree row's attention roll-up reads, a
 * structural subset of the wire's `RemoteControlChatSummaryEntity`.
 */
export interface WorktreeChatAttentionSummary {
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly pendingQuestions?: readonly { readonly answered: boolean }[];
}

/** The `${workspaceLocalId}/${worktreeLocalId}` key rows are addressed by. */
export function worktreeRowKey(
  workspaceLocalId: string,
  worktreeLocalId: string,
): string {
  return `${workspaceLocalId}/${worktreeLocalId}`;
}

/**
 * Worktrees with at least one chat waiting on an unanswered question. The
 * wire carries questions per chat; the row's question dot is per worktree, so
 * every host that ships chat summaries (the portal today) lights it from the
 * same roll-up instead of each inventing one.
 */
export function rollUpPendingQuestionWorktreeKeys(
  summaries: readonly WorktreeChatAttentionSummary[] | undefined,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const summary of summaries ?? []) {
    if (!summary.workspaceLocalId || !summary.worktreeLocalId) continue;
    if (summary.pendingQuestions?.some((question) => !question.answered)) {
      keys.add(
        worktreeRowKey(summary.workspaceLocalId, summary.worktreeLocalId),
      );
    }
  }
  return keys;
}

export interface WorkspaceSectionsPartition {
  readonly visible: SnapshotWorkspace[];
  readonly hidden: SnapshotWorkspace[];
}

export interface WorktreeSectionsPartition {
  readonly visible: SnapshotWorktree[];
  readonly hidden: SnapshotWorktree[];
}

export type WorktreeRuntimeProjection = Pick<
  WorktreeRowProps,
  | 'uiStatus'
  | 'isStreaming'
  | 'backgroundTasks'
  | 'isRunningRun'
  | 'isDiscovering'
  | 'pipelineStatus'
  | 'terminalStatus'
  | 'scriptStatus'
  | 'hookStatus'
  | 'splitStatus'
  | 'splitStatusMessage'
  | 'awaitingApproval'
  | 'hasPendingQuestion'
  | 'hasUnread'
  | 'healthIssue'
  | 'setupPhase'
  | 'diffStats'
  | 'runtimeState'
>;

/**
 * Whether this workspace renders a worktree tree. Named for LAYOUT, not for
 * repo-backing: a cloud workspace is repoless yet tree-shaped, so the old
 * `isGitWorkspace`/`type !== 'cowork'` framing described neither axis honestly
 * (REG-2819).
 */
export function isTreeWorkspace(workspace: SnapshotWorkspace): boolean {
  return isTreeLayout(workspace);
}

export { compareWorkspaces, compareWorktrees };

/**
 * Context scoping (CAN-2954, plan chapter 03): Personal lists rows with no
 * owner or a Personal owner; an organization context lists its owned rows
 * plus Personal checkouts explicitly linked by the host. No context means no
 * scoping, so hosts that predate contexts keep today's list.
 */
export function snapshotWorkspaceMatchesContext(
  workspace: Pick<SnapshotWorkspace, 'owner'> &
    Partial<Pick<SnapshotWorkspace, 'localId'>>,
  context: WorkspaceContext | undefined,
  linkedPersonalWorkspaceIds: readonly string[] = [],
): boolean {
  if (context === undefined) return true;
  const owner = workspace.owner;
  if (context.kind === 'personal') {
    return owner === undefined || owner.type === 'personal';
  }
  if (owner === undefined || owner.type === 'personal') {
    return (
      workspace.localId !== undefined &&
      linkedPersonalWorkspaceIds.includes(workspace.localId)
    );
  }
  // An org-owned cloud workspace (CAN-3458) has no org project behind it but
  // belongs to the same context as the org's materialized projects.
  return (
    (owner.type === 'organization' || owner.type === 'cloud-organization') &&
    owner.organizationId === context.organizationId
  );
}

export function partitionWorktrees(
  worktrees: readonly SnapshotWorktree[],
  workspaceLocalId: string,
  mode: SidebarSortMode = 'manual',
): WorktreeSectionsPartition {
  const ordered = orderWorktreesForSidebar(
    worktrees.filter(
      (worktree) => worktree.workspaceLocalId === workspaceLocalId,
    ),
    mode,
  );
  return {
    visible: ordered.filter((worktree) => worktree.hidden !== true),
    hidden: ordered.filter((worktree) => worktree.hidden === true),
  };
}

export function partitionWorkspaces(
  workspaces: readonly SnapshotWorkspace[],
  worktrees: readonly SnapshotWorktree[],
  options: {
    /**
     * Admit flat-layout workspaces too. Hosts set this when they can render the
     * standalone-chats projection. Tree-layout workspaces — repo-backed AND
     * cloud — are always admitted regardless.
     */
    readonly includeFlat?: boolean;
    readonly visibleWorkspaceIds?: ReadonlySet<string>;
    /** Scope rows to the selected Personal/organization context. */
    readonly context?: WorkspaceContext;
    /** Personal checkouts linked by the host to the selected organization. */
    readonly linkedPersonalWorkspaceIds?: readonly string[];
    /**
     * Standalone chats, the live content of flat-layout projects. Without
     * them a flat project has no content the rule can see.
     */
    readonly standaloneChats?: readonly WorkspaceContentChat[];
  } = {},
): WorkspaceSectionsPartition {
  const sorted = workspaces
    .filter(
      (workspace) =>
        // Catalog placeholders (CAN-2955) are not workspaces: hosts that want
        // them render a dedicated row from the catalog, never this list.
        workspace.placeholder === undefined &&
        (isTreeWorkspace(workspace) || options.includeFlat === true) &&
        (options.visibleWorkspaceIds === undefined ||
          options.visibleWorkspaceIds.has(workspace.localId)) &&
        snapshotWorkspaceMatchesContext(
          workspace,
          options.context,
          options.linkedPersonalWorkspaceIds,
        ),
    )
    .slice()
    .sort(compareWorkspaces);
  // A project that is not set to always show lists only while it has live
  // content. A tree project's content is its visible worktrees; a flat
  // (desktop Cowork) project has none, so its content is its unarchived chats,
  // the legacy desktop rail's `workEntryCount` rule.
  const flatWorkspacesWithChats = new Set(
    (options.standaloneChats ?? [])
      .filter((chat) => chat.archived !== true)
      .map((chat) => chat.projectLocalId),
  );
  const isVisible = (workspace: SnapshotWorkspace): boolean => {
    if (workspace.hidden === true) return false;
    if (workspace.alwaysShow !== false) return true;
    if (!isTreeWorkspace(workspace)) {
      return flatWorkspacesWithChats.has(workspace.localId);
    }
    return partitionWorktrees(worktrees, workspace.localId).visible.length > 0;
  };
  return {
    visible: sorted.filter(isVisible),
    hidden: sorted.filter((workspace) => !isVisible(workspace)),
  };
}

/**
 * Legacy done fallback: older cached payloads may omit `status` while every
 * repo with a PR reports `merged` — the pre-extraction portal treated that as
 * done and the shared row must keep doing so.
 */
export function isWorktreeDone(worktree: SnapshotWorktree): boolean {
  if (worktree.status === 'done') return true;
  if (worktree.status !== undefined) return false;
  const repos = worktree.lastKnownPrStatus?.repos ?? [];
  const reposWithPrs = repos.filter((repo) => repo.status !== null);
  return (
    reposWithPrs.length > 0 &&
    reposWithPrs.every((repo) => repo.status?.state === 'merged')
  );
}

/** Row state rolled up from other snapshot collections (chat summaries). */
export interface WorktreeRuntimeRollups {
  readonly hasPendingQuestion?: boolean;
  /**
   * The row's space is muted (`isSpaceNotificationMuted`): its blue-dot
   * sources, unread chats and an unseen pipeline success, are masked before
   * anything derives from them. Orange and red states and live work still show.
   */
  readonly spaceMuted?: boolean;
}

/**
 * Drops a muted space's blue-dot sources; the snapshot itself is untouched.
 * A host's live row overrides get the same mask in `WorkspacesSidebarSections`
 * (`maskMutedWorktreeRowOverrides`); a new blue-dot source needs both.
 */
function maskMutedSpace(
  worktree: SnapshotWorktree,
  spaceMuted: boolean,
): SnapshotWorktree {
  if (!spaceMuted) return worktree;
  return {
    ...worktree,
    hasUnread: undefined,
    pipelineStatus:
      worktree.pipelineStatus === 'unseen'
        ? undefined
        : worktree.pipelineStatus,
  };
}

export function projectWorktreeRuntime(
  snapshotWorktree: SnapshotWorktree,
  rollups: WorktreeRuntimeRollups = {},
): WorktreeRuntimeProjection {
  const worktree = maskMutedSpace(
    snapshotWorktree,
    rollups.spaceMuted === true,
  );
  const done = isWorktreeDone(worktree);
  return {
    uiStatus: done ? 'done' : deriveWorktreeUiStatus(worktree),
    isStreaming: worktree.isStreaming,
    backgroundTasks: worktree.backgroundTasks,
    isRunningRun: worktree.isRunningRun ?? worktree.busy,
    isDiscovering: worktree.isDiscovering,
    pipelineStatus: worktree.pipelineStatus,
    terminalStatus: worktree.terminalStatus,
    scriptStatus: worktree.scriptStatus,
    hookStatus: worktree.hookStatus,
    splitStatus:
      worktree.splitPrStatus === 'ready'
        ? 'review'
        : worktree.splitPrStatus === 'completed'
          ? 'done'
          : worktree.splitPrStatus
            ? 'active'
            : undefined,
    splitStatusMessage: worktree.splitPrStatusMessage,
    awaitingApproval: worktree.awaitingApproval,
    hasPendingQuestion: rollups.hasPendingQuestion === true,
    hasUnread: worktree.hasUnread,
    healthIssue: worktree.healthIssue,
    setupPhase: worktree.setupPhase,
    diffStats: worktree.diffStats,
    runtimeState: done ? 'done' : undefined,
  };
}

export function workspaceWorktreeIds(
  worktrees: readonly SnapshotWorktree[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const ids = new Map<string, Set<string>>();
  for (const worktree of worktrees) {
    const workspaceIds = ids.get(worktree.workspaceLocalId) ?? new Set();
    workspaceIds.add(worktree.localId);
    ids.set(worktree.workspaceLocalId, workspaceIds);
  }
  return ids;
}

export function newWorktreeIdsAfterSnapshot(
  baseline: ReadonlySet<string>,
  workspaceLocalId: string,
  worktrees: readonly SnapshotWorktree[],
): readonly string[] {
  return worktrees
    .filter(
      (worktree) =>
        worktree.workspaceLocalId === workspaceLocalId &&
        !baseline.has(worktree.localId),
    )
    .map((worktree) => worktree.localId);
}

/**
 * One in-flight sidebar worktree create, per workspace. The surface renders it
 * as a synthetic {@link SnapshotWorktree} through the real row pipeline (see
 * {@link mergePendingCreateRows}) until the host lists the created row.
 */
export interface PendingWorktreeCreate {
  /**
   * The client-claimed worktree id when `claimed`, else a temporary
   * `pending-create:<n>` key that names no worktree.
   */
  readonly key: string;
  readonly claimed: boolean;
  /** The workspace's worktree ids when the create was dispatched. */
  readonly baseline: ReadonlySet<string>;
  readonly groupId?: string;
  /** ISO time of the click; the synthetic row's `createdAt`. */
  readonly createdAt: string;
  readonly startedAtMs: number;
  /** The id the host's `completed` result named, authoritative over `key`. */
  readonly resolvedId?: string;
  readonly completedAtMs?: number;
  /** The host answered `pending` (the Portal): only the snapshot can name the row. */
  readonly snapshotResolves?: boolean;
  /** The selection key at the click; the pending row shows selected only while it holds. */
  readonly selectionKey: string | null;
  /** Identity of this attempt; a newer create in the workspace replaces it. */
  readonly attempt: { readonly selectionRevision: number };
}

/**
 * A pending create's claim: an id `pickUniqueAnimalName` draws for the
 * workspace's published `worktreeIdClaimPrefix`, or `undefined` when the
 * workspace does not publish one (a host that names every worktree itself).
 * The prefix is `''` in production, so presence is tested, not truthiness.
 *
 * Only the ids this client can see are avoided. The host also skips ids that
 * archived or quarantined worktrees reserve, and then names the worktree
 * itself; the pending row re-keys once to the host's id. That rare swap is
 * accepted rather than publishing the host's reserved ids in the snapshot.
 */
export function claimPendingWorktreeId(
  workspace: Pick<SnapshotWorkspace, 'worktreeIdClaimPrefix'>,
  existingIds: ReadonlySet<string>,
): string | undefined {
  const prefix = workspace.worktreeIdClaimPrefix;
  if (prefix === undefined) return undefined;
  return pickUniqueAnimalName(existingIds, { prefix });
}

/** The local id the pending row renders with (its React key and `data-worktree-id`). */
export function pendingCreateRowId(entry: PendingWorktreeCreate): string {
  return entry.resolvedId ?? entry.key;
}

export type PendingCreateTarget =
  /** No created row can be named yet. */
  | { readonly kind: 'waiting' }
  /** More than one addition without the claim: none can be correlated with the create. */
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'target'; readonly worktreeId: string };

/**
 * The id the pending create resolves to: the host's `completed` id, else the
 * claim, else the single id the baseline diff finds. A create adopts another
 * addition, or gives up as ambiguous, only once the host has answered
 * `pending`: until then the host's own answer will name the id, so an
 * unrelated worktree arriving first is never taken for this create, and a
 * burst of rows never releases a create the host is about to name.
 *
 * Known tradeoff (no wire correlation id): once only the snapshot can name the
 * row, a single new id is assumed to be this create, so an unrelated worktree
 * landing in the same workspace may be adopted. Duplicate creation per
 * workspace is suppressed and creates resolve quickly, and the effect is a
 * navigation, not a mutation.
 */
export function pendingCreateTarget(
  entry: PendingWorktreeCreate,
  workspaceLocalId: string,
  worktrees: readonly SnapshotWorktree[],
): PendingCreateTarget {
  if (entry.resolvedId !== undefined) {
    return { kind: 'target', worktreeId: entry.resolvedId };
  }
  const added = newWorktreeIdsAfterSnapshot(
    entry.baseline,
    workspaceLocalId,
    worktrees,
  );
  if (entry.claimed) {
    // A host still answering will name the id itself.
    if (
      added.includes(entry.key) ||
      added.length === 0 ||
      entry.snapshotResolves !== true
    ) {
      return { kind: 'target', worktreeId: entry.key };
    }
    if (added.length === 1) return { kind: 'target', worktreeId: added[0] };
    // Several rows arrived without the claim and the host will never name
    // one, so none can be correlated: release now, not at the deadline.
    return { kind: 'ambiguous' };
  }
  // A host still answering will name the id itself.
  if (entry.snapshotResolves !== true) return { kind: 'waiting' };
  if (added.length === 1) return { kind: 'target', worktreeId: added[0] };
  return added.length > 1 ? { kind: 'ambiguous' } : { kind: 'waiting' };
}

/**
 * The synthetic row for a pending create. It differs from the real row only
 * in data, so listing, ordering, grouping and the shared row render it exactly
 * as they will render the created worktree. In manual order it takes the
 * slot before every existing row, where hosts insert a new worktree.
 */
export function buildPendingCreateWorktree(
  workspace: Pick<SnapshotWorkspace, 'localId' | 'backend'>,
  entry: PendingWorktreeCreate,
  worktrees: readonly SnapshotWorktree[],
): SnapshotWorktree {
  let minOrder: number | undefined;
  for (const worktree of worktrees) {
    if (worktree.workspaceLocalId !== workspace.localId) continue;
    const order = worktree.order ?? 0;
    if (minOrder === undefined || order < minOrder) minOrder = order;
  }
  return {
    localId: pendingCreateRowId(entry),
    workspaceLocalId: workspace.localId,
    branch: '',
    label: NEW_WORKTREE_DISPLAY_NAME,
    setupPhase: 'git-pending',
    createdAt: entry.createdAt,
    order: minOrder === undefined ? 0 : minOrder - 1,
    ...(workspace.backend === undefined ? {} : { backend: workspace.backend }),
  };
}

/**
 * The snapshot's worktrees with each pending create's synthetic row merged
 * in. One row per id: while a create is pending, any snapshot row with its
 * target id (or its row id) is dropped in favour of the synthetic row, so the
 * swap on release keeps one React key and never renders a duplicate.
 * Returns `worktrees` itself when nothing is pending.
 */
export function mergePendingCreateRows(
  workspaces: readonly Pick<SnapshotWorkspace, 'localId' | 'backend'>[],
  worktrees: readonly SnapshotWorktree[],
  pending: ReadonlyMap<string, PendingWorktreeCreate>,
): readonly SnapshotWorktree[] {
  if (pending.size === 0) return worktrees;
  const synthetic: SnapshotWorktree[] = [];
  const replaced = new Set<string>();
  pending.forEach((entry, workspaceLocalId) => {
    const workspace = workspaces.find(
      (candidate) => candidate.localId === workspaceLocalId,
    );
    if (!workspace) return;
    const target = pendingCreateTarget(entry, workspaceLocalId, worktrees);
    if (target.kind === 'target') {
      replaced.add(worktreeRowKey(workspaceLocalId, target.worktreeId));
    }
    replaced.add(worktreeRowKey(workspaceLocalId, pendingCreateRowId(entry)));
    synthetic.push(buildPendingCreateWorktree(workspace, entry, worktrees));
  });
  if (synthetic.length === 0) return worktrees;
  return [
    ...synthetic,
    ...worktrees.filter(
      (worktree) =>
        !replaced.has(
          worktreeRowKey(worktree.workspaceLocalId, worktree.localId),
        ),
    ),
  ];
}

/**
 * Whether `worktreeLocalId` is the synthetic row of a pending create in that
 * workspace. Such a row is inert: no drag, menu, actions, preview, dialogs,
 * activation or bulk selection.
 */
export function isPendingCreateRow(
  pending: ReadonlyMap<string, PendingWorktreeCreate>,
  workspaceLocalId: string,
  worktreeLocalId: string,
): boolean {
  const entry = pending.get(workspaceLocalId);
  return entry !== undefined && pendingCreateRowId(entry) === worktreeLocalId;
}

/**
 * The workspace's item groups with a pending create's row as the first member
 * of the group it was created in, so the synthetic row lists inside that group
 * as the created row will. Returns `groups` itself when nothing changes.
 */
export function withPendingGroupMember<
  Group extends { readonly id: string; readonly memberIds: readonly string[] },
>(
  groups: readonly Group[],
  entry: PendingWorktreeCreate | undefined,
): readonly Group[] {
  const groupId = entry?.groupId;
  if (entry === undefined || groupId === undefined) return groups;
  const rowId = pendingCreateRowId(entry);
  if (!groups.some((group) => group.id === groupId)) return groups;
  return groups.map((group) => {
    const others = group.memberIds.filter((id) => id !== rowId);
    if (group.id === groupId)
      return { ...group, memberIds: [rowId, ...others] };
    return others.length === group.memberIds.length
      ? group
      : { ...group, memberIds: others };
  });
}

/**
 * How long a pending create may wait with no matching row before the surface
 * abandons it: twice the Portal's 30 s create wait while the create is in
 * flight or `pending`, and a short grace once the host reported `completed`.
 */
export const PENDING_CREATE_TIMEOUT_MS = 60_000;
export const COMPLETED_CREATE_TIMEOUT_MS = 15_000;

/**
 * The last resort for an entry the deadline above deliberately keeps, such as
 * an in-flight create whose row is listed but vetoed or not yet answered for:
 * a create that never settles still cannot pin the row and disable `+`.
 */
export const PENDING_CREATE_BACKSTOP_MS = 5 * 60_000;

export function pendingCreateDeadline(entry: PendingWorktreeCreate): number {
  return entry.completedAtMs === undefined
    ? entry.startedAtMs + PENDING_CREATE_TIMEOUT_MS
    : entry.completedAtMs + COMPLETED_CREATE_TIMEOUT_MS;
}

export function pendingCreateBackstop(entry: PendingWorktreeCreate): number {
  return entry.startedAtMs + PENDING_CREATE_BACKSTOP_MS;
}

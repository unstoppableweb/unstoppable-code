import {
  resolveWorkspaceLayout,
  type RemoteControlSessionShellState,
  type RemoteControlRowBackend,
  type RemoteControlWorkspaceLayout,
} from '@canopy/protocol/remote-control/shell';

/** The worktree shape carried on the neutral shell snapshot. */
export type SnapshotWorktree =
  RemoteControlSessionShellState['worktrees'][number];
/** The workspace shape carried on the neutral shell snapshot. */
export type SnapshotWorkspace =
  RemoteControlSessionShellState['workspaces'][number];
/** Browser-compatible workspace projection before legacy `type` normalization. */
export type SidebarWorkspace = Omit<SnapshotWorkspace, 'type'> & {
  readonly type?: SnapshotWorkspace['type'];
};

/**
 * How a workspace's rows place in the sidebar — `'tree'` renders a worktree
 * tree under the header, `'flat'` renders the standalone-chats projection.
 *
 * THE single layout read in this package. Every placement branch calls this
 * rather than testing `workspace.type`, which is why a cloud workspace can
 * classify honestly as `cowork` while still laying out as a tree (REG-2819).
 *
 * Hosts normalize `layout` at their ingestion boundary, but this resolves it
 * again at the read site on purpose: `ui-app` is consumed by two independent
 * hosts plus their test fixtures, and defaulting a missing value the same way
 * everywhere is cheaper than trusting every caller to have normalized. The
 * fallback lives in the protocol resolver, not here — see its doc comment for
 * why `type` is allowed to inform it and nowhere else.
 */
export function workspaceLayout(
  workspace: Pick<SidebarWorkspace, 'type' | 'layout'>,
): RemoteControlWorkspaceLayout {
  return resolveWorkspaceLayout(workspace);
}

/** True when the workspace renders a worktree tree rather than a flat chat list. */
export function isTreeLayout(
  workspace: Pick<SidebarWorkspace, 'type' | 'layout'>,
): boolean {
  return workspaceLayout(workspace) === 'tree';
}

/**
 * User-facing title for a shared sidebar row. Cloud Cowork snapshots carry a
 * synthetic branch because the neutral worktree shape requires one, but a
 * repoless session must never expose that implementation detail as fallback
 * copy when its title has not arrived yet.
 */
export function sidebarRowLabel(
  workspace: Pick<SidebarWorkspace, 'type'>,
  worktree: Pick<SnapshotWorktree, 'branch' | 'label'>,
): string {
  if (workspace.type === 'cowork') return untitledTaskLabel(worktree.label);
  return worktree.label?.trim() || worktree.branch;
}

/**
 * A cowork task's title, or the placeholder the sidebar shows for an untitled
 * one. A list of tasks on the same host, such as the desktop More page of
 * archived tasks, names an untitled task this way too (CAN-6792).
 */
export function untitledTaskLabel(title: string | undefined): string {
  return title?.trim() || 'Session';
}

/**
 * The backend a workspace header should pip, derived from the workspace's own
 * rows and falling back to the workspace record only when it has none.
 *
 * Rows are authoritative because backend is a property of a row, not of a
 * workspace: a workspace whose rows disagree is genuinely mixed and gets no
 * single pip (`null`) rather than a wrong one. No such workspace exists yet —
 * each backend's snapshot is projected separately — but deriving it this way is
 * what lets the mixed case render a mixed treatment later with no schema change.
 *
 * `worktrees` may be the whole snapshot or just this workspace's rows; rows
 * belonging to another workspace are skipped either way. Callers that already
 * hold the workspace's partition should pass it, so the sidebar does not gain a
 * second full-snapshot scan per workspace on every render.
 */
export function deriveWorkspaceBackend(
  workspace: Pick<SidebarWorkspace, 'localId' | 'backend'>,
  worktrees: readonly SnapshotWorktree[],
): Exclude<RemoteControlRowBackend, 'desktop'> | null {
  let resolved: RemoteControlRowBackend | undefined;
  for (const worktree of worktrees) {
    if (worktree.workspaceLocalId !== workspace.localId) continue;
    if (worktree.backend === undefined) continue;
    if (resolved === undefined) {
      resolved = worktree.backend;
      continue;
    }
    if (resolved !== worktree.backend) return null;
  }
  const backend = resolved ?? workspace.backend ?? null;
  return backend === 'desktop' ? 'remote-control' : backend;
}

/**
 * Minimal structural snapshot needed by workspace visibility/order selectors.
 * Hosts may pass a full session model or a browser-local projection that omits
 * unrelated protocol collections such as `chatProjects`.
 */
export interface WorkspaceVisibilitySnapshot {
  readonly workspaces: readonly SidebarWorkspace[];
  readonly worktrees: readonly SnapshotWorktree[];
}

/** The five coarse row states the shared `WorktreeRow` renders. */
export type WorktreeUiStatus =
  | 'idle'
  | 'planning'
  | 'working'
  | 'unread'
  | 'done';

/**
 * Derive the shared `WorktreeRow` `uiStatus` from the neutral worktree snapshot
 * flags, mirroring the desktop canonical `computeWorktreeUiStatus`
 * (`apps/desktop-app/src/renderer/src/lib/worktree-status.ts`) so the shared
 * sidebar renders identically to desktop.
 *
 * Priority (highest → lowest): `done > unread > working > planning > idle`.
 * (A `done` worktree that is also streaming shows `done`; a streaming worktree
 * with unread shows `unread` — matching desktop, not the reverse.)
 */
export function deriveWorktreeUiStatus(
  worktree: Pick<
    SnapshotWorktree,
    | 'isStreaming'
    | 'busy'
    | 'isRunningRun'
    | 'awaitingApproval'
    | 'hasUnread'
    | 'status'
    | 'pipelineStatus'
  >,
): WorktreeUiStatus {
  // A running pipeline counts as working, matching the desktop
  // WorktreeManager derivation, so the promoted pipeline icon (which hosts
  // the pipeline popover) appears on portal rows too.
  const isWorking =
    worktree.isStreaming === true ||
    worktree.busy === true ||
    worktree.isRunningRun === true ||
    worktree.pipelineStatus === 'running';
  if (worktree.status === 'done') {
    return 'done';
  }
  if (worktree.hasUnread === true) {
    return 'unread';
  }
  if (isWorking) {
    return 'working';
  }
  if (
    worktree.awaitingApproval === true ||
    worktree.pipelineStatus === 'paused'
  ) {
    // A paused pipeline awaits input, matching the desktop derivation where
    // pipeline 'paused' maps to the planning state.
    return 'planning';
  }
  return 'idle';
}

/**
 * Canonical sidebar workspace ordering: persisted `order`, then display name,
 * then `localId` for determinism. Single source of truth — the sections model
 * re-exports this; do not fork.
 */
export function compareWorkspaces(
  first: SidebarWorkspace,
  second: SidebarWorkspace,
): number {
  const orderDifference = (first.order ?? 0) - (second.order ?? 0);
  if (orderDifference !== 0) return orderDifference;
  const nameDifference = first.name.localeCompare(second.name);
  return nameDifference !== 0
    ? nameDifference
    : first.localId.localeCompare(second.localId);
}

/**
 * Canonical sidebar worktree ordering: persisted `order`, then trimmed label
 * (branch fallback), then `localId`. Single source of truth — the sections
 * model re-exports this; do not fork.
 */
export function compareWorktrees(
  first: SnapshotWorktree,
  second: SnapshotWorktree,
): number {
  // Pinned rows lead their section, as on desktop; within each group the
  // host's order decides.
  const pinDifference =
    Number(second.pinned === true) - Number(first.pinned === true);
  if (pinDifference !== 0) return pinDifference;
  const orderDifference = (first.order ?? 0) - (second.order ?? 0);
  if (orderDifference !== 0) return orderDifference;
  const labelDifference = (first.label?.trim() || first.branch).localeCompare(
    second.label?.trim() || second.branch,
  );
  return labelDifference !== 0
    ? labelDifference
    : first.localId.localeCompare(second.localId);
}

/**
 * Visible workspaces in sidebar order. Drops `hidden` workspaces, and mirrors
 * the desktop `WorktreeManager` rule for `alwaysShow: false` (temporary/
 * adhoc-combine) workspaces: they only surface while they still have a visible
 * worktree, so an empty temporary workspace is not rendered as a ghost header.
 */
export function orderedWorkspaces(
  snapshot: WorkspaceVisibilitySnapshot | null,
): SidebarWorkspace[] {
  return (snapshot?.workspaces ?? [])
    .filter((workspace) => {
      if (workspace.hidden) {
        return false;
      }
      if (workspace.alwaysShow === false) {
        return worktreesForWorkspace(snapshot, workspace.localId).length > 0;
      }
      return true;
    })
    .slice()
    .sort(compareWorkspaces);
}

/** Visible worktrees for one workspace in sidebar order (hidden ones dropped). */
export function worktreesForWorkspace(
  snapshot: WorkspaceVisibilitySnapshot | null,
  workspaceLocalId: string,
): SnapshotWorktree[] {
  return (snapshot?.worktrees ?? [])
    .filter(
      (worktree) =>
        worktree.workspaceLocalId === workspaceLocalId && !worktree.hidden,
    )
    .slice()
    .sort(compareWorktrees);
}

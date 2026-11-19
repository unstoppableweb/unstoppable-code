import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { SessionViewModel } from '@canopy/app-core';
import type { RemoteControlPipelineRunProjection } from '@canopy/protocol/remote-control/shell';
import { createClientStore } from '../create-client-store';

/** A worktree row from the neutral shell snapshot. */
export type OverviewWorktree = SessionViewModel['worktrees'][number];

/** Pipeline-run statuses treated as active in the Overview. */
const ACTIVE_PIPELINE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
]);

/**
 * Terminal pipeline-run statuses treated as "unread" (recently finished and
 * likely needing a look) — mirrors the desktop overview's `isTerminalStatus`.
 * `paused` is terminal in the desktop overview semantics, not "in progress".
 * `pending` (pre-execution) and `running` are active and therefore flow to
 * {@link selectRunningPipelineRuns} rather than this terminal section.
 */
const TERMINAL_PIPELINE_STATUSES: ReadonlySet<string> = new Set([
  'paused',
  'success',
  'failure',
  'cancelled',
]);

/**
 * The shared overview/home store. The home dashboard aggregates across all
 * workspaces/worktrees — unread chats, in-progress chats + pipeline runs,
 * plans awaiting approval — all of which are already carried on the neutral
 * {@link SessionViewModel} shell snapshot (worktree `hasUnread`/`isStreaming`/
 * `isRunningRun`/`awaitingApproval` flags + `pipelineRuns`). So this store is a
 * snapshot holder and the aggregation is done through the pure selectors below.
 *
 * Notification data remains outside this store because it is not part of the
 * neutral shell state. Hosts may compose their own notification view through
 * the shared Overview render slot when the matching capability is enabled.
 */
export interface OverviewState {
  /** The last-hydrated shell snapshot, or `null` before first load. */
  readonly snapshot: SessionViewModel | null;
  /** Replace the shell snapshot (e.g. on first load or resync). */
  readonly hydrate: (snapshot: SessionViewModel | null) => void;
}

function worktreesOf(state: OverviewState): readonly OverviewWorktree[] {
  return state.snapshot?.worktrees ?? [];
}

// Hidden policy (intentional asymmetry): only `selectUnreadWorktrees` excludes
// hidden worktrees — an unread badge is a "needs your attention" signal the user
// muted by hiding. In-progress / awaiting-approval intentionally include hidden
// worktrees (a hidden worktree can still be actively working, and mirrors the
// desktop `selectInProgressChatCards`, which does not filter hidden). Reconfirm
// this decision against the projector when it wires these flags at adopt time.

/** Visible worktrees with unread chat activity (hidden worktrees excluded). */
export function selectUnreadWorktrees(
  state: OverviewState,
): OverviewWorktree[] {
  return worktreesOf(state).filter(
    (w) => w.hasUnread === true && w.hidden !== true,
  );
}

/** Worktrees with an actively streaming chat turn (hidden included — see policy above). */
export function selectInProgressChatWorktrees(
  state: OverviewState,
): OverviewWorktree[] {
  return worktreesOf(state).filter((w) => w.isStreaming === true);
}

/** Worktrees with an ask-user prompt awaiting approval (hidden included). */
export function selectAwaitingApprovalWorktrees(
  state: OverviewState,
): OverviewWorktree[] {
  return worktreesOf(state).filter((w) => w.awaitingApproval === true);
}

/**
 * Pipeline runs currently active across all worktrees. Both `'pending'` and
 * `'running'` count as in progress, matching the desktop store's authoritative
 * active-execution set. `'paused'` remains terminal in the Overview semantics.
 */
export function selectRunningPipelineRuns(
  state: OverviewState,
): RemoteControlPipelineRunProjection[] {
  return (state.snapshot?.pipelineRuns ?? []).filter((run) =>
    ACTIVE_PIPELINE_STATUSES.has(run.status),
  );
}

/**
 * Pipeline runs that recently reached a terminal state (finished / paused /
 * failed / cancelled) across all worktrees — the home dashboard's "unread
 * pipelines" section. The desktop projector feeds only the worktrees the user
 * has not yet seen; web feeds all terminal runs until it tracks seen-state.
 */
export function selectUnreadPipelineRuns(
  state: OverviewState,
): RemoteControlPipelineRunProjection[] {
  return (state.snapshot?.pipelineRuns ?? []).filter((run) =>
    TERMINAL_PIPELINE_STATUSES.has(run.status),
  );
}

/** Aggregate badge counts for the home dashboard. */
export interface OverviewCounts {
  readonly unreadChats: number;
  readonly inProgressChats: number;
  readonly runningPipelines: number;
  readonly unreadPipelines: number;
  readonly awaitingApproval: number;
}

/** Compute the home dashboard's aggregate counts from the snapshot. */
export function selectOverviewCounts(state: OverviewState): OverviewCounts {
  return {
    unreadChats: selectUnreadWorktrees(state).length,
    inProgressChats: selectInProgressChatWorktrees(state).length,
    runningPipelines: selectRunningPipelineRuns(state).length,
    unreadPipelines: selectUnreadPipelineRuns(state).length,
    awaitingApproval: selectAwaitingApprovalWorktrees(state).length,
  };
}

/** Display label for a worktree card: its workspace name + worktree name. */
export interface WorktreeLabel {
  readonly workspaceName: string | null;
  readonly worktreeName: string;
}

/** Resolve a worktree's display label from the snapshot, or `null` if unknown. */
export function selectWorktreeLabel(
  state: OverviewState,
  worktreeLocalId: string,
  workspaceLocalId?: string,
): WorktreeLabel | null {
  const worktree = worktreesOf(state).find(
    (w) =>
      w.localId === worktreeLocalId &&
      (workspaceLocalId === undefined ||
        w.workspaceLocalId === workspaceLocalId),
  );
  if (!worktree) {
    return null;
  }
  const workspace = state.snapshot?.workspaces.find(
    (w) => w.localId === worktree.workspaceLocalId,
  );
  return {
    workspaceName: workspace?.name ?? null,
    worktreeName: worktree.label ?? worktree.branch,
  };
}

/**
 * Create an overview store. It holds the shell snapshot and needs no transport
 * of its own yet (the aggregation is derived through the pure selectors); a
 * later slice can add `client.subscribe` for live updates. Wrapped by
 * {@link createClientStore} so each client gets one memoized store.
 */
export function createOverviewStore(): UseBoundStore<StoreApi<OverviewState>> {
  return create<OverviewState>((set) => ({
    snapshot: null,
    hydrate: (snapshot): void => {
      set({ snapshot });
    },
  }));
}

/**
 * Selector hook for the shared overview store, bound to the ambient
 * {@link CanopyClient} from `CanopyClientProvider`. The store is still memoized
 * per client (a fresh client on reconnect gets a fresh snapshot); the factory
 * receives no `client` arg only because it needs no transport yet.
 */
export const useOverviewStore = createClientStore(createOverviewStore);

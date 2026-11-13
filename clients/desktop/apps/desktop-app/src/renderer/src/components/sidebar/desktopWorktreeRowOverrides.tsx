import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/shallow';
import type { CoreCoworkTask } from '@canopy/app-state/core-cowork';
import { cloudCoworkStore } from '@/cloud-chats/cloud-cowork-store';
import { retryCloudTask } from '@/cloud-chats/useCloudCoworkSidebar';
import { markCloudTaskShown } from '@/cloud-chats/task-creation-timing';
import { webCoreLocalId } from '@/lib/chat-authority';
import { createWithEqualityFn } from 'zustand/traditional';
import {
  isWorktreeDone,
  type WorktreeRowOverrides,
  type WorktreeRowSlotContext,
} from '@canopy/ui-app';
import {
  ChatPreviewPopover,
  RunBadgePopover,
  type ChatPreviewRow,
  type RunBadgeRow,
} from '@canopy/ui-shared/components';
import { CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import { PLAN_EXPLORE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { WorktreeUiStatus } from '@/lib/worktree-status';
import {
  getScheduledMessagesForWorktree,
  hasScheduledMessagesForWorktree,
} from '@/lib/worktreeSessionPromptAutomations';
import { useActivityStore } from '@/stores/activityStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { chatStoreRenderView, useChatStore } from '@/stores/chatStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import { useCodeGraphBuildStore } from '@/stores/codeGraphBuildStore';
import { useHooksStore, type HookRunState } from '@/stores/hooksStore';
import {
  isScriptRunActive,
  useScriptsStore,
  type ScriptRunState,
} from '@/stores/scriptsStore';
import {
  buildIdleWatcherChatRows,
  hasIdleWatcherChat,
} from '../worktree/idle-watcher-chats';
import { resolvePipelineStatus } from '../worktree/resolvePipelineStatus';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { worktreeRecencyMs } from '@/lib/sidebar-ordering';
import {
  buildChatPreviewRows,
  buildHookRunBadgeRows,
  buildScheduledMessagePreviewRows,
  buildScriptRunBadgeRows,
  buildToolApprovalPreviewRows,
} from '../worktree/worktreeRowPreviewRows';
import {
  deriveWorktreeSplitRowStatus,
  useWorktreeSplitRowFacts,
} from '../worktree/worktreeSplitRowStatus';
import { deriveDesktopPrBadgeStatus } from '../worktree/worktreePrBadge';
import {
  WorktreePrCreatingIndicator,
  WorktreePrMergingIndicator,
} from '../worktree/WorktreePrProgressIndicators';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import {
  shouldShowWorktreeMergedState,
  useGitHubStore,
} from '@/stores/githubStore';

/*
 * Desktop's live worktree-row state for the shared rail.
 *
 * The shared rail renders rows from the session snapshot, which main rebuilds
 * only on invalidation, while the legacy rail's `WorktreeItem` read the same
 * facts straight from the renderer stores. These overrides restore that: the
 * host passes `useDesktopWorktreeRowOverrides` to `SidebarSurface`, which runs
 * it INSIDE each row, so every row subscribes to exactly its own live state.
 *
 * Two sources, deliberately:
 * - The attention key sets (streaming, plan review, question, tool approval,
 *   unread, UI status) come from the host's `useSidebarWorkspaces` model,
 *   through {@link useDesktopRowLiveKeysStore}. That model is the single
 *   derivation both rails share (`deriveChatBadgeKeys`); re-deriving it per
 *   row would let the rails drift again.
 * - Row-local facts no sidebar model carries (plan-chat unread, the split
 *   workflow) are read here with narrow per-row selectors.
 */

/** The host model's attention key sets, keyed `${projectId}/${worktreeId}`. */
export interface DesktopWorktreeRowLiveKeys {
  /** Every worktree the store knows, with its list-row UI status. */
  readonly statusByKey: ReadonlyMap<string, WorktreeUiStatus>;
  readonly streaming: ReadonlySet<string>;
  readonly awaitingApproval: ReadonlySet<string>;
  readonly pendingQuestion: ReadonlySet<string>;
  readonly toolApproval: ReadonlySet<string>;
  readonly unread: ReadonlySet<string>;
  /**
   * Pipeline state from the renderer's run store. The unseen results are
   * renderer-owned (a run is "seen" when its activity panel is opened), so
   * main's snapshot, which knows only running and paused, cannot carry them.
   */
  readonly pipelineRunning: ReadonlySet<string>;
  readonly pipelineUnseen: ReadonlySet<string>;
  readonly pipelineUnseenFailed: ReadonlySet<string>;
  readonly pipelinePaused: ReadonlySet<string>;
  /** Live background tasks by row (turn-state D11), for the background spinner. */
  readonly backgroundTasks: ReadonlyMap<string, number>;
}

interface DesktopRowLiveKeysState {
  readonly keys: DesktopWorktreeRowLiveKeys | null;
}

/**
 * A small external store, not React Context. The host recomputes the live
 * key sets in one place (`DesktopSharedSidebarHost`) and publishes them here;
 * each row then reads through {@link useDesktopWorktreeRowOverrides}, which
 * selects only its own derived attention and compares it with
 * `desktopRowAttentionEqual` (see below).
 *
 * What this isolates: a PUBLISH to this store (`setDesktopRowLiveKeys`) only
 * re-renders the rows whose own derived attention actually changed, not
 * every row — a Context provider re-renders every consumer on any value
 * change; this store does not.
 *
 * What this does NOT isolate: an ordinary React re-render of the host or the
 * surface above the rows (a snapshot refresh, any other store the host
 * subscribes to) still re-renders every row once — nothing here changes how
 * many rows a PARENT re-render touches. In the common case where a live
 * update changes one row, every row renders once (from the parent) and the
 * changed row renders twice (once from the parent, once from this store's
 * publish); memoizing row rendering against parent re-renders too is a
 * separate, larger change, tracked separately.
 */
export const useDesktopRowLiveKeysStore =
  createWithEqualityFn<DesktopRowLiveKeysState>(() => ({ keys: null }));

/** Host-only publish point; call from an effect keyed on the recomputed key sets. */
export function setDesktopRowLiveKeys(keys: DesktopWorktreeRowLiveKeys): void {
  useDesktopRowLiveKeysStore.setState({ keys });
}

/**
 * Host-only teardown: clears the published key sets back to `null` (the
 * hook's fallback-to-snapshot state). The store is a module-level singleton,
 * so without this a host unmount followed by a remount — the shape a session
 * change takes, since switching accounts/sessions remounts the sidebar host —
 * would briefly render the PREVIOUS session's rows against the last key sets
 * that session published, until the new mount's own effect recomputes and
 * republishes. Call from the host's unmount cleanup.
 */
export function resetDesktopRowLiveKeys(): void {
  useDesktopRowLiveKeysStore.setState({ keys: null });
}

export type DesktopRowAttention = Required<
  Pick<
    WorktreeRowOverrides,
    | 'uiStatus'
    | 'isStreaming'
    | 'backgroundTasks'
    | 'awaitingApproval'
    | 'hasPendingQuestion'
    | 'hasPendingToolApproval'
    | 'hasUnread'
  >
> &
  Pick<WorktreeRowOverrides, 'runtimeState' | 'pipelineStatus'>;

/**
 * A row's live attention state from the host's key sets, or `null` for a row
 * the store does not know (a cloud catalog row), which keeps its snapshot.
 * `hasUnreadPlanChat` folds in plan-explore chats that finished while their
 * modal was closed, as the legacy row did.
 *
 * `snapshotDone` is `isWorktreeDone(context.worktree)` — the SAME "done"
 * fallback `projectWorktreeRuntime()` applies to the snapshot on purpose
 * (older cached payloads can omit `worktree.status` while every repo's PR
 * reports merged; the legacy row treated that as done too, via its own
 * `worktree.status === 'done'` check landing on the SAME live-updated
 * projects-store record). The live map's own status uses a stricter,
 * narrower check (`buildWorktreeStatusMap`'s `isDone`), so without this a
 * row the snapshot already marked done could be UN-marked the moment live
 * keys publish. Once either source calls a row done, it stays done — `done`
 * never reverses.
 */
export function deriveDesktopRowAttention(
  keys: DesktopWorktreeRowLiveKeys,
  key: string,
  hasUnreadPlanChat: boolean,
  snapshotDone: boolean,
): DesktopRowAttention | null {
  const liveUiStatus = keys.statusByKey.get(key);
  if (liveUiStatus === undefined) return null;
  const uiStatus = snapshotDone ? 'done' : liveUiStatus;
  return {
    uiStatus,
    runtimeState: uiStatus === 'done' ? 'done' : undefined,
    isStreaming: keys.streaming.has(key),
    backgroundTasks: keys.backgroundTasks.get(key) ?? 0,
    awaitingApproval: keys.awaitingApproval.has(key),
    hasPendingQuestion: keys.pendingQuestion.has(key),
    hasPendingToolApproval: keys.toolApproval.has(key),
    hasUnread: keys.unread.has(key) || hasUnreadPlanChat,
    pipelineStatus: resolvePipelineStatus({
      worktreeKey: key,
      pipelineRunningWorktreeKeys: keys.pipelineRunning,
      pipelineUnseenWorktreeKeys: keys.pipelineUnseen,
      pipelineUnseenFailedWorktreeKeys: keys.pipelineUnseenFailed,
      pipelinePausedWorktreeKeys: keys.pipelinePaused,
    }),
  };
}

/**
 * Field-by-field equality for the per-row selector's result, so
 * `useDesktopRowLiveKeysStore` skips a row's re-render when a store update
 * left this row's own attention unchanged (see the store's docstring).
 */
export function desktopRowAttentionEqual(
  a: DesktopRowAttention | null,
  b: DesktopRowAttention | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.uiStatus === b.uiStatus &&
    a.runtimeState === b.runtimeState &&
    a.isStreaming === b.isStreaming &&
    a.backgroundTasks === b.backgroundTasks &&
    a.awaitingApproval === b.awaitingApproval &&
    a.hasPendingQuestion === b.hasPendingQuestion &&
    a.hasPendingToolApproval === b.hasPendingToolApproval &&
    a.hasUnread === b.hasUnread &&
    a.pipelineStatus === b.pipelineStatus
  );
}

/**
 * The row's PR badge and done label from the live GitHub store. `undefined`
 * means the store has not looked this worktree up yet, so the snapshot's
 * last-known status stands; `null` is a confirmed "no PR" and clears it.
 */
export function deriveDesktopRowPr(
  prStatus: WorktreePrStatus | null | undefined,
  isMultiRepo: boolean,
  isDone: boolean,
): Pick<WorktreeRowOverrides, 'lastKnownPrStatus' | 'doneLabel'> {
  if (prStatus === undefined) return {};
  return {
    lastKnownPrStatus: deriveDesktopPrBadgeStatus(prStatus, isMultiRepo),
    doneLabel: shouldShowWorktreeMergedState(
      isDone ? 'done' : 'active',
      prStatus,
    )
      ? 'PR merged'
      : 'Done',
  };
}

/** The label a multi-repo row shows when its repos sit on different branches. */
export const MULTIPLE_BRANCHES_LABEL = 'Multiple branches';

/**
 * The branch name of a multi-repo row from its per-repo branches, as the
 * legacy row derived it: `Multiple Branches` when they diverge. The snapshot
 * carries one branch per worktree, so only the renderer's per-repo list can
 * tell. Returns `undefined` for a row whose repos agree or are not loaded.
 */
export function divergentRepoBranchLabel(
  repoBranches: readonly { readonly branch: string }[] | undefined,
): string | undefined {
  if (!repoBranches || repoBranches.length === 0) return undefined;
  return new Set(repoBranches.map((repo) => repo.branch)).size > 1
    ? MULTIPLE_BRANCHES_LABEL
    : undefined;
}

interface HoverAnchor {
  readonly anchorRect: DOMRect | null;
  readonly onMouseEnter: (event: MouseEvent<HTMLSpanElement>) => void;
  readonly onFocus: (event: FocusEvent<HTMLSpanElement>) => void;
  readonly onHide: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => void;
}

interface HoverPreview extends HoverAnchor {
  readonly rows: ChatPreviewRow[];
}

const EMPTY_PREVIEW_ROWS: ChatPreviewRow[] = [];
// Stable empties for the shallow run selectors: a fresh `[]` would never
// compare equal and would re-render the row on every store update.
const EMPTY_SCRIPT_RUNS: ScriptRunState[] = [];
const EMPTY_HOOK_RUNS: HookRunState[] = [];

/**
 * Hover/focus state for one indicator's popover: opens on hover or focus,
 * closes on leave, blur, or Escape (which also drops focus), as the legacy
 * row's indicators did. `onOpen` runs as it opens.
 */
function useHoverAnchor(onOpen?: () => void): HoverAnchor {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const show = useCallback(
    (element: HTMLElement): void => {
      onOpen?.();
      setAnchorRect(element.getBoundingClientRect());
    },
    [onOpen],
  );
  const onHide = useCallback((): void => setAnchorRect(null), []);
  const onMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => show(event.currentTarget),
    [show],
  );
  const onFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => show(event.currentTarget),
    [show],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== 'Escape') return;
      setAnchorRect(null);
      event.currentTarget.blur();
    },
    [],
  );
  return useMemo(
    () => ({ anchorRect, onMouseEnter, onFocus, onHide, onKeyDown }),
    [anchorRect, onMouseEnter, onFocus, onHide, onKeyDown],
  );
}

// Field-agnostic, so a field added to `ChatPreviewRow` is compared too.
// `Object.is` relies on every row field staying a primitive. A nested
// object would compare unequal on every notification and re-render the
// open popover each frame.
function sameChatPreviewRow(a: ChatPreviewRow, b: ChatPreviewRow): boolean {
  const aEntries: Array<[string, unknown]> = Object.entries(a);
  const bValues = new Map<string, unknown>(Object.entries(b));
  return (
    aEntries.length === bValues.size &&
    aEntries.every(
      ([key, value]) => bValues.has(key) && Object.is(value, bValues.get(key)),
    )
  );
}

function sameChatPreviewRows(
  a: readonly ChatPreviewRow[],
  b: readonly ChatPreviewRow[],
): boolean {
  return (
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index];
      return other !== undefined && sameChatPreviewRow(row, other);
    })
  );
}

/**
 * A chat-preview popover's hover state. The rows are snapshotted when it
 * opens and never subscribed while it is closed, so a streaming token does
 * not re-render the row. With `subscribe`, an OPEN popover re-derives its
 * rows from each notification and updates only when they change, so data
 * that lands after it opened (a chat hydrating just after its approval
 * arrived) replaces the placeholder.
 */
function useHoverPreview(
  buildRows: () => ChatPreviewRow[],
  subscribe?: (listener: () => void) => () => void,
): HoverPreview {
  const [rows, setRows] = useState<ChatPreviewRow[]>(EMPTY_PREVIEW_ROWS);
  const snapshotRows = useCallback(
    (): void => setRows(buildRows()),
    [buildRows],
  );
  const anchor = useHoverAnchor(snapshotRows);
  const open = anchor.anchorRect !== null;
  useEffect(() => {
    if (!open || !subscribe) return undefined;
    const refresh = (): void => {
      const next = buildRows();
      setRows((current) =>
        sameChatPreviewRows(current, next) ? current : next,
      );
    };
    // Catch anything that changed between the open snapshot and this effect.
    refresh();
    return subscribe(refresh);
  }, [open, subscribe, buildRows]);
  return useMemo(() => ({ ...anchor, rows }), [anchor, rows]);
}

/** One indicator's open chat-preview popover, while its state still holds. */
function chatPreviewPopover(
  preview: HoverPreview,
  visible: boolean,
  heading: string,
): JSX.Element | undefined {
  return preview.anchorRect && visible ? (
    <ChatPreviewPopover
      anchorRect={preview.anchorRect}
      rows={preview.rows}
      heading={heading}
    />
  ) : undefined;
}

/**
 * The shared rail's per-row override hook for desktop. See the module note;
 * returns a memoized object so a row whose live state did not change keeps
 * its identity.
 */
export function useDesktopWorktreeRowOverrides(
  context: WorktreeRowSlotContext,
): WorktreeRowOverrides | undefined {
  const overrides = useLocalWorktreeRowOverrides(context);
  const creation = useCloudTaskCreationOverrides(
    context.workspace.localId,
    context.worktree.localId,
  );
  return useMemo(
    () => (creation === undefined ? overrides : { ...overrides, ...creation }),
    [overrides, creation],
  );
}

/**
 * A cloud task this window opened before the web core created it
 * (CAN-6098): its row reads as being created, or, once refused, why, with a
 * retry under the same id. Other rows have none.
 */
function useCloudTaskCreationOverrides(
  projectId: string,
  worktreeId: string,
): WorktreeRowOverrides | undefined {
  const workspaceId = webCoreLocalId(projectId);
  const taskId = webCoreLocalId(worktreeId);
  const task = (
    state: ReturnType<typeof cloudCoworkStore.getState>,
  ): CoreCoworkTask | undefined =>
    workspaceId === null || taskId === null
      ? undefined
      : state.tasksByProject[`web-core:${workspaceId}`]?.find(
          (each) => each.worktreeId === taskId,
        );
  const creation = useStore(cloudCoworkStore, (state) => task(state)?.creation);
  const reason = useStore(
    cloudCoworkStore,
    (state) => task(state)?.creationError,
  );
  useEffect(() => {
    if (creation !== undefined && taskId !== null)
      markCloudTaskShown(taskId, 'rowShown');
  }, [creation, taskId]);
  return useMemo((): WorktreeRowOverrides | undefined => {
    if (creation === 'pending') return { setupPhase: 'creating' };
    if (creation !== 'failed') return undefined;
    return {
      creationFailure: {
        reason: reason ?? 'This task was not created.',
        onRetry: (): void => {
          retryCloudTask(projectId, worktreeId);
        },
      },
    };
  }, [creation, reason, projectId, worktreeId]);
}

function useLocalWorktreeRowOverrides(
  context: WorktreeRowSlotContext,
): WorktreeRowOverrides | undefined {
  const projectId = context.workspace.localId;
  const worktreeId = context.worktree.localId;
  const key = `${projectId}/${worktreeId}`;

  // Plan-explore chats finishing while their modal is closed mark a dedicated
  // plan-scoped tab unread; surface that on this row. Primitive/shallow
  // selectors so streaming tokens never re-render the row.
  const trackedPlanIds = useActivityStore(
    useShallow((state) =>
      (state.trackedPlans[key] ?? []).map((plan) => plan.id),
    ),
  );
  const hasUnreadPlanChat = useChatSidebarStore((state) =>
    trackedPlanIds.some((planId) => {
      const planChat =
        state.worktrees[`${PLAN_EXPLORE_CHAT_PROJECT_ID}/${planId}`];
      return planChat
        ? planChat.tabs.some((tab) => tab.unread === true)
        : false;
    }),
  );
  const splitFacts = useWorktreeSplitRowFacts(projectId, worktreeId);

  // Once the snapshot has called a worktree done, that must stick even after
  // live keys publish — see `deriveDesktopRowAttention`'s docstring.
  const snapshotDone = isWorktreeDone(context.worktree);
  // Live attention state, read through a per-row selector with a field-level
  // equality check (`desktopRowAttentionEqual`) so a status change on another
  // worktree does not re-render this row; see `useDesktopRowLiveKeysStore`.
  const attention = useDesktopRowLiveKeysStore(
    (state) =>
      state.keys
        ? deriveDesktopRowAttention(
            state.keys,
            key,
            hasUnreadPlanChat,
            snapshotDone,
          )
        : null,
    desktopRowAttentionEqual,
  );

  // Watchers waiting idly on this row's chats (the broadcast indicator).
  const worktreeWatchers = useAppAdvisorWatchersStore(
    useShallow((state) =>
      state.watchers.filter(
        (watcher) =>
          watcher.destination.projectId === projectId &&
          watcher.destination.worktreeId === worktreeId &&
          watcher.status === 'active',
      ),
    ),
  );
  const hasIdleWatcherChats = useChatSidebarStore((state) =>
    hasIdleWatcherChat({
      projectId,
      worktreeId,
      tabs: state.worktrees[key]?.tabs,
      watchers: worktreeWatchers,
    }),
  );
  // A primitive boolean, not the whole activities array: the array is
  // replaced wholesale on every automation change (including unrelated
  // `recentRuns` updates), so subscribing to it re-renders and rescans every
  // row on any automation change. The popover's own message list is built
  // from `getState()` only when it opens (`buildScheduledRows` below), the
  // same on-hover-snapshot pattern `buildWatcherRows` already uses.
  const hasScheduledMessages = useAutomationsStore((state) =>
    hasScheduledMessagesForWorktree(state.activities, projectId, worktreeId),
  );
  // Live, not the snapshot: a `script:started` event lands in the scripts
  // store at once, while main's snapshot waits for an invalidation.
  const activeScriptRuns = useScriptsStore(
    useShallow((state): ScriptRunState[] => {
      const runs = state.runs[key];
      if (!runs) return EMPTY_SCRIPT_RUNS;
      const active = Object.values(runs).filter((run) =>
        isScriptRunActive(run.status),
      );
      return active.length > 0 ? active : EMPTY_SCRIPT_RUNS;
    }),
  );
  const activeHookRuns = useHooksStore(
    useShallow((state): HookRunState[] => {
      const runs = state.runs[key];
      if (!runs) return EMPTY_HOOK_RUNS;
      const active = Object.values(runs).filter(
        (run) => run.status === 'running',
      );
      return active.length > 0 ? active : EMPTY_HOOK_RUNS;
    }),
  );
  // Live PR state, as the legacy row read it: injected and polled statuses
  // land here first, the snapshot only after main rebuilds it.
  const pr = useGitHubStore(
    useShallow((state) => ({
      // A `null` status is only trustworthy as a confirmed "no PR" when the
      // store's own bookkeeping says a live signal set it (CAN-3053 finding
      // 8) — `hydratePersistedPrStatuses` also writes `null` wholesale from
      // the renderer's own possibly-stale `lastKnownPrStatus` copy, and that
      // case must fall back to the snapshot instead of clearing the badge.
      status:
        state.prStatuses[key] === null &&
        !state.livePrStatusWorktreeKeys.has(key)
          ? undefined
          : state.prStatuses[key],
      creating: state.creatingPr.has(key),
      merging: state.mergingPr.has(key),
    })),
  );
  const isMultiRepo = context.workspace.type === 'multi-repo';
  // Git stats and per-repo branches from the projects store, which the
  // persisted Git stat cache restores on relaunch before main's snapshot
  // has recomputed them.
  const diffStats = useProjectsStore((state) => state.diffStats[key]);
  const divergentBranch = useProjectsStore((state) =>
    isMultiRepo ? divergentRepoBranchLabel(state.repoBranches[key]) : undefined,
  );
  // The user's own label, not the snapshot's: main folds branch-display
  // names ("New worktree") into the snapshot label, and only a label the user set
  // outranks the divergent-branch name, as on the legacy row.
  const customLabel = useProjectsStore((state) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project || project.type === 'cowork') return undefined;
    return project.worktrees
      .find((worktree) => worktree.id === worktreeId)
      ?.label?.trim();
  });
  // The Last updated sort's watermark; the row shows it as its age under
  // early access.
  const recencyMs = useProjectsStore((state) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project || project.type === 'cowork') return undefined;
    const worktree = project.worktrees.find((item) => item.id === worktreeId);
    return worktree ? worktreeRecencyMs(worktree) : undefined;
  });
  const testIdSuffix = context.pinnedSurface ? `-${context.pinnedSurface}` : '';
  // No selection gate: a background build lights every row it touches.
  const isBuildingCodeGraph = useCodeGraphBuildStore(
    (state) => state.building[key] === true,
  );

  const buildApprovalRows = useCallback(
    (): ChatPreviewRow[] => buildChatPreviewRows(key, 'approval'),
    [key],
  );
  const buildUnreadRows = useCallback(
    (): ChatPreviewRow[] => buildChatPreviewRows(key, 'unread'),
    [key],
  );
  const buildToolApprovalRows = useCallback(
    (): ChatPreviewRow[] =>
      buildToolApprovalPreviewRows(key, projectId, worktreeId),
    [key, projectId, worktreeId],
  );
  const buildWatcherRows = useCallback(
    (): ChatPreviewRow[] =>
      buildIdleWatcherChatRows({
        projectId,
        worktreeId,
        tabs: useChatStore.getState().worktreeChats[key]?.tabs,
        watchers: useAppAdvisorWatchersStore.getState().watchers,
      }),
    [key, projectId, worktreeId],
  );
  const buildScheduledRows = useCallback(
    (): ChatPreviewRow[] =>
      buildScheduledMessagePreviewRows({
        wtKey: key,
        messages: getScheduledMessagesForWorktree({
          activities: useAutomationsStore.getState().activities,
          workspaceId: projectId,
          worktreeId,
        }),
      }),
    [key, projectId, worktreeId],
  );
  const approvalPreview = useHoverPreview(buildApprovalRows);
  const unreadPreview = useHoverPreview(buildUnreadRows);
  // The approval can arrive before this worktree's chats hydrate, so an open
  // popover follows the chat store until the blocked chat's title lands.
  const toolApprovalPreview = useHoverPreview(
    buildToolApprovalRows,
    chatStoreRenderView.subscribe,
  );
  const watcherPreview = useHoverPreview(buildWatcherRows);
  const scheduledPreview = useHoverPreview(buildScheduledRows);
  const scriptAnchor = useHoverAnchor();
  const hookAnchor = useHoverAnchor();
  const scriptRows = useMemo(
    (): RunBadgeRow[] => buildScriptRunBadgeRows(activeScriptRuns),
    [activeScriptRuns],
  );
  const hookRows = useMemo(
    (): RunBadgeRow[] => buildHookRunBadgeRows(activeHookRuns),
    [activeHookRuns],
  );
  // Early access swaps rows to the focused status model, as on the classic
  // desktop rail (`WorktreeItem`).
  const statusModel = useLabsExperimentEnabled('sidebar')
    ? 'focused'
    : 'classic';

  return useMemo((): WorktreeRowOverrides | undefined => {
    // A row with no live attention yet still takes the focused model, and
    // its age, under early access.
    if (!attention) {
      return statusModel === 'focused'
        ? {
            statusModel,
            ...(recencyMs !== undefined ? { lastActivityAt: recencyMs } : {}),
          }
        : undefined;
    }
    const split = deriveWorktreeSplitRowStatus(splitFacts);
    const hasRunningScript = activeScriptRuns.length > 0;
    const hasRunningHook = activeHookRuns.length > 0;
    return {
      ...attention,
      statusModel,
      ...(statusModel === 'focused' && recencyMs !== undefined
        ? { lastActivityAt: recencyMs }
        : {}),
      ...deriveDesktopRowPr(
        pr.status,
        isMultiRepo,
        attention.runtimeState === 'done',
      ),
      ...(diffStats
        ? {
            diffStats: {
              insertions: diffStats.insertions,
              deletions: diffStats.deletions,
            },
          }
        : {}),
      ...(divergentBranch
        ? {
            branchName: divergentBranch,
            ...(customLabel ? {} : { branchLabel: divergentBranch }),
          }
        : {}),
      isCreatingPr: pr.creating,
      prCreatingSlot: pr.creating ? (
        <WorktreePrCreatingIndicator
          projectId={projectId}
          worktreeId={worktreeId}
          testId={`worktree-row-pr-creating${testIdSuffix}`}
        />
      ) : undefined,
      prMergingSlot: pr.merging ? (
        <WorktreePrMergingIndicator
          projectId={projectId}
          worktreeId={worktreeId}
          testId={`worktree-row-pr-merging${testIdSuffix}`}
        />
      ) : undefined,
      // Present ONLY when there is a real split opinion — an unconditional
      // `splitStatus: split.splitStatus` here would spread the key even when
      // its value is `undefined` (no active split lock/session), clobbering
      // the split status `projectWorktreeRuntime()` derived for the snapshot
      // from the main-owned `worktree.splitPrStatus`/`splitPrStatusMessage`.
      // Key PRESENCE is how every override communicates "I have an opinion"
      // (see `desktopRowAttentionEqual`'s neighbors below); this field must
      // follow that same rule.
      ...(split.splitStatus !== undefined
        ? {
            splitStatus: split.splitStatus,
            splitStatusMessage: split.splitStatusMessage,
          }
        : {}),
      hasIdleWatcherChats,
      hasScheduledMessages,
      scriptStatus: hasRunningScript ? 'running' : undefined,
      hookStatus: hasRunningHook ? 'running' : undefined,
      graphBuildStatus: isBuildingCodeGraph ? 'building' : undefined,
      approvalPopoverSlot: chatPreviewPopover(
        approvalPreview,
        attention.awaitingApproval,
        'Review plan',
      ),
      onApprovalIconMouseEnter: approvalPreview.onMouseEnter,
      onApprovalIconMouseLeave: approvalPreview.onHide,
      onApprovalIconFocus: approvalPreview.onFocus,
      onApprovalIconBlur: approvalPreview.onHide,
      onApprovalIconKeyDown: approvalPreview.onKeyDown,
      unreadPopoverSlot: chatPreviewPopover(
        unreadPreview,
        attention.hasUnread,
        `Unread ${CHAT_UNIT_LABEL_PLURAL}`,
      ),
      onUnreadIconMouseEnter: unreadPreview.onMouseEnter,
      onUnreadIconMouseLeave: unreadPreview.onHide,
      onUnreadIconFocus: unreadPreview.onFocus,
      onUnreadIconBlur: unreadPreview.onHide,
      onUnreadIconKeyDown: unreadPreview.onKeyDown,
      toolApprovalPopoverSlot: chatPreviewPopover(
        toolApprovalPreview,
        attention.hasPendingToolApproval,
        'Approval needed',
      ),
      onToolApprovalIconMouseEnter: toolApprovalPreview.onMouseEnter,
      onToolApprovalIconMouseLeave: toolApprovalPreview.onHide,
      onToolApprovalIconFocus: toolApprovalPreview.onFocus,
      onToolApprovalIconBlur: toolApprovalPreview.onHide,
      onToolApprovalIconKeyDown: toolApprovalPreview.onKeyDown,
      watcherPopoverSlot: chatPreviewPopover(
        watcherPreview,
        hasIdleWatcherChats,
        `${CHAT_UNIT_LABEL_PLURAL} with Watchers`,
      ),
      onWatcherIconMouseEnter: watcherPreview.onMouseEnter,
      onWatcherIconMouseLeave: watcherPreview.onHide,
      onWatcherIconFocus: watcherPreview.onFocus,
      onWatcherIconBlur: watcherPreview.onHide,
      onWatcherIconKeyDown: watcherPreview.onKeyDown,
      scheduledMessagesPopoverSlot: chatPreviewPopover(
        scheduledPreview,
        hasScheduledMessages,
        'Scheduled messages',
      ),
      onScheduledMessagesIconMouseEnter: scheduledPreview.onMouseEnter,
      onScheduledMessagesIconMouseLeave: scheduledPreview.onHide,
      onScheduledMessagesIconFocus: scheduledPreview.onFocus,
      onScheduledMessagesIconBlur: scheduledPreview.onHide,
      onScheduledMessagesIconKeyDown: scheduledPreview.onKeyDown,
      scriptPopoverSlot:
        scriptAnchor.anchorRect && hasRunningScript ? (
          <RunBadgePopover
            anchorRect={scriptAnchor.anchorRect}
            rows={scriptRows}
            heading="Scripts running"
            emptyText="No script details"
          />
        ) : undefined,
      onScriptIconMouseEnter: scriptAnchor.onMouseEnter,
      onScriptIconMouseLeave: scriptAnchor.onHide,
      onScriptIconFocus: scriptAnchor.onFocus,
      onScriptIconBlur: scriptAnchor.onHide,
      onScriptIconKeyDown: scriptAnchor.onKeyDown,
      hookPopoverSlot:
        hookAnchor.anchorRect && hasRunningHook ? (
          <RunBadgePopover
            anchorRect={hookAnchor.anchorRect}
            rows={hookRows}
            heading="Hooks running"
            emptyText="No hook details"
          />
        ) : undefined,
      onHookIconMouseEnter: hookAnchor.onMouseEnter,
      onHookIconMouseLeave: hookAnchor.onHide,
      onHookIconFocus: hookAnchor.onFocus,
      onHookIconBlur: hookAnchor.onHide,
      onHookIconKeyDown: hookAnchor.onKeyDown,
    };
  }, [
    attention,
    statusModel,
    recencyMs,
    projectId,
    worktreeId,
    pr,
    isMultiRepo,
    diffStats,
    divergentBranch,
    customLabel,
    testIdSuffix,
    splitFacts,
    hasIdleWatcherChats,
    hasScheduledMessages,
    activeScriptRuns,
    activeHookRuns,
    isBuildingCodeGraph,
    approvalPreview,
    unreadPreview,
    toolApprovalPreview,
    watcherPreview,
    scheduledPreview,
    scriptAnchor,
    hookAnchor,
    scriptRows,
    hookRows,
  ]);
}

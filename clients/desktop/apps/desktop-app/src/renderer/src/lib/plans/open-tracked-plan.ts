/**
 * The one opener behind every tracked-plan entry point (the plan list,
 * import, a chat's plan controls, pipeline runs, the command palette,
 * Overview, the Audit Trail, notifications, and App Advisor).
 *
 * It brings the plan's owning worktree on screen when asked (a global entry
 * point), picks the placement origin (the caller's chat, else the owning
 * worktree's active chat, read after navigation), and opens or reveals the
 * plan's document panel through `openPlanPanel`. Failures surface as one
 * error toast unless the caller reports them itself.
 */
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type TrackedPlanSource,
} from '@canopy/desktop-shared/types';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import type {
  ContentPanelOpenResult,
  ContentPanelOrigin,
} from '@/lib/panels/chat-panel-sync';
import { isPlanPanelScope } from '@/lib/panels/plan-panel-identity';
import {
  openPlanPanel,
  planPanelOriginForWorktree,
} from '@/lib/panels/plan-panel-open';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { useActivityStore } from '@/stores/activityStore';
import { waitForWorktreeHydration } from '@/stores/chat/hydration';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  createTrackedPlan,
  getTrackedPlan,
} from '@/client/desktop-plan-client';
import { useProjectsStore } from '@/stores/projectsStore';

/** A tracked plan and the worktree that owns it. */
export interface TrackedPlanRef {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly planId: string;
}

export interface OpenTrackedPlanOptions {
  /**
   * Bring the owning worktree on screen first (the main page with that
   * worktree selected). Defaults to `true`; callers already inside the
   * owning worktree's surface pass `false`. A shared-container recipient's
   * plans never navigate: they open only from the recipient's own surface.
   */
  readonly navigate?: boolean;
  /**
   * Where the open started, for placement. Defaults to the owning worktree's
   * active chat.
   */
  readonly origin?: ContentPanelOrigin;
  /** Show an error toast when the plan cannot be opened. Defaults to `true`. */
  readonly reportFailure?: boolean;
}

/**
 * The panel open result, or `worktree-unavailable` when the owning worktree
 * cannot be brought on screen (deleted, archived, or a recipient's view).
 */
export type OpenTrackedPlanResult =
  | ContentPanelOpenResult
  | { readonly status: 'worktree-unavailable' };

/** A chat's pending plan (plan-mode exit) that may not be tracked yet. */
export interface PendingPlanExitRef {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly source: TrackedPlanSource;
  /** The pending plan's text, used when the plan must be created. */
  readonly content: string;
}

const UNAVAILABLE: OpenTrackedPlanResult = { status: 'unavailable' };
const FAILED: OpenTrackedPlanResult = { status: 'failed' };
const WORKTREE_UNAVAILABLE: OpenTrackedPlanResult = {
  status: 'worktree-unavailable',
};

const UNAVAILABLE_MESSAGE = 'This plan is no longer available.';
const FAILED_MESSAGE = "Couldn't open the plan. Try again.";
const WORKTREE_UNAVAILABLE_MESSAGE =
  "Couldn't open the plan. Its worktree is no longer available.";

function worktreeKeyOf(ref: TrackedPlanRef): string {
  return `${ref.projectId}/${ref.worktreeId}`;
}

/** Whether the main page already shows the owning worktree. */
function isOwnerOnScreen(ref: TrackedPlanRef): boolean {
  const selected = useChatStore.getState().selectedWorktree;
  return (
    useNavigationStore.getState().activePage === 'main' &&
    selected?.projectId === ref.projectId &&
    selected.worktreeId === ref.worktreeId
  );
}

function canNavigateToOwner(ref: TrackedPlanRef): boolean {
  const { projects, hasHydratedProjects } = useProjectsStore.getState();
  return canNavigateToWorktreeFromSidebarItems(
    projects,
    ref.projectId,
    ref.worktreeId,
    hasHydratedProjects,
  );
}

/**
 * Put the owning worktree on screen: leave page-like viewers, switch to the
 * main page, load and hydrate the worktree's chats, then select it (the
 * unread-chat toast's navigation). `false` when the worktree cannot be
 * reached; a recipient's view is never navigated to.
 */
async function bringUpOwningWorktree(ref: TrackedPlanRef): Promise<boolean> {
  if (ref.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) return false;
  if (isOwnerOnScreen(ref)) {
    // A page-like viewer (archive, shared container) can cover the main page
    // while the owner stays selected; close it so the panel is visible.
    dismissPageLikeViewers();
    return true;
  }
  if (!canNavigateToOwner(ref)) return false;
  dismissPageLikeViewers();
  useNavigationStore.getState().navigate('main');
  await useChatStore
    .getState()
    .loadTabsForTarget(ref.projectId, ref.worktreeId);
  await waitForWorktreeHydration(worktreeKeyOf(ref));
  useChatStore.getState().selectWorktree(ref.projectId, ref.worktreeId);
  return true;
}

async function openWithoutReporting(
  ref: TrackedPlanRef,
  options: OpenTrackedPlanOptions,
): Promise<OpenTrackedPlanResult> {
  if (!isPlanPanelScope(ref.projectId)) return UNAVAILABLE;
  try {
    if (options.navigate !== false && !(await bringUpOwningWorktree(ref))) {
      return WORKTREE_UNAVAILABLE;
    }
    // Read the default origin after navigation: the owner's chats are only
    // loaded (and its active chat known) once it is selected.
    const origin =
      options.origin ?? planPanelOriginForWorktree(worktreeKeyOf(ref));
    return await openPlanPanel(
      { projectId: ref.projectId, worktreeId: ref.worktreeId },
      ref.planId,
      origin === undefined ? {} : { origin },
    );
  } catch {
    return FAILED;
  }
}

function failureMessage(result: OpenTrackedPlanResult): string | null {
  switch (result.status) {
    case 'unavailable':
      return UNAVAILABLE_MESSAGE;
    case 'failed':
      return FAILED_MESSAGE;
    case 'worktree-unavailable':
      return WORKTREE_UNAVAILABLE_MESSAGE;
    default:
      return null;
  }
}

function reportOpenFailure(
  ref: TrackedPlanRef,
  result: OpenTrackedPlanResult,
): void {
  const message = failureMessage(result);
  if (message === null) return;
  useGitHubStore.getState().addToast(message, 'error', undefined, {
    projectId: ref.projectId,
    worktreeId: ref.worktreeId,
  });
}

/**
 * Open a tracked plan's Plan panel in its owning worktree, or reveal it
 * where it already is. Never rejects: failures resolve as `unavailable`
 * (the plan is gone, or the scope has no plans), `failed` (it could not be
 * placed), or `worktree-unavailable`, each reported as an error toast
 * unless `reportFailure` is `false`.
 */
export async function openTrackedPlan(
  ref: TrackedPlanRef,
  options: OpenTrackedPlanOptions = {},
): Promise<OpenTrackedPlanResult> {
  const result = await openWithoutReporting(ref, options);
  if (options.reportFailure !== false) reportOpenFailure(ref, result);
  return result;
}

/**
 * Open a chat's pending plan in its Plan panel beside that chat. A pending
 * plan can carry a `planId` that was never tracked (seeded tab state), so a
 * missing plan is created from the pending text under that same id (keeping
 * the chat's reference valid and repeat opens idempotent) before opening.
 * Rejects when reading or creating the plan fails; the caller reports it.
 */
export async function openPendingPlanExit(
  exit: PendingPlanExitRef,
  planId: string,
): Promise<OpenTrackedPlanResult> {
  const { projectId, worktreeId } = exit;
  const plan =
    (await getTrackedPlan({ projectId, worktreeId, planId })) ??
    (await createTrackedPlan({
      projectId,
      worktreeId,
      id: planId,
      source: exit.source,
      content: exit.content,
      reviewStatus: 'pending',
      chatId: exit.chatId,
    }));
  useActivityStore.getState().commitTrackedPlanUpdate(plan);
  return openTrackedPlan(
    { projectId, worktreeId, planId: plan.id },
    { navigate: false, origin: { chatTabId: exit.chatId } },
  );
}

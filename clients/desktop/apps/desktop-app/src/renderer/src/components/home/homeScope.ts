import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/shallow';
import type { CoreCoworkProject } from '@canopy/app-state/core-cowork';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  defaultCoworkWorkspaceIdForContext,
  isDefaultCoworkWorkspaceId,
  type SidebarItem,
  type WorkspaceContext,
} from '@canopy/desktop-shared/types';
import { isWorkspaceInContext } from '@/lib/automationContextScope';
import {
  getSidebarScopingContext,
  useSidebarScopingContext,
} from '@/components/sidebar/useSidebarScopingContext';
import { useProjectsStore } from '@/stores/projectsStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useCanopyDesktopCloudChatsEnabled } from '@/hooks/useCanopyDesktopCloudChatsEnabled';
import {
  cloudCoworkStore,
  cloudProjectsForContext,
} from '@/cloud-chats/useCloudCoworkSidebar';
import { isWebCoreScope, webCoreScopeId } from '@/lib/chat-authority';
import {
  linkedPersonalWorkspaceIdsForContext,
  useLinkedPersonalWorkspacesStore,
} from '@/stores/linkedPersonalWorkspacesStore';
import { hasWorkspaceChoice } from './homeGating';

/**
 * A cloud cowork project Home can start a cloud chat in (CAN-6757). Its id is
 * the project's web core scope id, which no local IPC resolves.
 */
export interface HomeCloudProject {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
}

/**
 * The cloud projects Home reads: only while desktop cloud chats are on and the
 * web core is online, as the sidebar lists them.
 */
export interface HomeCloudSource {
  readonly online: boolean;
  readonly projects: readonly CoreCoworkProject[];
}

const NO_CLOUD: HomeCloudSource = { online: false, projects: [] };

/** Whether Home's selection is a cloud project rather than a local one. */
export function isHomeCloudTarget(workspaceId: string | null): boolean {
  return workspaceId !== null && isWebCoreScope(workspaceId);
}

/**
 * The Home composer's view of the Personal/organization context: the projects
 * it may offer and target, by the sidebar's rule (CAN-3448).
 */
export interface HomeScope {
  /** The context's catch-all ("just a chat"): its Chats workspace. */
  defaultCoworkId: string;
  /** Local projects in the selected context, in store order. */
  projects: SidebarItem[];
  /**
   * Cloud cowork projects in the selected context, by the sidebar's rule,
   * while cloud chats are online; empty otherwise (CAN-6757).
   */
  cloudProjects: readonly HomeCloudProject[];
  isInScope(workspaceId: string): boolean;
  /**
   * True only for a selection known to belong elsewhere: a loaded project from
   * another context, or another context's Chats. An id the store has not
   * loaded yet (a project just added) is not judged.
   */
  isOutOfScope(workspaceId: string): boolean;
  /**
   * Where Home seeds a missing selection: the first workspace in scope in
   * store order, which may be the context's Chats, else the context's Chats.
   * `null` only when unscoped with no projects loaded. A selection left in
   * another context lands by `resolveHomeContextRebind` instead.
   */
  fallbackWorkspaceId: string | null;
  /** Nothing to choose but the context's Chats (no project in scope). */
  onlyDefaultChats: boolean;
}

/**
 * An `undefined` context (org projects off, or not hydrated yet) scopes
 * nothing. The context's own Chats workspace is always in scope, even before
 * an organization's has been provisioned: sending there creates it.
 */
export function resolveHomeScope(
  context: WorkspaceContext | undefined,
  projects: SidebarItem[],
  linkedPersonalIds: readonly string[],
  cloud: HomeCloudSource = NO_CLOUD,
): HomeScope {
  const defaultCoworkId = defaultCoworkWorkspaceIdForContext(context);
  const linked = new Set(linkedPersonalIds);
  const scoped =
    context === undefined
      ? projects
      : projects.filter((project) =>
          isWorkspaceInContext(project, context, linked),
        );
  // Only a task-bearing (cowork) cloud project can take a new chat.
  const cloudProjects: HomeCloudProject[] = cloud.online
    ? cloudProjectsForContext(
        cloud.projects.filter((project) => project.kind === 'cowork'),
        {},
        context,
      ).map((project) => ({
        id: webCoreScopeId(project.workspaceId),
        name: project.name,
        ...(project.color === undefined ? {} : { color: project.color }),
      }))
    : [];
  const scopedIds = new Set([
    ...scoped.map((project) => project.id),
    ...cloudProjects.map((project) => project.id),
  ]);
  // A cloud selection leaves scope only when the cloud lists it in another
  // context. Offline, or gone from the listing, it is kept with its draft,
  // never swapped for a local project, and its send says why it can't go.
  const listedCloudIds = new Set(
    cloud.online
      ? cloud.projects.map((project) => webCoreScopeId(project.workspaceId))
      : [],
  );
  const knownIds = new Set([
    ...projects.map((project) => project.id),
    ...listedCloudIds,
  ]);
  const isInScope = (workspaceId: string): boolean =>
    isWebCoreScope(workspaceId)
      ? scopedIds.has(workspaceId) || !listedCloudIds.has(workspaceId)
      : context === undefined ||
        workspaceId === defaultCoworkId ||
        scopedIds.has(workspaceId);
  return {
    defaultCoworkId,
    projects: scoped,
    cloudProjects,
    isInScope,
    isOutOfScope: (workspaceId): boolean =>
      !isInScope(workspaceId) &&
      (knownIds.has(workspaceId) || isDefaultCoworkWorkspaceId(workspaceId)),
    fallbackWorkspaceId:
      scoped[0]?.id ?? (context === undefined ? null : defaultCoworkId),
    onlyDefaultChats:
      cloudProjects.length === 0 &&
      scoped.every((project) => isDefaultCoworkWorkspaceId(project.id)),
  };
}

/** Where a context change lands Home's composer. */
export interface HomeContextRebind {
  workspaceId: string | null;
}

/**
 * Where Home's composer lands when its target is not in the selected context:
 * the first project the picker lists, in sidebar order, else the context's
 * Chats. A context's Chats is never that first project, wherever it sorts: the
 * picker leaves it unlisted, so landing there by order leaves the chip on
 * "Choose project".
 */
export function resolveHomeContextRebind(
  scope: Pick<HomeScope, 'projects' | 'fallbackWorkspaceId'>,
): HomeContextRebind {
  const project = scope.projects
    .filter((candidate) => !isDefaultCoworkWorkspaceId(candidate.id))
    .sort((left, right) => left.order - right.order)[0];
  if (project) {
    return {
      workspaceId: project.id,
    };
  }
  // No listed project leaves only the context's Chats in scope, provisioned
  // or not, and that is what the scope falls back to.
  return scope.fallbackWorkspaceId !== null
    ? {
        workspaceId: scope.fallbackWorkspaceId,
      }
    : {
        workspaceId: null,
      };
}

/** What the context-change effect knows when it decides whether to rebind. */
export interface HomeContextRebindInput {
  /** The context this surface last saw; `null` on its first scoped run. */
  previousContextKey: string | null;
  contextKey: string;
  workspaceId: string | null;
  /** The selection is in the selected context. */
  stillVisible: boolean;
  /** Personal to an organization, with a Personal project still selected. */
  enteredOrganizationWithPersonalSelection: boolean;
  hasDraft: boolean;
  draftBelongsToOtherContext: boolean;
}

/**
 * Whether Home must move its composer into the selected context.
 * While the context is unchanged (or this surface has not seen one yet), an
 * empty selection is the seed's to fill: projects can load before the first
 * seed lands, and nothing was selected, so there is no selection to rebind.
 * A draft typed meanwhile stays: the editor accepts input before any project
 * loads, and only a draft owned by another context is cleared.
 */
export function shouldRebindHomeToContext(
  input: HomeContextRebindInput,
): boolean {
  const contextUnchanged =
    input.previousContextKey === null ||
    input.previousContextKey === input.contextKey;
  if (
    contextUnchanged &&
    (input.stillVisible || input.workspaceId === null) &&
    !input.draftBelongsToOtherContext
  )
    return false;
  return (
    input.draftBelongsToOtherContext ||
    !input.stillVisible ||
    input.enteredOrganizationWithPersonalSelection
  );
}

/**
 * Whether Home shows its project picker. Shared by the picker and the context
 * row that hosts it, so the row is never left rendering an empty band. It
 * shows when there is a choice to make, and when the context's Chats is the
 * only target, so the chip says where the chat will go and offers
 * "New project". It also shows while Home's notice about falling back from a
 * project that failed to load is visible (CAN-7326), because that notice's
 * Change project opens this picker.
 */
export function shouldShowHomeWorkspacePicker(
  scope: Pick<HomeScope, 'projects' | 'cloudProjects' | 'onlyDefaultChats'>,
  workspaceId: string | null,
  seedFallbackActive = false,
): boolean {
  return (
    seedFallbackActive ||
    scope.cloudProjects.length > 0 ||
    hasWorkspaceChoice(scope.projects, workspaceId) ||
    scope.onlyDefaultChats
  );
}

/** The cloud projects Home may offer, from the window's cloud cowork store. */
function useHomeCloudSource(): HomeCloudSource {
  const enabled = useCanopyDesktopCloudChatsEnabled();
  const { status, projects } = useStore(
    cloudCoworkStore,
    useShallow((state) => ({
      status: state.status,
      projects: state.projects,
    })),
  );
  return useMemo(
    () =>
      enabled && status === 'online' ? { online: true, projects } : NO_CLOUD,
    [enabled, status, projects],
  );
}

/** The same cloud read outside React. */
export function getHomeCloudSource(): HomeCloudSource {
  const enabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key);
  const { status, projects } = cloudCoworkStore.getState();
  return enabled && status === 'online' ? { online: true, projects } : NO_CLOUD;
}

export function useHomeScope(): HomeScope {
  const context = useSidebarScopingContext();
  const projects = useProjectsStore((state) => state.projects);
  const linkedIds = useLinkedPersonalWorkspacesStore((state) =>
    linkedPersonalWorkspaceIdsForContext(state, context),
  );
  const cloud = useHomeCloudSource();
  return useMemo(
    () => resolveHomeScope(context, projects, linkedIds, cloud),
    [context, projects, linkedIds, cloud],
  );
}

/**
 * Re-target Home when its selection is left in another context without the
 * context-switch effect having moved it. `rebindSelection` receives the same
 * target a context switch uses. `readCurrentWorkspaceId` reads the live
 * selection: an effect that ran earlier in the same commit may already have
 * moved it into scope, and the rendered `workspaceId` would then be stale.
 */
export function useKeepHomeSelectionInScope(
  workspaceId: string | null,
  rebindSelection: (rebind: HomeContextRebind) => void,
  readCurrentWorkspaceId?: () => string | null,
): void {
  const scope = useHomeScope();
  useEffect(() => {
    const currentWorkspaceId = readCurrentWorkspaceId
      ? readCurrentWorkspaceId()
      : workspaceId;
    if (currentWorkspaceId === null || !scope.isOutOfScope(currentWorkspaceId))
      return;
    const rebind = resolveHomeContextRebind(scope);
    if (rebind.workspaceId !== null) {
      rebindSelection(rebind);
    }
  }, [workspaceId, scope, rebindSelection, readCurrentWorkspaceId]);
}

/** The same scope read outside React, for async seeding. */
export function getHomeScope(): HomeScope {
  const context = getSidebarScopingContext();
  return resolveHomeScope(
    context,
    useProjectsStore.getState().projects,
    linkedPersonalWorkspaceIdsForContext(
      useLinkedPersonalWorkspacesStore.getState(),
      context,
    ),
    getHomeCloudSource(),
  );
}

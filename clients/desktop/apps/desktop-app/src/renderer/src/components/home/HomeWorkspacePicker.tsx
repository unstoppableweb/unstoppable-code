import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { isDefaultCoworkWorkspaceId } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import {
  isComposerHomeScope,
  OPEN_WORKSPACE_PICKER_EVENT,
} from '@/lib/composerShortcutRequests';
import { WorkspaceDropdown } from '../shared/WorkspaceDropdown';
import {
  getHomeScope,
  shouldShowHomeWorkspacePicker,
  useHomeScope,
} from './homeScope';
import {
  homeSendTargetSessionKey,
  waitForHomeDefaultChats,
} from './homeSendTarget';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useCanopyOrgProjectsEnabled } from '@/hooks/useCanopyOrgProjectsEnabled';
import { useHomeLinkProjectPreview } from './homeLinkProjectPreview';

/**
 * Home composer's project picker. Unlike the old Create Task modal's
 * dropdown, this surfaces every sidebar workspace — code and cowork alike,
 * with no `isEligibleWorkspace`-style filter — plus a trailing "Add
 * workspace…" row that reuses the existing `openAddWorkspaceModal`
 * navigation-store flag so Home doesn't need a parallel request/consume
 * pair.
 *
 * Only projects in the selected Personal/organization context are offered,
 * by the sidebar's rule (`homeScope`).
 *
 * The one exception is the default cowork workspace. It is where a chat with
 * no project context lands, and the trigger still says so, but the sidebar
 * renders it as the top-level Chats section rather than a project — so
 * listing it as a pickable project made it look like somewhere you file a
 * chat, and its stale sidebar `order` dropped it in the middle of the real
 * projects for no visible reason (CAN-2363 follow-up).
 */
interface HomeWorkspacePickerProps {
  commandOpenSignal?: number;
  /** True only for the standalone Home page that owns global shortcuts. */
  shortcutEnabled: boolean;
  /** Returns the caret to the Home composer once the picker closes. */
  onRestoreFocus?: () => void;
  /**
   * Keeps the chip visible while Home's notice about falling back from a
   * project that failed to load shows, since its Change project opens this
   * picker (CAN-7326).
   */
  seedFallbackActive?: boolean;
}

export function HomeWorkspacePicker({
  commandOpenSignal = 0,
  shortcutEnabled,
  onRestoreFocus,
  seedFallbackActive = false,
}: HomeWorkspacePickerProps): JSX.Element | null {
  const allProjects = useProjectsStore((s) => s.projects);
  const scope = useHomeScope();
  const contextHydrated = useWorkspaceContextStore((state) => state.hydrated);
  const orgProjectsEnabled = useCanopyOrgProjectsEnabled();
  const contextReady = !orgProjectsEnabled || contextHydrated;
  const { projects, defaultCoworkId } = scope;
  const { workspaceId, mode, selectWorkspace } = useHomeComposerStore(
    useShallow((s) => ({
      workspaceId: s.workspaceId,
      mode: s.mode,
      selectWorkspace: s.selectWorkspace,
    })),
  );
  // A pasted link's proposed project, shown in place of the selection.
  const linkPreview = useHomeLinkProjectPreview();
  const openAddWorkspaceModal = useNavigationStore(
    (s) => s.openAddWorkspaceModal,
  );
  // Every catch-all (Personal's and each organization's) stays unlisted; a
  // memo keeps the dropdown's own memos from invalidating per render.
  const unlistedWorkspaceIds = useMemo(
    (): readonly string[] =>
      allProjects
        .filter((project) => isDefaultCoworkWorkspaceId(project.id))
        .map((project) => project.id),
    [allProjects],
  );

  const sortedWorkspaces = useMemo(
    () => [...projects].sort((a, b) => a.order - b.order),
    [projects],
  );

  // CAN-7038: "Chat without a project" picks the context's Chats. Personal's
  // is set up first when missing, and only a registered one is selected, so
  // the choice never lands on an id that would dispatch as a code project.
  // An organization's uses its existing ensure-and-reload path. A late
  // result is dropped once the context or the selection has moved on.
  const [noProjectPending, setNoProjectPending] = useState(false);
  const noProjectRequest = useRef(0);
  const noProjectInProgress = useRef(false);
  const session = homeSendTargetSessionKey();
  useEffect(() => {
    noProjectInProgress.current = false;
    setNoProjectPending(false);
    return (): void => {
      noProjectRequest.current += 1;
      noProjectInProgress.current = false;
    };
  }, [session]);

  // ⌥W opens the picker (ECW-7984 follow-up). The standalone and embedded
  // Home surfaces can coexist, so only the standalone page subscribes.
  const [openSignal, setOpenSignal] = useState(0);
  useEffect(() => {
    if (!shortcutEnabled) {
      return undefined;
    }

    function handleOpenRequest(event: Event): void {
      // `CustomEvent.detail` is `any`; the scope guard below narrows it.
      const detail: unknown =
        event instanceof CustomEvent ? event.detail : null;
      if (mode !== 'chat' || !isComposerHomeScope(detail)) {
        return;
      }
      event.preventDefault();
      setOpenSignal((signal) => signal + 1);
    }

    document.addEventListener(OPEN_WORKSPACE_PICKER_EVENT, handleOpenRequest);
    return (): void => {
      document.removeEventListener(
        OPEN_WORKSPACE_PICKER_EVENT,
        handleOpenRequest,
      );
    };
  }, [mode, shortcutEnabled]);

  if (
    !shouldShowHomeWorkspacePicker(scope, workspaceId, seedFallbackActive) &&
    !linkPreview
  ) {
    return null;
  }

  function selectHomeWorkspace(id: string): void {
    const current = useHomeComposerStore.getState();
    const target = current.linkTarget;
    if (
      current.workspaceId === id &&
      (target.status === 'idle' || target.status === 'inactive')
    )
      return;
    if (
      target.status !== 'idle' &&
      target.status !== 'inactive' &&
      current.workspaceId !== id &&
      current.fileReferences.some(
        (reference) =>
          reference.kind === undefined ||
          reference.kind === 'file' ||
          reference.kind === 'folder' ||
          reference.kind === 'prompt',
      )
    ) {
      current.setSendError(
        current.fileReferences.some((reference) => reference.kind === 'prompt')
          ? 'Remove the saved prompt mentions before switching projects, or dismiss the link.'
          : 'Remove the file mentions before switching projects, or dismiss the link.',
      );
      return;
    }
    selectWorkspace(id, {
      explicit: true,
      ...(target.status !== 'idle' && target.status !== 'inactive'
        ? { preserveDraft: true }
        : {}),
    });
  }

  function chooseNoProject(): void {
    if (noProjectInProgress.current || !contextReady) return;
    const chatsId = defaultCoworkId;
    noProjectInProgress.current = true;
    const request = ++noProjectRequest.current;
    const selectionAtStart =
      useHomeComposerStore.getState().workspaceSelectionGeneration;
    setNoProjectPending(true);
    void waitForHomeDefaultChats(chatsId).then((outcome) => {
      if (request !== noProjectRequest.current) return;
      noProjectInProgress.current = false;
      setNoProjectPending(false);
      if (
        homeSendTargetSessionKey() !== session ||
        getHomeScope().defaultCoworkId !== chatsId ||
        useHomeComposerStore.getState().workspaceSelectionGeneration !==
          selectionAtStart
      ) {
        return;
      }
      if (outcome.status === 'ready') {
        selectHomeWorkspace(chatsId);
        return;
      }
      // The draft and the current selection stay as they were.
      useHomeComposerStore
        .getState()
        .setSendError('Couldn’t set up Chats. Try again.');
    });
  }

  // Offered while no code project is chosen: nothing selected, or the
  // context's Chats. With a project chosen, its clear control does the same.
  const noProjectOffered =
    workspaceId === null || workspaceId === defaultCoworkId;

  return (
    <div data-testid="home-workspace-picker">
      <WorkspaceDropdown
        workspaces={sortedWorkspaces}
        // The context's cloud cowork projects, after the local ones as the
        // sidebar lists them; picking one starts a cloud chat (CAN-6757).
        cloudWorkspaces={scope.cloudProjects}
        unlistedWorkspaceIds={unlistedWorkspaceIds}
        // The default stays named Chats even beside discovered projects.
        selectedWorkspaceId={
          linkPreview?.kind === 'existing-project'
            ? linkPreview.workspaceId
            : linkPreview?.kind === 'create-project' || workspaceId === null
              ? ''
              : workspaceId
        }
        allowUnset
        pendingWorkspace={
          linkPreview?.kind === 'create-project'
            ? { title: `New project for ${linkPreview.repositoryLabel}` }
            : undefined
        }
        placeholder="Choose project"
        onSelect={selectHomeWorkspace}
        {...(noProjectOffered
          ? {
              noProjectOption: {
                label: 'Chat without a project',
                selected: workspaceId === defaultCoworkId && !linkPreview,
                pending: noProjectPending || !contextReady,
                onSelect: chooseNoProject,
              },
            }
          : {})}
        onClear={
          // Clearing the project means "this is just a chat" — which is the
          // default cowork workspace, not an absent one. It stays a real
          // project with its fixed id; only the presentation differs.
          workspaceId === defaultCoworkId || linkPreview
            ? undefined
            : chooseNoProject
        }
        onAddWorkspace={openAddWorkspaceModal}
        testIdPrefix="home-workspace"
        capsule
        openSignal={openSignal + commandOpenSignal}
        onRestoreFocus={onRestoreFocus}
      />
    </div>
  );
}

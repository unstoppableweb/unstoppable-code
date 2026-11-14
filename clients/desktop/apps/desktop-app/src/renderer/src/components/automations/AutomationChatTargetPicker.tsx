// CAN-2937 — destination picker for the "Existing chat" Run-in mode.
//
// The picker selects an existing worktree / Work Entry and then either one of
// its chats or "New chat" (the default, `chatId: ''`). A specific chat maps to
// a `worktree_session_prompt` that continues that persisted chat, keyed
// `(workspaceId, worktreeId, chatId)`; "New chat" maps to the new-chat action
// of the workspace kind that reuses the container (`existingWorktreeId` /
// `workEntryId`). Cowork workspaces and App Advisor reuse the same triple: the
// Work Entry id occupies the `worktreeId` slot (see CLAUDE.md -> "Cowork
// workspaces"), so every kind hydrates its chat list through the one
// `chat.loadTabs` read and only differs in how the middle level is enumerated
// (`projectsStore` worktrees vs `workEntries.list`).
//
// The picker probes availability the way `resolveAvailableAutomationRunDestination`
// does rather than trusting the saved ids: a target whose worktree/entry or
// chat has since been deleted or archived renders an explanation and blocks
// save, so a stale automation is re-pointed instead of silently substituted.
import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  getExecutionHarnessForModel,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL, WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import { useProjectsStore } from '@/stores/projectsStore';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import { getChatTabLabel } from '@/lib/chatTabLabel';
import {
  Stack,
  Button,
  DelayedLoadingPlaceholder,
  FormField,
  Skeleton,
} from '@canopy/ui-shared/components';
import { SearchableSelect } from '../shared/SearchableSelect';
import {
  openAutomationRunDestination,
  type AutomationRunDestination,
} from './resolveAutomationRunDestination';
import type { WorktreeSessionTarget } from './worktreeSessionPrompt';
import { ErrorBanner } from '@canopy/ui-shared/components';

export const AUTOMATION_CHAT_TARGET_UNAVAILABLE_ERROR =
  'That chat is no longer available. Pick another destination.';

export const AUTOMATION_CHAT_TARGET_INCOMPLETE_ERROR =
  'Pick a destination for this automation.';

/** Label of the default chat option that starts a new chat each run. */
export const AUTOMATION_NEW_CHAT_TARGET_LABEL = `New ${CHAT_UNIT_LABEL.toLowerCase()}`;

/**
 * Why the current selection cannot be saved — `incomplete` (nothing picked
 * yet) and `unavailable` (picked, but the target is gone) both block Save but
 * read very differently to a user, so they stay distinct signals rather than
 * one boolean.
 */
export type AutomationChatTargetStatus = 'ready' | 'incomplete' | 'unavailable';

interface ContainerOption {
  id: string;
  label: string;
}

interface ChatOption {
  id: string;
  label: string;
}

export interface AutomationChatTargetPickerProps {
  /**
   * Selected workspace, or `APP_ADVISOR_PROJECT_ID` for App Advisor Work
   * Entries; `''` while no project is chosen yet.
   */
  workspaceId: string;
  /** `chatId: ''` selects "New chat" in the chosen worktree / Work Entry. */
  value: WorktreeSessionTarget | undefined;
  ownerDocument?: Document;
  onChange: (next: WorktreeSessionTarget | undefined) => void;
  /** Reports whether the current selection resolves to a live, writable chat. */
  onStatusChange?: (status: AutomationChatTargetStatus) => void;
}

/**
 * Enumerate the selectable chats of one worktree / Work Entry. Read-only
 * (archived) and Cursor-backed tabs are excluded because automation dispatch
 * fails closed on both, so offering either would author a guaranteed-failing
 * automation.
 */
async function loadChatOptions(
  workspaceId: string,
  containerId: string,
): Promise<ChatOption[]> {
  const loaded = await window.api.chat.loadTabs({
    projectId: workspaceId,
    worktreeId: containerId,
  });
  return loaded.tabs
    .filter(
      (tab: PersistedChatTab) =>
        (tab.kind ?? 'chat') === 'chat' &&
        tab.readOnly !== true &&
        tab.providerType !== 'cursor' &&
        tab.executionHarness !== 'cursor' &&
        (!tab.model || getExecutionHarnessForModel(tab.model) !== 'cursor'),
    )
    .map((tab: PersistedChatTab) => ({
      id: tab.id,
      label: getChatTabLabel(tab),
    }));
}

export function AutomationChatTargetPicker({
  workspaceId,
  value,
  ownerDocument,
  onChange,
  onStatusChange,
}: AutomationChatTargetPickerProps): JSX.Element {
  const projects = useProjectsStore((state) => state.projects);
  const isAppAdvisor = workspaceId === APP_ADVISOR_PROJECT_ID;
  const project = projects.find((candidate) => candidate.id === workspaceId);
  const isCowork = project?.type === 'cowork';
  const workspaceName = project ? getWorkspaceDisplayName(project) : undefined;
  const containerLabel =
    isCowork || isAppAdvisor ? 'Work Entry' : WORKTREE_UNIT_LABEL;
  // Work Entries are listed over IPC for both Cowork projects and App Advisor;
  // worktrees come from the projects store.
  const workEntryProjectId = isAppAdvisor
    ? APP_ADVISOR_PROJECT_ID
    : project?.type === 'cowork'
      ? project.id
      : undefined;

  const [containers, setContainers] = useState<ContainerOption[] | null>(null);
  const [chats, setChats] = useState<ChatOption[] | null>(null);
  const [chatsError, setChatsError] = useState(false);
  const [openChatError, setOpenChatError] = useState<string | null>(null);

  const selectedContainerId =
    value && value.workspaceId === workspaceId ? value.worktreeId : '';
  const selectedChatId =
    value && value.workspaceId === workspaceId ? value.chatId : '';

  // Level 1: worktrees come straight from the projects store; Work Entries
  // need the IPC read because the store does not mirror them.
  useEffect(() => {
    if (workEntryProjectId === undefined) {
      if (!project || project.type === 'cowork') {
        setContainers(null);
        return undefined;
      }
      setContainers(
        project.worktrees.map((worktree) => ({
          id: worktree.id,
          label: getWorktreeBranchDisplayName({
            rawBranch: worktree.branchName,
            worktreeId: worktree.id,
            hasMultipleBranches: false,
            getBranchDisplayName: (branchName) => branchName,
          }),
        })),
      );
      return undefined;
    }
    let cancelled = false;
    setContainers(null);
    void (async (): Promise<void> => {
      try {
        const listed = await window.api.workEntries.list({
          projectId: workEntryProjectId,
        });
        if (cancelled) return;
        setContainers(
          listed.entries.map((entry) => ({
            id: entry.id,
            label: entry.title || entry.id,
          })),
        );
      } catch {
        if (!cancelled) setContainers([]);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [project, workEntryProjectId]);

  // Level 2: the chats of the selected worktree / Work Entry.
  useEffect(() => {
    if (!workspaceId || !selectedContainerId) {
      setChats(null);
      setChatsError(false);
      return undefined;
    }
    let cancelled = false;
    setChats(null);
    setChatsError(false);
    void (async (): Promise<void> => {
      try {
        const options = await loadChatOptions(workspaceId, selectedContainerId);
        if (cancelled) return;
        setChats(options);
      } catch {
        if (cancelled) return;
        setChats([]);
        setChatsError(true);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [selectedContainerId, workspaceId]);

  const containerMissing =
    containers !== null &&
    selectedContainerId !== '' &&
    !containers.some((option) => option.id === selectedContainerId);
  const chatMissing =
    selectedChatId !== '' &&
    (chatsError ||
      (chats !== null &&
        !chats.some((option) => option.id === selectedChatId)));
  const unavailable = containerMissing || chatMissing;
  // "New chat" (`chatId: ''`) is a complete selection: only the container must
  // exist, so the chat list need not finish loading.
  const isNewChat = selectedChatId === '';
  const complete = selectedContainerId !== '';
  const probePending =
    complete &&
    (containers === null ||
      (!isNewChat && !containerMissing && chats === null));

  const status: AutomationChatTargetStatus = unavailable
    ? 'unavailable'
    : complete && !probePending
      ? 'ready'
      : 'incomplete';

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, selectedChatId, selectedContainerId, status]);

  const handleContainerChange = useCallback(
    (nextId: string): void => {
      if (!nextId) {
        onChange(undefined);
        return;
      }
      const label = containers?.find((option) => option.id === nextId)?.label;
      // Changing the container invalidates the chat: chat ids are scoped to
      // the worktree / Work Entry that owns the tab file.
      onChange({
        workspaceId,
        worktreeId: nextId,
        chatId: '',
        ...(workspaceName ? { workspaceName } : {}),
        ...(label ? { worktreeName: label } : {}),
      });
    },
    [containers, onChange, workspaceId, workspaceName],
  );

  const handleChatChange = useCallback(
    (nextId: string): void => {
      if (!selectedContainerId) return;
      const containerName = containers?.find(
        (option) => option.id === selectedContainerId,
      )?.label;
      const chatTitle = nextId
        ? chats?.find((option) => option.id === nextId)?.label
        : undefined;
      onChange({
        workspaceId,
        worktreeId: selectedContainerId,
        chatId: nextId,
        ...(workspaceName ? { workspaceName } : {}),
        ...(containerName ? { worktreeName: containerName } : {}),
        ...(chatTitle ? { chatTitle } : {}),
      });
    },
    [
      chats,
      containers,
      onChange,
      selectedContainerId,
      workspaceId,
      workspaceName,
    ],
  );

  return (
    <Stack gap="inline" data-testid="automations-form-chat-target">
      <FormField label={containerLabel}>
        {(control) => {
          const select = (
            <SearchableSelect
              id={control.id}
              value={selectedContainerId}
              ownerDocument={ownerDocument}
              options={(containers ?? []).map((option) => ({
                id: option.id,
                label: option.label,
              }))}
              selectedFallback={
                selectedContainerId
                  ? {
                      id: selectedContainerId,
                      label: value?.worktreeName || selectedContainerId,
                    }
                  : undefined
              }
              onChange={handleContainerChange}
              placeholder={
                containers?.length === 0
                  ? `No ${containerLabel.toLowerCase()}s available`
                  : `Select a ${containerLabel.toLowerCase()}`
              }
              searchPlaceholder={`Search ${containerLabel.toLowerCase()}s`}
              emptyListMessage="No matches"
              disabled={!project && !isAppAdvisor}
              testId="automations-form-chat-target-worktree"
            />
          );
          // The choices are on their way and nothing is chosen yet: the
          // field itself is measured in place until they arrive.
          return containers === null && !selectedContainerId ? (
            <DelayedLoadingPlaceholder>
              <Skeleton
                loading
                label={`Loading ${containerLabel.toLowerCase()}s`}
                testId="automations-form-chat-target-worktree-loading"
              >
                {select}
              </Skeleton>
            </DelayedLoadingPlaceholder>
          ) : (
            select
          );
        }}
      </FormField>
      <FormField label={CHAT_UNIT_LABEL}>
        {(control) => (
          <SearchableSelect
            id={control.id}
            value={selectedChatId}
            ownerDocument={ownerDocument}
            options={(chats ?? []).map((option) => ({
              id: option.id,
              label: option.label,
            }))}
            selectedFallback={
              selectedChatId
                ? {
                    id: selectedChatId,
                    label: value?.chatTitle || selectedChatId,
                  }
                : undefined
            }
            onChange={handleChatChange}
            emptyOption={
              selectedContainerId
                ? {
                    id: '',
                    label: AUTOMATION_NEW_CHAT_TARGET_LABEL,
                    subtitle: `Start a new ${CHAT_UNIT_LABEL.toLowerCase()} each run`,
                  }
                : undefined
            }
            placeholder={
              !selectedContainerId
                ? `Select a ${containerLabel.toLowerCase()} first`
                : AUTOMATION_NEW_CHAT_TARGET_LABEL
            }
            searchPlaceholder={`Search ${CHAT_UNIT_LABEL.toLowerCase()}s`}
            emptyListMessage="No matches"
            disabled={!selectedContainerId}
            testId="automations-form-chat-target-chat"
          />
        )}
      </FormField>
      {complete && !isNewChat && !unavailable ? (
        <div className="flex flex-col text-xs gap-1">
          <Button
            className="self-start"
            variant="link"
            onClick={(): void => {
              setOpenChatError(null);
              // Cowork and App Advisor destinations live on their own surfaces,
              // not a worktree chat pane, so the open path is chosen by
              // workspace kind the same way the run-destination affordances
              // resolve it.
              const destination: AutomationRunDestination = isAppAdvisor
                ? { kind: 'app-advisor-chat', chatId: selectedChatId }
                : isCowork
                  ? {
                      kind: 'cowork-chat',
                      workspaceId,
                      chatId: selectedChatId,
                    }
                  : {
                      kind: 'worktree-chat',
                      projectId: workspaceId,
                      worktreeId: selectedContainerId,
                      chatId: selectedChatId,
                    };
              void openAutomationRunDestination(destination).then((result) => {
                if (!result.ok) setOpenChatError(result.error);
              });
            }}
            data-testid="automations-form-open-chat"
          >
            Open {CHAT_UNIT_LABEL.toLowerCase()}
          </Button>
          <ErrorBanner
            errorSource="automation-chat-target-picker-open"
            className=""
            error={openChatError}
          />
        </div>
      ) : null}
      {unavailable ? (
        <ErrorBanner
          errorSource="automations-form-chat-target-unavailable"
          displayErrorCode="external.state_changed"
          className=""
          error={AUTOMATION_CHAT_TARGET_UNAVAILABLE_ERROR}
          testId="automations-form-chat-target-unavailable"
        />
      ) : complete && isNewChat ? (
        <p className="text-2xs fg-secondary">
          Each run starts a new {CHAT_UNIT_LABEL.toLowerCase()} in this{' '}
          {containerLabel.toLowerCase()}.
        </p>
      ) : (
        <p className="text-2xs fg-secondary">
          Runs use the chosen {CHAT_UNIT_LABEL.toLowerCase()}&apos;s own model
          and plugins.
        </p>
      )}
    </Stack>
  );
}

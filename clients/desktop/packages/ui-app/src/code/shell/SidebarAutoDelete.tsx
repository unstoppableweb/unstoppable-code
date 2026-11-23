'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import {
  useOptionalCanopyClient,
  useWorkEntryAutoDeleteStore,
  type AutoDeleteTarget,
  type WorkEntryAutoDeleteState,
} from '@canopy/app-state';
import type { CanopyClient } from '@canopy/app-core';
import {
  ConfirmDialog,
  Notice,
  type WorktreeMenuItem,
} from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { WorkEntryAutoDeleteRowState } from '@canopy/protocol';

interface SidebarAutoDeleteContextValue {
  readonly state: WorkEntryAutoDeleteState;
  readonly client: CanopyClient;
}
const SidebarAutoDeleteContext =
  createContext<SidebarAutoDeleteContextValue | null>(null);

export interface SidebarAutoDeleteRowBinding {
  readonly autoDelete?: WorkEntryAutoDeleteRowState;
  readonly autoDeleteReadOnly: boolean;
  readonly onAutoDeleteActivate?: () => void;
  readonly onAutoDeleteDisarm?: () => void;
}

/** Both shared and host-owned Work Entry adapters use this same intent binding. */
export function useSidebarAutoDelete(
  target: AutoDeleteTarget,
): SidebarAutoDeleteRowBinding {
  const context = useContext(SidebarAutoDeleteContext);
  const autoDelete =
    context?.state.workspaces[target.workspaceId]?.[target.targetId];
  const capabilities =
    context?.client.capabilitiesFor?.(target.targetId) ??
    context?.client.capabilities;
  const manage =
    capabilities?.workEntryAutoDelete === 'manage' &&
    context?.client.disarmWorkEntryAutoDelete !== undefined &&
    context?.client.resolveWorkEntryAutoDeleteBranch !== undefined;
  return {
    autoDelete,
    autoDeleteReadOnly: !manage,
    onAutoDeleteActivate:
      manage && context ? () => context.state.activate(target) : undefined,
    onAutoDeleteDisarm:
      manage && context
        ? () => {
            void context.state.disarm(target);
          }
        : undefined,
  };
}

export function SidebarAutoDeleteNotice(): JSX.Element | null {
  const context = useContext(SidebarAutoDeleteContext);
  if (!context?.state.notice) return null;
  return (
    <Notice intent="neutral" onDismiss={context.state.dismissNotice}>
      {context.state.notice.kind === 'error' ? (
        context.state.notice.message
      ) : (
        <>
          Auto-{context.state.notice.mode === 'archive' ? 'archive' : 'delete'}{' '}
          turned off for “
          <span className={REPLAY_MASK_CLASS}>{context.state.notice.name}</span>
          ”.
        </>
      )}
    </Notice>
  );
}

function ConnectedSidebarAutoDeleteProvider({
  children,
  client,
  retentionDaysFor,
}: {
  readonly children: ReactNode;
  readonly client: CanopyClient;
  readonly retentionDaysFor?: (workspaceId: string) => number | undefined;
}): JSX.Element {
  const state = useWorkEntryAutoDeleteStore((value) => value);
  const question = state.question;
  const row = question
    ? state.workspaces[question.workspaceId]?.[question.targetId]
    : undefined;
  const branches = row?.unmergedBranches ?? [];
  const retentionDays = question
    ? retentionDaysFor?.(question.workspaceId)
    : undefined;
  return (
    <SidebarAutoDeleteContext.Provider value={{ state, client }}>
      {children}
      {question && row?.state === 'awaiting-branch-confirmation' && (
        <ConfirmDialog
          title={
            <>
              Delete unmerged {branches.length > 1 ? 'branches' : 'branch'} “
              <span className={REPLAY_MASK_CLASS}>
                {branches.join('”, “') || question.name}
              </span>
              ”?
            </>
          }
          message={
            <>
              An agent armed auto-delete for this worktree. The branch has
              commits that are not merged anywhere else.
              {retentionDays !== undefined &&
                ` The worktree is restorable for ${retentionDays} ${retentionDays === 1 ? 'day' : 'days'} either way.`}
            </>
          }
          confirmLabel="Delete branch"
          destructive
          busy={state.busy}
          errorMessage={state.error}
          {...(state.errorRecorded
            ? { errorRecordingDisabled: true as const }
            : { errorSource: 'sidebar-auto-delete' })}
          onCancel={state.closeQuestion}
          onConfirm={() => {
            void state.resolve('delete-branch');
          }}
          secondaryAction={{
            label: 'Keep branch',
            onSelect: () => {
              void state.resolve('keep-branch');
            },
          }}
        />
      )}
    </SidebarAutoDeleteContext.Provider>
  );
}

/** Optional so standalone previews without a client keep their existing behavior. */
export function SidebarAutoDeleteProvider({
  children,
  retentionDaysFor,
}: {
  readonly children: ReactNode;
  readonly retentionDaysFor?: (workspaceId: string) => number | undefined;
}): JSX.Element {
  const client = useOptionalCanopyClient();
  return client ? (
    <ConnectedSidebarAutoDeleteProvider
      client={client}
      retentionDaysFor={retentionDaysFor}
    >
      {children}
    </ConnectedSidebarAutoDeleteProvider>
  ) : (
    <>{children}</>
  );
}

/** Shared worktree menu insertion; bulk menus intentionally do not inherit it. */
export function useSidebarAutoDeleteMenu(): (
  workspaceId: string,
  targetId: string,
  name: string,
) => WorktreeMenuItem | undefined {
  const context = useContext(SidebarAutoDeleteContext);
  return (workspaceId, targetId, name) => {
    const row = context?.state.workspaces[workspaceId]?.[targetId];
    const capabilities =
      context?.client.capabilitiesFor?.(targetId) ??
      context?.client.capabilities;
    if (
      !row ||
      !context ||
      capabilities?.workEntryAutoDelete !== 'manage' ||
      !context.client.disarmWorkEntryAutoDelete
    )
      return undefined;
    return {
      key: 'auto-delete-disarm',
      icon: null,
      label:
        row.mode === 'archive'
          ? 'Turn off auto-archive'
          : 'Turn off auto-delete',
      onSelect: () => {
        void context.state.disarm({ workspaceId, targetId, name });
      },
    };
  };
}

'use client';

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { PortalFileReadPayload } from '@canopy/protocol/portal';
import { Surface, Button } from '@canopy/ui-shared/components';
import { ChatPanel } from '../ChatPanel';
import type { FileEditorSlot } from '../file/FileViewer';
import { FindableFileViewer } from '../../find/FindableFileViewer';
import { ActivityPanel } from '../activity/ActivityPanel';
import { WorktreeSidebar } from './WorktreeSidebar';

export interface CodeShellTestId {
  readonly id: string;
  readonly aliases?: readonly string[];
}

export interface CodeShellTestIds {
  readonly shell?: CodeShellTestId;
  readonly header?: CodeShellTestId;
  readonly topStatus?: CodeShellTestId;
  readonly leftPanel?: CodeShellTestId;
  readonly center?: CodeShellTestId;
  readonly rightPanel?: CodeShellTestId;
  readonly bottomStatus?: CodeShellTestId;
}

export interface CodeShellRegions {
  readonly leftPanel: ReactNode;
  /**
   * Persistent worktree-scoped top bar, resolved to `null` unless BOTH a
   * workspace and a worktree are selected. Hosts mount it above the
   * center/activity content row (spanning the content region, outside the nav
   * and left sidebar) so it never flashes for an unselected/missing worktree.
   */
  readonly worktreeTopBar: ReactNode;
  readonly center: ReactNode;
  readonly rightPanel: ReactNode;
  /** Apply to host-rendered drawer/sheet controls when touch sizing is wanted. */
  readonly touchTargetClassName: string;
}

/**
 * The write-once Code-tab shell — the top layout that both the desktop renderer
 * and the web portal mount for the Workspaces surface. Composes the shared
 * {@link WorktreeSidebar} + center chat/file panels +
 * {@link ActivityPanel}, driven by the shared stores and injected host
 * callbacks. Capability differences (create-worktree, file editing, relayed
 * nav) are expressed through the panels' own gates, never a divergent layout —
 * so web renders the same shell desktop does.
 *
 * Selection is host-owned (props): the host tracks which worktree/chat is
 * active and passes it down. Opening a changed file swaps the center to the
 * {@link FileViewer}; a Back control returns to the chat.
 */
export interface CodeShellProps {
  readonly selectedWorkspaceLocalId?: string;
  readonly selectedWorktreeLocalId?: string;
  /** Chat thread id for the selected worktree's center panel. */
  readonly chatId?: string;
  readonly onSelectWorktree: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  readonly onAddWorktree?: (workspaceLocalId: string) => void;
  // Chat transport (injected by the host).
  readonly onSend?: (text: string) => void;
  readonly onStop?: () => void;
  readonly providerType?: string;
  readonly chatEmptyState?: ReactNode;
  // File viewer host wiring.
  readonly renderEditor?: (slot: FileEditorSlot) => ReactNode;
  readonly onOpenRelativePath?: (path: string) => void;
  readonly resolveAssetSrc?: (src: string) => string;
  /**
   * Builds the file-read request for a selected changed file. Multi-repo hosts
   * MUST inject this to scope the request to the right repo (`repoId` /
   * `fileRootLocalId`); returning `null` suppresses opening. When omitted, the
   * shell falls back to a single-repo request (`projectId`/`worktreeId`/path).
   */
  readonly buildFileRequest?: (
    filePath: string,
  ) => PortalFileReadPayload | null;
  // Activity panel host wiring.
  readonly onRevertFile?: (filePath: string) => void;
  readonly fileTreeRootKey?: string;
  readonly onOpenFile?: (name: string) => void;
  readonly onOpenDirectory?: (name: string) => void;
  // Presentation.
  readonly appIcon?: ReactNode;
  readonly header?: ReactNode;
  readonly topStatus?: ReactNode;
  readonly bottomStatus?: ReactNode;
  /**
   * Persistent worktree-scoped top bar (e.g. the shared {@link WorktreeTopBar}).
   * Resolved into {@link CodeShellRegions.worktreeTopBar} only when a workspace
   * AND a worktree are selected, so it never renders for an empty hydration, no
   * selection, a standalone chat, or the New Task surface.
   */
  readonly worktreeTopBar?: ReactNode;
  /** Replaces the built-in ChatPanel/empty/file center when provided. */
  readonly centerContent?: ReactNode;
  /**
   * Replaces the built-in WorktreeSidebar region. `undefined` keeps the
   * built-in region; `null`/`false` suppress the region entirely (no
   * fixed-width column); any other node renders inside the region wrapper.
   */
  readonly leftPanelContent?: ReactNode;
  /**
   * Replaces the built-in ActivityPanel rail. `undefined` keeps the built-in
   * rail; `null`/`false` suppress the rail entirely (no fixed-width column);
   * any other node renders inside the rail wrapper.
   */
  readonly rightPanelContent?: ReactNode;
  /** Appends host-owned targets, such as standalone chats, to the sidebar. */
  readonly sidebarNavigationExtension?: ReactNode;
  readonly workspaceActions?: ReactNode;
  readonly onAddWorkspace?: () => void;
  readonly onCreateTask?: () => void;
  readonly touchTargets?: boolean;
  /**
   * Lets a host choose its own breakpoint and compose regions into sheets or
   * drawers. The default remains the existing desktop flex layout.
   */
  readonly renderResponsiveShell?: (regions: CodeShellRegions) => ReactNode;
  readonly testIds?: CodeShellTestIds;
  readonly leftPanelWidth?: string;
  readonly rightPanelWidth?: string;
}

export function CodeShell({
  selectedWorkspaceLocalId,
  selectedWorktreeLocalId,
  chatId,
  onSelectWorktree,
  onAddWorktree,
  onSend,
  onStop,
  providerType,
  chatEmptyState,
  renderEditor,
  onOpenRelativePath,
  resolveAssetSrc,
  buildFileRequest,
  onRevertFile,
  fileTreeRootKey,
  onOpenFile,
  onOpenDirectory,
  appIcon,
  header,
  topStatus,
  bottomStatus,
  worktreeTopBar,
  centerContent,
  leftPanelContent,
  rightPanelContent,
  sidebarNavigationExtension,
  workspaceActions,
  onAddWorkspace,
  onCreateTask,
  touchTargets = false,
  renderResponsiveShell,
  testIds,
  leftPanelWidth = '16rem',
  rightPanelWidth = '20rem',
}: CodeShellProps): JSX.Element {
  const [openFile, setOpenFile] = useState<PortalFileReadPayload | null>(null);

  // Worktree localIds are workspace-scoped, so reset the open file whenever
  // EITHER the workspace or the worktree changes — otherwise switching to a
  // same-localId worktree in another workspace would keep a stale file (built
  // against the previous workspace's projectId) mounted.
  useEffect(() => {
    setOpenFile(null);
  }, [selectedWorkspaceLocalId, selectedWorktreeLocalId]);

  const handleSelectFile = (filePath: string): void => {
    if (!selectedWorkspaceLocalId || !selectedWorktreeLocalId) {
      return;
    }
    // Multi-repo hosts inject `buildFileRequest` to scope the read to the
    // correct repo; the bare fallback is single-repo only.
    const request = buildFileRequest
      ? buildFileRequest(filePath)
      : {
          projectId: selectedWorkspaceLocalId,
          worktreeId: selectedWorktreeLocalId,
          relativePath: filePath,
        };
    if (request) {
      setOpenFile(request);
    }
  };

  let defaultCenter: ReactNode;
  if (!selectedWorktreeLocalId) {
    defaultCenter = (
      <div
        className="flex h-full items-center justify-center px-6 text-s fg-secondary"
        data-testid="code-shell-empty"
      >
        Select a worktree to start.
      </div>
    );
  } else if (openFile) {
    defaultCenter = (
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="code-shell-file"
      >
        <Surface variant="section" boundary="bottom">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <Button
              variant="ghost"
              size="compact"
              onClick={(): void => setOpenFile(null)}
              data-testid="code-shell-file-back"
            >
              ← Back to chat
            </Button>
          </div>
        </Surface>
        <FindableFileViewer
          findScope={{ key: openFile.relativePath }}
          request={openFile}
          renderEditor={renderEditor}
          onOpenRelativePath={onOpenRelativePath}
          resolveAssetSrc={resolveAssetSrc}
        />
      </div>
    );
  } else if (chatId) {
    defaultCenter = (
      <ChatPanel
        // Composite key: a chat/worktree switch REMOUNTS the panel so its
        // unmount cleanup releases any in-flight queue edit lock with the
        // correctly captured entry/target pair.
        key={`${selectedWorkspaceLocalId ?? ''}:${selectedWorktreeLocalId ?? ''}:${chatId}`}
        chatId={chatId}
        findScope={{ title: 'Chat' }}
        // `CodeShellProps.onSend` stays text-only: adapt the widened shared
        // `ChatPanel` callback here and discard its `ChatPanelSendContext` so
        // the expanded panel signature never leaks into the shell's host API
        // (CAN-1429). Only the portal host consumes the optimistic identity.
        onSend={
          onSend
            ? (text): void => {
                onSend(text);
              }
            : undefined
        }
        onStop={onStop}
        providerType={providerType}
        appIcon={appIcon}
        emptyState={chatEmptyState}
      />
    );
  } else {
    defaultCenter = (
      <div
        className="flex h-full items-center justify-center px-6 text-s fg-secondary"
        data-testid="code-shell-no-chat"
      >
        No chat for this worktree.
      </div>
    );
  }

  const testIdProps = (
    key: keyof CodeShellTestIds,
    fallback: string,
  ): Record<string, string> => {
    const value = testIds?.[key];
    return {
      'data-testid': value?.id ?? fallback,
      ...(value?.aliases?.length
        ? { 'data-testid-aliases': value.aliases.join(' ') }
        : {}),
    };
  };
  const defaultLeftPanel = (
    <div
      className="shrink-0 border-r"
      style={{ width: leftPanelWidth }}
      {...testIdProps('leftPanel', 'code-shell-left-panel')}
    >
      <WorktreeSidebar
        selectedWorktreeLocalId={selectedWorktreeLocalId}
        onSelectWorktree={onSelectWorktree}
        onAddWorktree={onAddWorktree}
        navigationExtension={sidebarNavigationExtension}
        workspaceActions={workspaceActions}
        onAddWorkspace={onAddWorkspace}
        onCreateTask={onCreateTask}
        touchTargets={touchTargets}
      />
    </div>
  );
  // Slot semantics: `undefined` keeps the built-in WorktreeSidebar region;
  // `null`/`false` suppress the region entirely (no empty fixed-width column);
  // any other node replaces the region content.
  const leftPanel =
    leftPanelContent === undefined ? (
      defaultLeftPanel
    ) : leftPanelContent === null || leftPanelContent === false ? null : (
      <div
        className="shrink-0 border-r"
        style={{ width: leftPanelWidth }}
        {...testIdProps('leftPanel', 'code-shell-left-panel')}
      >
        {leftPanelContent}
      </div>
    );
  const center = (
    // flex + min-h-0 are load-bearing: as a plain block this wrapper would let
    // its content grow to natural height (the chat transcript then stretches
    // the page instead of scrolling internally and the sticky composer falls
    // below the fold). The flex-column + min-h-0 chain propagates the shell's
    // height constraint down to the scrollable transcript.
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      {...testIdProps('center', 'code-shell-center')}
    >
      {centerContent === undefined ? defaultCenter : centerContent}
    </div>
  );
  const defaultRightPanel =
    selectedWorkspaceLocalId && selectedWorktreeLocalId ? (
      <div
        className="shrink-0 border-l"
        style={{ width: rightPanelWidth }}
        {...testIdProps('rightPanel', 'code-shell-right-panel')}
      >
        <ActivityPanel
          workspaceLocalId={selectedWorkspaceLocalId}
          worktreeLocalId={selectedWorktreeLocalId}
          onSelectFile={handleSelectFile}
          onRevertFile={onRevertFile}
          fileTreeRootKey={fileTreeRootKey}
          onOpenFile={onOpenFile}
          onOpenDirectory={onOpenDirectory}
        />
      </div>
    ) : null;
  // Slot semantics: `undefined` keeps the built-in ActivityPanel rail;
  // `null`/`false` suppress the rail entirely (no empty fixed-width column —
  // responsive hosts hide the rail at narrow breakpoints this way); any other
  // node replaces the rail content.
  const rightPanel =
    rightPanelContent === undefined ? (
      defaultRightPanel
    ) : rightPanelContent === null || rightPanelContent === false ? null : (
      <div
        className="shrink-0 border-l"
        style={{ width: rightPanelWidth }}
        {...testIdProps('rightPanel', 'code-shell-right-panel')}
      >
        {rightPanelContent}
      </div>
    );
  // The top bar is worktree-scoped chrome: resolve it to null unless BOTH a
  // workspace and a worktree are selected, so it never flashes for an empty
  // hydration, no selection, a standalone chat, or the New Task surface. Hosts
  // that pass no node get null regardless.
  const resolvedWorktreeTopBar =
    selectedWorkspaceLocalId && selectedWorktreeLocalId
      ? (worktreeTopBar ?? null)
      : null;
  const regions: CodeShellRegions = {
    leftPanel,
    worktreeTopBar: resolvedWorktreeTopBar,
    center,
    rightPanel,
    touchTargetClassName: 'min-h-11 min-w-11',
  };

  return (
    // overflow-hidden is load-bearing: the shell root must clip its content so
    // a long transcript cannot stretch the root past its h-full box and push
    // the sticky composer below the fold (the pre-adoption portal shell root
    // carried the same containment).
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-base fg-primary"
      {...testIdProps('shell', 'code-shell')}
    >
      {header && (
        <div {...testIdProps('header', 'code-shell-header')}>{header}</div>
      )}
      {topStatus && (
        <div {...testIdProps('topStatus', 'code-shell-top-status')}>
          {topStatus}
        </div>
      )}
      {renderResponsiveShell ? (
        renderResponsiveShell(regions)
      ) : (
        <div className="flex min-h-0 flex-1">
          {leftPanel}
          {/* Content column: the worktree top bar spans the center + activity
              rail (outside the nav and left sidebar), mounted above that row. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {resolvedWorktreeTopBar}
            <div className="flex min-h-0 min-w-0 flex-1">
              {center}
              {rightPanel}
            </div>
          </div>
        </div>
      )}
      {bottomStatus && (
        <div {...testIdProps('bottomStatus', 'code-shell-bottom-status')}>
          {bottomStatus}
        </div>
      )}
    </div>
  );
}

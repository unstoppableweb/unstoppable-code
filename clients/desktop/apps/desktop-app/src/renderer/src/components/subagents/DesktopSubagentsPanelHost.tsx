import { useCallback, useState, type JSX } from 'react';
import { LifetimeLimitNotice } from '@canopy/ui-app';
import {
  ErrorState,
  SUBAGENTS_LOAD_FAILED_LABEL,
  SUBAGENTS_LOADING_LABEL,
  SubagentsEmptyState,
} from '@canopy/ui-shared/components';
import { retryWebCoreServedOperations } from '@/lib/web-core-served-operations';
import { useWorkspaceCapabilities } from '@canopy/app-state/CanopyClientProvider';
import {
  lifetimeLimitTargetKey,
  useLifetimeLimitStore,
} from '@canopy/app-state/delegation/lifetime-limit-store';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  isSubagentChatKind,
  type SubagentNode,
} from '@canopy/agent-transcript';
import {
  SubagentsPanel,
  useSubagentScopeViewState,
  useSubagentViewStateStore,
  type SubagentCommandResult,
} from '@canopy/ui-app/subagents';
import { useChatStore, type ChatMessage } from '@/stores/chatStore';
import { openSubagentChatPanel } from '@/lib/panels/subagent-panel-open';
import { findWorkflowRunLocation } from './workflow-run-launches';
import { stopSubagent, stopWorkflowRun } from './subagent-commands';
import {
  subagentScopeKey,
  subagentScopeShowsWorkspaceDetails,
  type SubagentHostScope,
} from './subagent-scope';
import {
  useSubagentPanelsAvailability,
  useSubagentViewerCapabilities,
} from './subagent-capabilities';
import { useSubagentChangeTotals } from './subagent-change-totals';
import { desktopSubagentViewStatePersistence } from './subagent-view-state-persistence';
import {
  SubagentChangesDialog,
  type SubagentChangesTarget,
} from './SubagentChangesDialog';
import { useSubagentRootChats } from './useSubagentRootChats';
import { useSubagentTree } from './useSubagentTree';
import {
  WorkflowRunDialog,
  type WorkflowRunDialogTarget,
} from './WorkflowRunDialog';

const EMPTY_MESSAGES: readonly ChatMessage[] = [];

/**
 * The root chat's loaded messages, read when a workflow control is used. Not a
 * subscription: the panel must not re-render on every streamed root message.
 */
function readRootMessages(
  scopeKey: string,
  rootChatId: string,
): readonly ChatMessage[] {
  const tab = useChatStore
    .getState()
    .worktreeChats[
      scopeKey
    ]?.tabs.find((candidate) => candidate.id === rootChatId && candidate.kind !== 'file');
  return tab?.messages ?? EMPTY_MESSAGES;
}

export interface DesktopSubagentsPanelHostProps {
  readonly scope: SubagentHostScope;
  readonly isVisible: boolean;
  readonly isActive: boolean;
}

/** Desktop-only, sanitized awareness; never exposes refusal identities or a setter. */
function LifetimeLimitUiReporter({
  scope,
  enabled,
}: {
  readonly scope: SubagentHostScope;
  readonly enabled: boolean;
}): null {
  const key = lifetimeLimitTargetKey(scope);
  const status = useLifetimeLimitStore((state) => state.entries[key]?.status);
  const capabilities = useWorkspaceCapabilities(scope.worktreeId);
  const available = status?.kind === 'available' ? status : null;
  const notice =
    status && !available
      ? 'unavailable'
      : available?.atLimit
        ? available.atCap
          ? 'full_at_cap'
          : 'full'
        : 'none';
  useCurrentUiStateReporter(
    enabled ? 'subagents.lifetimeLimit' : null,
    enabled
      ? {
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          notice,
          atLimit: available?.atLimit ?? null,
          limit: available?.limit ?? null,
          canExtend:
            capabilities.delegationLifetimeLimitExtension === true &&
            available?.canExtend === true,
        }
      : null,
  );
  return null;
}

/**
 * Desktop adapter for the shared Subagents panel. A cloud scope's panel
 * mounts the reading host only once the web core serves it (CAN-7133).
 */
export function DesktopSubagentsPanelHost(
  props: DesktopSubagentsPanelHostProps,
): JSX.Element {
  const availability = useSubagentPanelsAvailability(props.scope);
  if (availability === 'served') return <ServedSubagentsPanelHost {...props} />;
  if (!props.isVisible) return <></>;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1"
      data-panel-active={props.isActive}
    >
      {availability === 'pending' ? (
        <div
          role="status"
          aria-busy="true"
          data-testid="subagents-pending"
          className="flex flex-1 items-center justify-center gap-2 text-xs fg-tertiary"
        >
          {SUBAGENTS_LOADING_LABEL}
        </div>
      ) : availability === 'failed' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
          <ErrorState
            space="panel"
            testId="subagents-manifest-failed"
            retryTestId="subagents-manifest-retry"
            message={SUBAGENTS_LOAD_FAILED_LABEL}
            onRetry={retryManifest}
          />
        </div>
      ) : (
        <SubagentsEmptyState kind="unavailable" />
      )}
    </div>
  );
}

/** Try again on a failed manifest read; the read stays one at a time. */
function retryManifest(): void {
  retryWebCoreServedOperations();
}

/** The panel over its IPC-backed or web core data. */
function ServedSubagentsPanelHost({
  scope,
  isVisible,
  isActive,
}: DesktopSubagentsPanelHostProps): JSX.Element {
  const scopeKey = subagentScopeKey(scope);
  const { rootChats } = useSubagentRootChats(scope, { enabled: isVisible });
  const scopeState = useSubagentScopeViewState(scopeKey);
  const selectedRootId = rootChats.some(
    (root) => root.id === scopeState.selectedRootId,
  )
    ? scopeState.selectedRootId
    : null;
  const capabilities = useSubagentViewerCapabilities(scope);
  const treeQuery = useSubagentTree(scope, selectedRootId, {
    enabled: isVisible,
    reloadEvictedTranscript: true,
    liveReads: capabilities.stop,
  });
  const showWorkspaceDetails = subagentScopeShowsWorkspaceDetails(scope);
  const [selectedNode, setSelectedNode] = useState<SubagentNode | null>(null);
  const [changesTarget, setChangesTarget] =
    useState<SubagentChangesTarget | null>(null);
  const [workflowTarget, setWorkflowTarget] =
    useState<WorkflowRunDialogTarget | null>(null);
  const changeTotals = useSubagentChangeTotals(scope, selectedNode, {
    enabled: isVisible,
    worktreeDetails: capabilities.worktreeDetails,
    showWorkspaceDetails,
  });

  const selectRoot = useCallback(
    (rootId: string): void => {
      useSubagentViewStateStore.getState().setSelectedRoot(scopeKey, rootId);
    },
    [scopeKey],
  );
  const openChat = useCallback(
    (node: SubagentNode): void => {
      if (!selectedRootId || !isSubagentChatKind(node.kind)) return;
      void openSubagentChatPanel(scope, {
        rootChatId: selectedRootId,
        subagentId: node.id,
        subagentKind: node.kind,
        title: node.title,
      });
    },
    [selectedRootId, scope],
  );
  const openWorkflow = useCallback(
    (run: SubagentNode): void => {
      const runId = run.workflow?.runId;
      if (!selectedRootId || !runId) return;
      const location = findWorkflowRunLocation(
        readRootMessages(scopeKey, selectedRootId),
        runId,
      );
      if (!location) return;
      setWorkflowTarget({
        runId,
        transcriptDir: location.transcriptDir,
        title: run.workflow?.runName || run.title,
        ...(location.taskId ? { taskId: location.taskId } : {}),
      });
    },
    [scopeKey, selectedRootId],
  );
  const stopWorkflow = useCallback(
    (run: SubagentNode): Promise<SubagentCommandResult> => {
      if (!selectedRootId) {
        return Promise.resolve({
          ok: false,
          error: 'No root chat is selected.',
        });
      }
      const runId = run.workflow?.runId;
      const location = runId
        ? findWorkflowRunLocation(
            readRootMessages(scopeKey, selectedRootId),
            runId,
          )
        : undefined;
      if (!location) {
        return Promise.resolve({
          ok: false,
          error: 'This workflow run cannot be stopped.',
        });
      }
      return stopWorkflowRun(scope, selectedRootId, {
        taskId: location.taskId,
      });
    },
    [scope, scopeKey, selectedRootId],
  );
  const stop = useCallback(
    (node: SubagentNode): Promise<SubagentCommandResult> =>
      selectedRootId
        ? stopSubagent(scope, selectedRootId, node)
        : Promise.resolve({ ok: false, error: 'No root chat is selected.' }),
    [selectedRootId, scope],
  );
  const showChanges = useCallback(
    (node: SubagentNode): void => {
      if (
        !capabilities.worktreeDetails ||
        node.kind !== 'managed' ||
        node.workspace !== 'isolated' ||
        node.isolatedRevision === undefined ||
        node.workspaceDiscarded === true
      ) {
        return;
      }
      setChangesTarget({
        scope,
        delegationId: node.id,
        revision: node.isolatedRevision,
        title: node.title,
      });
    },
    [capabilities.worktreeDetails, scope],
  );
  const closeChanges = useCallback((): void => setChangesTarget(null), []);
  const closeWorkflow = useCallback((): void => setWorkflowTarget(null), []);

  if (!isVisible) return <></>;

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-panel-active={isActive}>
      <SubagentsPanel
        scopeKey={scopeKey}
        lifetimeNotice={
          showWorkspaceDetails ? (
            <LifetimeLimitNotice
              projectId={scope.projectId}
              worktreeId={scope.worktreeId}
              placement="panel"
            />
          ) : undefined
        }
        rootChats={rootChats}
        selectedRootId={selectedRootId}
        tree={treeQuery.tree}
        treeState={treeQuery.treeState}
        capabilities={capabilities}
        showWorkspaceDetails={showWorkspaceDetails}
        changeTotals={changeTotals}
        persistence={desktopSubagentViewStatePersistence}
        onSelectRoot={selectRoot}
        onOpenChat={openChat}
        onOpenWorkflow={openWorkflow}
        onStopWorkflow={stopWorkflow}
        onStop={stop}
        onShowChanges={showChanges}
        onSelectedNodeChange={setSelectedNode}
      />
      {showWorkspaceDetails ? (
        <LifetimeLimitUiReporter
          scope={scope}
          enabled={isVisible && isActive}
        />
      ) : null}
      <SubagentChangesDialog target={changesTarget} onClose={closeChanges} />
      <WorkflowRunDialog
        scope={scope}
        target={workflowTarget}
        onClose={closeWorkflow}
      />
    </div>
  );
}

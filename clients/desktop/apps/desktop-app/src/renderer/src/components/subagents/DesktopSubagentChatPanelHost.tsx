import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/shallow';
import type {
  SubagentKind,
  SubagentNode,
  SubagentTree,
} from '@canopy/agent-transcript';
import {
  buildSubagentChatTranscript,
  parseWorkflowAgentNodeId,
  type SubagentTranscriptRunSource,
} from '@canopy/agent-transcript';
import type {
  ChatToolOutputResponse,
  ManagedDelegationTreeEntry,
} from '@canopy/desktop-shared/types';
import { botIdForProjectId } from '@canopy/protocol/chat-targets';
import type {
  SubagentRecipient,
  AgentSentReceivingContext,
} from '@canopy/ui-shared';
import {
  SubagentChatPanel,
  subagentCapabilitiesForKind,
  type SubagentCommandResult,
  type SubagentLineageTarget,
  type SubagentMessageRequest,
  type SubagentMessageResult,
  type SubagentNativeInterruptResult,
} from '@canopy/ui-app/subagents';
import {
  ErrorState,
  SUBAGENT_CHAT_LOADING_LABEL,
  SUBAGENT_CHAT_NOT_FOUND_LABEL,
  SUBAGENTS_LOAD_FAILED_LABEL,
  SubagentsEmptyState,
} from '@canopy/ui-shared/components';
import type { SubagentViewerCapabilities } from '@canopy/ui-app/subagents';
import { SubagentCostSection } from '@canopy/ui-app/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import type { DisplayMessage } from '@/components/chat/types';
import { placeSafetyDenialReceipts } from '@/components/chat/safety-denial-placement';
import {
  useChatStore,
  type ChatMessage,
  type ChatTab,
} from '@/stores/chatStore';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';
import { DESKTOP_COST_NAVIGATOR } from '@/lib/cost/cost-navigator';
import { ChatMarkdownFileTargetContext } from '@/components/chat/chat-markdown-file-target';
import { ToolOutputReaderContext, type ToolOutputReader } from '@canopy/ui-app';
import {
  ManagedDelegationStopContext,
  type ManagedDelegationChatTarget,
} from '@/components/chat/managed-delegation-stop';
import { useCloudDelegationLiveState } from '@/cloud-chats/cloud-delegation-stop';
import { isWebCoreScope } from '@/lib/chat-authority';
import { CloudSubagentTranscript } from './CloudSubagentTranscript';
import {
  interruptNativeSubagent,
  messageManagedSubagent,
} from './subagent-commands';
import { openSubagentLineageTarget } from './subagent-lineage';
import { retryWebCoreServedOperations } from '@/lib/web-core-served-operations';
import {
  useSubagentPanelsAvailability,
  useSubagentViewerCapabilities,
} from './subagent-capabilities';
import {
  createSubagentEntryActions,
  SubagentEntryActionsContext,
} from './subagent-entry-actions';
import {
  subagentScopeKey,
  subagentScopeShowsWorkspaceDetails,
  type SubagentHostScope,
} from './subagent-scope';
import { sendToSubagentRecipient } from './subagent-send-to-recipient';
import { SubagentChatTranscript } from './SubagentChatTranscript';
import {
  SubagentChangesDialog,
  type SubagentChangesTarget,
} from './SubagentChangesDialog';
import { useSubagentTranscriptPages } from './useSubagentTranscriptPages';
import { useSubagentTree } from './useSubagentTree';
import { useSubagentWorktreeSummary } from './useSubagentWorktreeSummary';
import { findWorkflowRunLocation } from './workflow-run-launches';
import { parseAgentTranscriptLines } from '@/lib/transcript-parser';
import {
  buildWorkflowAgentTranscriptItems,
  WORKFLOW_AGENT_TRANSCRIPT_TRUNCATED_NOTICE,
} from './workflow-agent-transcript';
import { useWorkflowAgentTranscript } from './useWorkflowAgentTranscript';
import {
  WorkflowRunDialog,
  type WorkflowRunDialogTarget,
} from './WorkflowRunDialog';

const EMPTY_MESSAGES: readonly ChatMessage[] = [];
const EMPTY_DISPLAY_MESSAGES: readonly DisplayMessage[] = [];

export interface DesktopSubagentChatPanelHostProps {
  readonly scope: SubagentHostScope;
  readonly rootChatId: string;
  readonly subagentId: string;
  readonly subagentKind: SubagentKind;
  readonly panelId: string;
  readonly isVisible: boolean;
  readonly isActive: boolean;
}

interface RootChatProjection {
  readonly messages: readonly ChatMessage[];
  readonly status: ChatTab['status'];
}

function useRootChatProjection(
  scope: SubagentHostScope,
  rootChatId: string,
): RootChatProjection {
  const worktreeKey = subagentScopeKey(scope);
  return useChatStore(
    useShallow((state): RootChatProjection => {
      const tab = state.worktreeChats[worktreeKey]?.tabs.find(
        (candidate) => candidate.id === rootChatId && candidate.kind !== 'file',
      );
      return tab
        ? { messages: tab.messages, status: tab.status }
        : { messages: EMPTY_MESSAGES, status: 'idle' };
    }),
  );
}

function UnavailableSubagentChat(): JSX.Element {
  return (
    <div
      data-testid="subagent-chat-unavailable"
      className="flex min-h-0 flex-1 items-center justify-center"
      role="status"
    >
      <p className="text-xs fg-secondary">{SUBAGENT_CHAT_NOT_FOUND_LABEL}</p>
    </div>
  );
}

/** A tree that failed to load, such as an evicted root whose reload failed. */
function SubagentChatLoadError({
  error,
  onRetry,
  retrying = false,
}: {
  readonly error: string;
  readonly onRetry: (() => void) | undefined;
  readonly retrying?: boolean;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
      <ErrorState
        space="panel"
        testId="subagent-chat-load-error"
        retryTestId="subagent-chat-load-retry"
        message={SUBAGENTS_LOAD_FAILED_LABEL}
        details={error}
        onRetry={onRetry}
        retrying={retrying}
      />
    </div>
  );
}

// A busy Try again swallows clicks; it only needs a handler to stay mounted.
const RETRY_IN_PROGRESS = (): void => undefined;

function LoadingSubagentChat(): JSX.Element {
  return (
    <div
      data-testid="subagent-chat-loading"
      className="flex min-h-0 flex-1 items-center justify-center"
      role="status"
      aria-busy="true"
    >
      <p className="text-xs fg-secondary">{SUBAGENT_CHAT_LOADING_LABEL}</p>
    </div>
  );
}

interface DesktopSubagentChatContentProps {
  readonly scope: SubagentHostScope;
  readonly rootChatId: string;
  readonly node: SubagentNode;
  readonly tree: SubagentTree;
  readonly rootMessages: readonly ChatMessage[];
  readonly managedEntry: ManagedDelegationTreeEntry | undefined;
  readonly rootChatBusy: boolean;
  readonly baseCapabilities: SubagentViewerCapabilities;
}

function DesktopSubagentChatContent({
  scope,
  rootChatId,
  node,
  tree,
  rootMessages,
  managedEntry,
  rootChatBusy,
  baseCapabilities,
}: DesktopSubagentChatContentProps): JSX.Element {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [changesTarget, setChangesTarget] =
    useState<SubagentChangesTarget | null>(null);
  const costScope = useMemo<CostScopeRef>(
    () => ({
      kind: 'entry',
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    }),
    [scope.projectId, scope.worktreeId],
  );
  const [workflowTarget, setWorkflowTarget] =
    useState<WorkflowRunDialogTarget | null>(null);
  // A cloud scope's delegates don't run here: their pages come from the web
  // core and nothing reaches main with its ids (CAN-7133).
  const cloud = isWebCoreScope(scope.projectId);
  const capabilities = useMemo(() => {
    const narrowed = subagentCapabilitiesForKind(baseCapabilities, node.kind);
    return subagentScopeShowsWorkspaceDetails(scope)
      ? narrowed
      : { ...narrowed, worktreeDetails: false };
  }, [baseCapabilities, node.kind, scope]);
  const worktree = useSubagentWorktreeSummary(
    scope,
    node,
    detailsExpanded,
    capabilities,
  );
  const pages = useSubagentTranscriptPages(
    scope,
    rootChatId,
    node,
    rootMessages,
    {
      enabled: !cloud && node.kind !== 'workflow-agent',
    },
  );
  // The delegate's lifecycle re-reads its open pages, as on its card; read
  // only while its scope serves it (CAN-7245).
  const cloudLive = useCloudDelegationLiveState(
    cloud && baseCapabilities.stop && node.kind === 'managed'
      ? { ...scope, chatId: rootChatId }
      : null,
    node.kind === 'managed' ? [node.id] : [],
    { parentActive: rootChatBusy, changeKey: String(rootMessages.length) },
  );
  const cloudEpoch = cloudLive?.epochs.get(node.id) ?? 0;
  const workflowAgentIds =
    node.kind === 'workflow-agent' ? parseWorkflowAgentNodeId(node.id) : null;
  const workflowRunLocation = workflowAgentIds
    ? findWorkflowRunLocation(rootMessages, workflowAgentIds.runId)
    : undefined;
  const workflowLive =
    node.status === 'queued' ||
    node.status === 'starting' ||
    node.status === 'running';
  const workflowTranscript = useWorkflowAgentTranscript({
    transcriptDir: workflowRunLocation?.transcriptDir,
    agentId: workflowAgentIds?.agentId ?? '',
    live: workflowLive,
    enabled: node.kind === 'workflow-agent' && workflowAgentIds !== null,
  });
  const parsedWorkflowMessages = useMemo(
    () =>
      node.kind === 'workflow-agent'
        ? parseAgentTranscriptLines([...workflowTranscript.lines], 'claude')
            .displayMessages
        : EMPTY_DISPLAY_MESSAGES,
    [node.kind, workflowTranscript.lines],
  );
  const parseWorkflowTranscript = useCallback(
    (lines: readonly string[]): readonly DisplayMessage[] =>
      lines === workflowTranscript.lines
        ? parsedWorkflowMessages
        : parseAgentTranscriptLines([...lines], 'claude').displayMessages,
    [parsedWorkflowMessages, workflowTranscript.lines],
  );
  const workflowTranscriptItems = useMemo(
    () =>
      node.kind === 'workflow-agent'
        ? buildWorkflowAgentTranscriptItems({
            node,
            lines: workflowTranscript.lines,
            initialPrompt: workflowTranscript.initialPrompt,
            parse: parseWorkflowTranscript,
          })
        : [],
    [
      node,
      parseWorkflowTranscript,
      workflowTranscript.initialPrompt,
      workflowTranscript.lines,
    ],
  );
  const managedRun = node.kind === 'managed' ? managedEntry : undefined;

  const transcriptRuns = useMemo((): readonly SubagentTranscriptRunSource[] => {
    if (node.kind !== 'managed') return [];
    return node.runs.map((run) => {
      const page = pages.runs.get(run.runGeneration);
      const prompt =
        managedRun?.runGeneration === run.runGeneration
          ? managedRun.prompt
          : page?.task.prompt;
      return {
        runGeneration: run.runGeneration,
        ...(run.agentBlockId !== undefined
          ? { agentBlockId: run.agentBlockId }
          : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(page !== undefined
          ? {
              pagedMessages: page.messages,
              replacesRootRows: page.replacesRootRows,
            }
          : {}),
      };
    });
  }, [managedRun, node, pages.runs]);
  const transcript = useMemo(() => {
    if (node.kind === 'workflow-agent') {
      return { items: [], missingBeginning: false };
    }
    return buildSubagentChatTranscript({
      tree,
      node,
      // Project canonical receipts before selecting this child's rows, just
      // as the parent chat does before folding its tool results.
      rootMessages: placeSafetyDenialReceipts([...rootMessages]),
      runs: transcriptRuns,
    });
  }, [node, rootMessages, transcriptRuns, tree]);
  const entryActions = useMemo(
    () => createSubagentEntryActions(scope, rootChatId),
    [rootChatId, scope],
  );
  const markdownTarget = useMemo(
    () => ({ projectId: scope.projectId, worktreeId: scope.worktreeId }),
    [scope.projectId, scope.worktreeId],
  );
  const receivingContext = useMemo<AgentSentReceivingContext>(() => {
    const botId = botIdForProjectId(scope.projectId);
    return botId === null
      ? { kind: 'project', projectId: scope.projectId }
      : { kind: 'bot', botId };
  }, [scope.projectId]);
  const readToolOutput = useMemo<ToolOutputReader>(
    () =>
      async (identity, offset, signal): Promise<ChatToolOutputResponse> => {
        // A cloud chat's tool output isn't on this computer (CAN-7133).
        if (identity.kind !== 'reference' || cloud)
          throw new Error("Couldn't load full output in this view.");
        const { messageId, toolUseId, reference } = identity;
        signal.throwIfAborted();
        const requestId = globalThis.crypto.randomUUID();
        const cancel = (): void => {
          void window.api.chat
            .cancelToolOutput({ requestId })
            .catch((): void => undefined);
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          return await window.api.chat.readToolOutput({
            projectId: scope.projectId,
            worktreeId: scope.worktreeId,
            chatId: rootChatId,
            messageId,
            toolUseId,
            requestId,
            archivedContainerId: undefined,
            standaloneHistory: false,
            reference,
            offset,
            limit: 65536,
          });
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      },
    [cloud, rootChatId, scope.projectId, scope.worktreeId],
  );
  const stopTarget = useMemo<ManagedDelegationChatTarget>(
    () => ({ ...scope, chatId: rootChatId }),
    [rootChatId, scope],
  );
  const liveDescendantIds = useMemo(
    () =>
      new Set(
        Array.from(tree.nodes.values())
          .filter((candidate) => candidate.liveDescendantCount > 0)
          .map((candidate) => candidate.id),
      ),
    [tree],
  );
  const stopControls = useMemo(
    () =>
      capabilities.stop
        ? {
            target: stopTarget,
            withLiveDescendants: liveDescendantIds,
            worktreeDetails: baseCapabilities.worktreeDetails,
          }
        : null,
    [
      baseCapabilities.worktreeDetails,
      capabilities.stop,
      liveDescendantIds,
      stopTarget,
    ],
  );

  const onDetailsExpandedChange = useCallback((expanded: boolean): void => {
    setDetailsExpanded(expanded);
  }, []);
  const onOpenLineage = useCallback(
    (target: SubagentLineageTarget): void => {
      openSubagentLineageTarget(scope, rootChatId, target);
    },
    [rootChatId, scope],
  );
  const onOpenWorkflow = useCallback(
    (runId: string): void => {
      const location = findWorkflowRunLocation(rootMessages, runId);
      if (!location) return;
      setWorkflowTarget({
        runId,
        transcriptDir: location.transcriptDir,
        title: node.workflow?.runName ?? location.name,
        ...(location.taskId ? { taskId: location.taskId } : {}),
      });
    },
    [node.workflow?.runName, rootMessages],
  );
  const onMessageSubagent = useCallback(
    (request: SubagentMessageRequest): Promise<SubagentMessageResult> =>
      node.kind === 'managed'
        ? messageManagedSubagent(scope, rootChatId, node.id, request)
        : Promise.resolve({
            ok: false,
            code: 'failed',
            error: 'This subagent cannot receive messages.',
          }),
    [node.id, node.kind, rootChatId, scope],
  );
  const onInterruptNative = useCallback(
    (): Promise<SubagentNativeInterruptResult> =>
      interruptNativeSubagent(scope, rootChatId, node),
    [node, rootChatId, scope],
  );
  const onSendToRecipient = useCallback(
    (
      recipient: SubagentRecipient,
      text: string,
    ): Promise<SubagentCommandResult> =>
      sendToSubagentRecipient({ scope, rootChatId, tree, recipient, text }),
    [rootChatId, scope, tree],
  );
  const onShowChanges = useCallback((): void => {
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
  }, [capabilities.worktreeDetails, node, scope]);
  const onCloseChanges = useCallback((): void => {
    setChangesTarget(null);
  }, []);
  const onCloseWorkflow = useCallback((): void => {
    setWorkflowTarget(null);
  }, []);

  return (
    <ChatMarkdownFileTargetContext.Provider value={markdownTarget}>
      <ToolOutputReaderContext.Provider value={readToolOutput}>
        <ManagedDelegationStopContext.Provider value={stopControls}>
          <SubagentEntryActionsContext.Provider value={entryActions}>
            <SubagentChatPanel
              tree={tree}
              subagentId={node.id}
              capabilities={capabilities}
              costDetails={
                node.kind === 'workflow-agent' ? undefined : (
                  <SubagentCostSection
                    client={desktopCostClient}
                    navigator={DESKTOP_COST_NAVIGATOR}
                    scope={costScope}
                    chatId={rootChatId}
                    subagentId={node.id}
                  />
                )
              }
              transcript={
                <>
                  {node.kind === 'workflow-agent' &&
                  workflowTranscript.truncated ? (
                    <p
                      data-testid="subagent-workflow-transcript-truncated"
                      className="text-xs fg-secondary"
                    >
                      {WORKFLOW_AGENT_TRANSCRIPT_TRUNCATED_NOTICE}
                    </p>
                  ) : null}
                  {cloud && node.kind === 'managed' ? (
                    <CloudSubagentTranscript
                      scope={scope}
                      rootChatId={rootChatId}
                      tree={tree}
                      node={node}
                      rootMessages={rootMessages}
                      epoch={cloudEpoch}
                      streaming={
                        node.status === 'running' || node.status === 'approval'
                      }
                      receivingContext={receivingContext}
                    />
                  ) : (
                    <SubagentChatTranscript
                      items={
                        node.kind === 'workflow-agent'
                          ? workflowTranscriptItems
                          : transcript.items
                      }
                      originChatTabId={rootChatId}
                      receivingContext={receivingContext}
                      streaming={
                        node.kind === 'workflow-agent'
                          ? workflowLive
                          : node.status === 'running' ||
                            node.status === 'approval'
                      }
                    />
                  )}
                </>
              }
              hasOlder={pages.hasOlder}
              loadingOlder={pages.loadingOlder}
              onLoadOlder={pages.onLoadOlder}
              rootChatBusy={rootChatBusy}
              executionMode={
                node.kind === 'managed' ? managedRun?.executionMode : undefined
              }
              changeTotals={worktree.changeTotals}
              worktree={worktree.state}
              onOpenLineage={onOpenLineage}
              onOpenWorkflow={onOpenWorkflow}
              onDetailsExpandedChange={onDetailsExpandedChange}
              onShowChanges={onShowChanges}
              onMessageSubagent={
                node.kind === 'managed' ? onMessageSubagent : undefined
              }
              onInterruptNative={
                node.kind === 'claude-native' ? onInterruptNative : undefined
              }
              onSendToRecipient={onSendToRecipient}
            />
            <SubagentChangesDialog
              target={changesTarget}
              onClose={onCloseChanges}
            />
            <WorkflowRunDialog
              scope={scope}
              target={workflowTarget}
              onClose={onCloseWorkflow}
            />
          </SubagentEntryActionsContext.Provider>
        </ManagedDelegationStopContext.Provider>
      </ToolOutputReaderContext.Provider>
    </ChatMarkdownFileTargetContext.Provider>
  );
}

/**
 * Desktop binding for a subagent's chat panel. A cloud scope's panel mounts
 * the reading host only once the web core serves it (CAN-7133).
 */
export function DesktopSubagentChatPanelHost(
  props: DesktopSubagentChatPanelHostProps,
): JSX.Element {
  const availability = useSubagentPanelsAvailability(props.scope);
  if (availability === 'served')
    return <ServedSubagentChatPanelHost {...props} />;
  if (!props.isVisible) return <></>;
  return availability === 'pending' ? (
    <div
      data-testid="subagent-chat-pending"
      className="flex min-h-0 flex-1 items-center justify-center"
      role="status"
      aria-busy="true"
    >
      <p className="text-xs fg-secondary">{SUBAGENT_CHAT_LOADING_LABEL}</p>
    </div>
  ) : availability === 'failed' ? (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
      <ErrorState
        space="panel"
        testId="subagent-chat-manifest-failed"
        retryTestId="subagent-chat-manifest-retry"
        message={SUBAGENTS_LOAD_FAILED_LABEL}
        onRetry={retryManifest}
      />
    </div>
  ) : (
    <div className="flex min-h-0 min-w-0 flex-1">
      <SubagentsEmptyState kind="unavailable" />
    </div>
  );
}

/** Try again on a failed manifest read; the read stays one at a time. */
function retryManifest(): void {
  retryWebCoreServedOperations();
}

/** A subagent's shared chat panel and transcript over the scope's data. */
function ServedSubagentChatPanelHost({
  scope,
  rootChatId,
  subagentId,
  subagentKind,
  panelId,
  isVisible,
  isActive,
}: DesktopSubagentChatPanelHostProps): JSX.Element {
  const baseCapabilities = useSubagentViewerCapabilities(scope);
  const treeQuery = useSubagentTree(scope, rootChatId, {
    enabled: isVisible,
    reloadEvictedTranscript: true,
    liveReads: baseCapabilities.stop,
  });
  const { treeState } = treeQuery;
  // Try again keeps the failure on screen, busy, until the reload settles, so
  // the panel never blanks between tries and the button keeps focus.
  const [retriedError, setRetriedError] = useState<string | null>(null);
  if (retriedError !== null && treeState.status !== 'loading') {
    setRetriedError(null);
  }
  const rootChat = useRootChatProjection(scope, rootChatId);
  const node = treeQuery.tree?.nodes.get(subagentId);
  const scopeKey = subagentScopeKey(scope);
  const titleBindingKey = `${scopeKey}/${panelId}`;
  const appliedTitleRef = useRef<{ key: string; title: string } | null>(null);

  useEffect((): void => {
    if (!isVisible || !node || node.kind !== subagentKind) return;
    const previous = appliedTitleRef.current;
    if (previous?.key === titleBindingKey && previous.title === node.title) {
      return;
    }
    usePanelLayoutStore
      .getState()
      .updateTabInstanceTitle(scopeKey, panelId, node.title);
    appliedTitleRef.current = { key: titleBindingKey, title: node.title };
  }, [isVisible, node, panelId, scopeKey, subagentKind, titleBindingKey]);

  if (!isVisible) return <></>;
  if (treeQuery.hydrated && !treeQuery.rootChatOpen) {
    return <UnavailableSubagentChat />;
  }
  if (
    treeQuery.settled &&
    (!treeQuery.tree ||
      treeQuery.tree.root.id !== rootChatId ||
      !node ||
      node.kind !== subagentKind)
  ) {
    return <UnavailableSubagentChat />;
  }
  if (
    !treeQuery.tree ||
    treeQuery.tree.root.id !== rootChatId ||
    !node ||
    node.kind !== subagentKind
  ) {
    if (treeState.status === 'error') {
      const { error, onRetry } = treeState;
      return (
        <SubagentChatLoadError
          error={error}
          onRetry={
            onRetry &&
            ((): void => {
              setRetriedError(error);
              onRetry();
            })
          }
        />
      );
    }
    return retriedError === null ? (
      <LoadingSubagentChat />
    ) : (
      <SubagentChatLoadError
        error={retriedError}
        onRetry={RETRY_IN_PROGRESS}
        retrying
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-panel-active={isActive}>
      <DesktopSubagentChatContent
        scope={scope}
        rootChatId={rootChatId}
        node={node}
        tree={treeQuery.tree}
        rootMessages={rootChat.messages}
        managedEntry={
          node.kind === 'managed'
            ? treeQuery.managedEntries.get(node.id)
            : undefined
        }
        rootChatBusy={rootChat.status === 'streaming'}
        baseCapabilities={baseCapabilities}
      />
    </div>
  );
}
